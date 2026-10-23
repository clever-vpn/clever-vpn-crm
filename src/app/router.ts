/**
 * App 端接口 `/api/app/v1/*` —— 契约见 `clever-vpn-docs` `app-crm.md`（contract 10）
 *
 * 当前实现的是**能本地跑通购买前链路**的最小集：
 *   GET  /meta                 版本协商 + 能力位
 *   POST /auth/send-code       发验证码（非 production 直接回显 code，方便本地联调）
 *   POST /auth/verify          验证码换 session_token（不存在则建号）
 *   POST /auth/logout
 *   GET  /me                   用户 + 订阅快照
 *   GET  /subscription         订阅状态
 *   GET  /plans                可售套餐（带 `purchasable` / `reason`）
 *   POST /upgrade/quote        换购报价（残值换购）
 *
 * **这里没有一行价格/资格计算**：可买性与报价都来自 `src/plans/*` 的纯函数，
 * 同一个函数给后台预览用，保证"后台预览 == App 看到"。
 *
 * 未实现（下一步）：下单 `/orders`、支付回调、`/orders/iap`、取码与 cf-api 落账。
 */

import { randomToken, sha256Hex } from "../admin/crypto";
import { consumeCode, issueCode } from "../admin/email-code";
import { emailCodeAvailable } from "../mail";
import { rowToPlan, planForClient } from "../plans/model";
import { quotePurchase } from "../plans/quote";
import { currentMainSubscription } from "../subscriptions/store";
import { clientIp, turnstileEnabled, verifyTurnstile } from "../turnstile";

import type { Env } from "../env";
import type { Plan, PlanRow } from "../plans/model";
import type { CurrentSubscription } from "../plans/quote";
import type { Subscription } from "../plans/subscription";

const APP_CONTRACT = 10;
/** 会话不做硬过期（契约 §2.6），这里只在活跃度上留痕 */
const SESSION_TOUCH_MS = 5 * 60 * 1000;

function json(body: unknown, status = 200, extra?: HeadersInit): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8", ...extra },
  });
}

const err = (status: number, code: string, message?: string): Response =>
  json({ error: { code, ...(message ? { message } : {}) } }, status);

// ---- CORS（契约 §3）----

function allowedOrigins(env: Env): string[] {
  return (env.APP_ORIGINS ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

function corsHeaders(env: Env, request: Request): Record<string, string> {
  const origin = request.headers.get("Origin");
  if (!origin) return {};
  const allowed = allowedOrigins(env);
  // 白名单为空 ⇒ 不下发 CORS 头（同源部署用不到）
  if (!allowed.includes(origin)) return {};
  return {
    "Access-Control-Allow-Origin": origin,
    "Access-Control-Allow-Headers": "authorization, content-type, idempotency-key, x-crm-request",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Max-Age": "600",
    Vary: "Origin",
  };
}

// ---- 小工具 ----

async function readBody(request: Request): Promise<Record<string, unknown>> {
  const body = await request.json().catch(() => null);
  return body && typeof body === "object" ? (body as Record<string, unknown>) : {};
}

/** 邮箱归一：小写 + 去空格（验证码按归一后的地址存，晚一步就查不到） */
function normalizeEmail(raw: unknown): string {
  return typeof raw === "string" ? raw.trim().toLowerCase() : "";
}

const EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;

interface CustomerRow {
  id: number;
  email: string;
  display_name: string | null;
  status: string;
}

async function findCustomer(env: Env, email: string): Promise<CustomerRow | null> {
  return env.DB.prepare(`SELECT id, email, display_name, status FROM customers WHERE email = ?`)
    .bind(email)
    .first<CustomerRow>();
}

async function createCustomer(env: Env, email: string): Promise<number> {
  const res = await env.DB.prepare(
    `INSERT INTO customers (email, status, created_at) VALUES (?, 'active', ?)`,
  )
    .bind(email, new Date().toISOString())
    .run();
  return Number(res.meta.last_row_id ?? 0);
}

interface SessionRow {
  id: string;
  customer_id: number;
}

async function resolveSession(env: Env, request: Request): Promise<CustomerRow | null> {
  const header = request.headers.get("Authorization") ?? "";
  const token = header.startsWith("Bearer ") ? header.slice(7).trim() : "";
  if (!token) return null;
  const id = await sha256Hex(token);
  const session = await env.DB.prepare(
    `SELECT id, customer_id FROM app_sessions WHERE id = ? AND revoked_at IS NULL`,
  )
    .bind(id)
    .first<SessionRow>();
  if (!session) return null;

  const now = new Date();
  await env.DB.prepare(`UPDATE app_sessions SET last_used_at = ? WHERE id = ? AND last_used_at < ?`)
    .bind(now.toISOString(), id, new Date(now.getTime() - SESSION_TOUCH_MS).toISOString())
    .run();

  return env.DB.prepare(`SELECT id, email, display_name, status FROM customers WHERE id = ?`)
    .bind(session.customer_id)
    .first<CustomerRow>();
}

// ---- 订阅快照 → 报价输入 ----

async function loadActivePlans(env: Env): Promise<Plan[]> {
  const rows = await env.DB.prepare(
    `SELECT id, name, kind, price_minor, currency, licence_limit, term_days, monthly_quota_gb,
       traffic_gb, validity_days, allow_addons, line_ids, up_mbps, down_mbps, channels,
       store_product_id, sort_order, status, retired_at
     FROM plans WHERE status = 'active' ORDER BY sort_order, created_at`,
  ).all<PlanRow>();
  return (rows.results ?? []).map(rowToPlan);
}

function toQuoteInput(sub: Subscription): CurrentSubscription {
  return {
    plan_id: sub.plan_id,
    kind: sub.kind === "traffic" ? "traffic" : "period",
    paid_minor: sub.paid_minor,
    term_days: sub.term_days,
    traffic_gb: sub.traffic_total_gb,
    expires_at: sub.expires_at,
    remaining_gb: sub.remaining_gb,
    unlimited: sub.quota_gb === null && sub.kind === "period",
    allow_addons: sub.allow_addons,
  };
}

function subscriptionView(sub: Subscription | null): Record<string, unknown> {
  if (!sub) return { status: "none" };
  const now = Date.now();
  const expired = sub.expires_at !== null && Date.parse(sub.expires_at) <= now;
  const unlimited = sub.kind === "period" && sub.quota_gb === null;
  return {
    status: expired ? "expired" : "active",
    kind: sub.kind,
    plan_id: sub.plan_id,
    expires_at: sub.expires_at,
    licence_limit: sub.licence_limit,
    unlimited,
    // traffic 用同步过来的余量；period 由结算任务维护
    remaining_gb: unlimited ? null : sub.kind === "traffic" ? sub.remaining_gb : sub.quota_gb,
    line_ids: sub.line_ids,
  };
}

// ---- 主入口 ----

export async function handleAppApi(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  const path = url.pathname.replace(/^\/api\/app\/v1/, "") || "/";
  const method = request.method;
  const cors = corsHeaders(env, request);

  // 预检：免鉴权、直接 204
  if (method === "OPTIONS") {
    return new Response(null, { status: 204, headers: cors });
  }

  const withCors = (res: Response): Response => {
    for (const [k, v] of Object.entries(cors)) res.headers.set(k, v);
    return res;
  };

  return withCors(await route(request, env, path, method));
}

async function route(request: Request, env: Env, path: string, method: string): Promise<Response> {
  // ── 元信息（免登录）──
  if (method === "GET" && path === "/meta") {
    return json({
      app_contract: APP_CONTRACT,
      crm_version: env.CRM_CODE_VERSION ?? "dev",
      currency: "CNY",
      // email_code = 这台 CRM 能不能发验证码（开发环境恒为 true，因为直接回显）
      features: [
        ...(emailCodeAvailable(env) ? ["passwordless", "email_code"] : []),
        "plan_kinds",
        "upgrade_quote",
      ],
      min_app: "2.0.0",
      // 有 site key 才渲染 Turnstile 挂件；App 发码时要带上 turnstile_token
      turnstile_site_key: turnstileEnabled(env) ? (env.TURNSTILE_SITE_KEY ?? null) : null,
    });
  }

  // ── 发验证码 ──
  if (method === "POST" && path === "/auth/send-code") {
    const body = await readBody(request);
    const email = normalizeEmail(body.email);
    if (!EMAIL_RE.test(email)) return err(400, "invalid_request", "邮箱格式不对");

    // 没配邮件 = App 根本不能登录，必须明确报出来（而不是 500 / 静默）
    if (!emailCodeAvailable(env)) {
      return err(503, "email_unavailable", "服务端未配置邮件发送，暂不可注册/登录");
    }

    // 发码是最贵的公开入口（真花钱），配了 secret 就一定要过人机校验
    if (turnstileEnabled(env)) {
      const check = await verifyTurnstile(
        env,
        typeof body.turnstile_token === "string" ? body.turnstile_token : "",
        clientIp(request),
      );
      if (!check.ok) return err(400, "turnstile_failed", "人机校验未通过，请重试");
    }

    const issued = await issueCode(env, email, "login");
    if (!issued.ok) return err(502, "email_send_failed", "验证码发送失败，请稍后再试");
    // 恒定响应：冷却中/已发送都是同一句话
    return json({ ok: true, cooldown: 60, ...(issued.code ? { code: issued.code, dev: true } : {}) });
  }

  // ── 验证码换 session ──
  if (method === "POST" && path === "/auth/verify") {
    const body = await readBody(request);
    const email = normalizeEmail(body.email);
    const code = typeof body.code === "string" ? body.code.trim() : "";
    if (!EMAIL_RE.test(email) || !/^\d{6}$/.test(code)) return err(400, "invalid_request");

    if (!(await consumeCode(env, email, "login", code))) {
      return err(400, "invalid_code", "验证码不对或已过期");
    }

    const existing = await findCustomer(env, email);
    const customerId = existing?.id ?? (await createCustomer(env, email));

    const token = randomToken();
    const nowIso = new Date().toISOString();
    await env.DB.prepare(
      `INSERT INTO app_sessions (id, customer_id, created_at, last_used_at, app_id, ip, user_agent)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    )
      .bind(
        await sha256Hex(token),
        customerId,
        nowIso,
        nowIso,
        typeof body.appId === "string" ? body.appId : null,
        request.headers.get("CF-Connecting-IP"),
        request.headers.get("User-Agent"),
      )
      .run();

    const sub = await currentMainSubscription(env, customerId);
    return json({
      session_token: token,
      user: { id: customerId, email, name: existing?.display_name ?? null },
      // 尚未接 cf-api 落账：没有平台快照
      platform: null,
      platform_status: sub ? "provisioning" : "none",
    });
  }

  // ── 退出 ──
  if (method === "POST" && path === "/auth/logout") {
    const header = request.headers.get("Authorization") ?? "";
    const token = header.startsWith("Bearer ") ? header.slice(7).trim() : "";
    if (token) {
      await env.DB.prepare(`UPDATE app_sessions SET revoked_at = ? WHERE id = ?`)
        .bind(new Date().toISOString(), await sha256Hex(token))
        .run();
    }
    return json({ ok: true });
  }

  // ── 套餐列表（免登录；带 session 时可算出可买性）──
  if (method === "GET" && path === "/plans") {
    const customer = await resolveSession(env, request);
    const current = customer ? await currentMainSubscription(env, customer.id) : null;
    const plans = await loadActivePlans(env);
    const now = new Date();

    const items = plans.map((plan) => {
      const quote = quotePurchase(current ? toQuoteInput(current) : null, plan, now);
      return {
        ...planForClient(plan),
        purchasable: quote.allowed,
        reason: quote.reason,
      };
    });
    return json(items);
  }

  // ── 以下需要登录 ──
  const customer = await resolveSession(env, request);

  if (method === "GET" && path === "/me") {
    if (!customer) return err(401, "unauthorized");
    const sub = await currentMainSubscription(env, customer.id);
    return json({
      user: { id: customer.id, email: customer.email, name: customer.display_name },
      subscription: subscriptionView(sub),
    });
  }

  if (method === "GET" && path === "/subscription") {
    if (!customer) return err(401, "unauthorized");
    const sub = await currentMainSubscription(env, customer.id);
    return json(subscriptionView(sub));
  }

  if (method === "POST" && path === "/upgrade/quote") {
    if (!customer) return err(401, "unauthorized");
    const body = await readBody(request);
    const toPlanId = typeof body.to_plan_id === "string" ? body.to_plan_id.trim() : "";
    const plan = (await loadActivePlans(env)).find((p) => p.id === toPlanId);
    if (!plan) return err(404, "not_found", "套餐不存在或已下架");

    const sub = await currentMainSubscription(env, customer.id);
    const quote = quotePurchase(sub ? toQuoteInput(sub) : null, plan);
    return json({
      allowed: quote.allowed,
      reason: quote.reason,
      settlement: quote.settlement,
      currency: plan.currency,
      from: sub ? { plan_id: sub.plan_id, kind: sub.kind } : null,
      to: { plan_id: plan.id, kind: plan.kind },
      paid_minor: sub?.paid_minor ?? null,
      residual_minor: quote.residual_minor,
      payable_minor: quote.payable_minor,
      expires_at: quote.expires_at,
    });
  }

  return err(404, "not_found", `未知接口：${method} ${path}`);
}

