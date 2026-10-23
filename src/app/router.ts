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

import { randomToken, sha256Hex, timingSafeEqual } from "../admin/crypto";
import { rowToPlan, planForClient } from "../plans/model";
import { quotePurchase } from "../plans/quote";
import { currentMainSubscription } from "../subscriptions/store";

import type { Env } from "../env";
import type { Plan, PlanRow } from "../plans/model";
import type { CurrentSubscription } from "../plans/quote";
import type { Subscription } from "../plans/subscription";

const APP_CONTRACT = 10;
const CODE_TTL_MS = 10 * 60 * 1000;
const CODE_COOLDOWN_MS = 60 * 1000;
const CODE_MAX_ATTEMPTS = 5;
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

/** 非 production 才回显验证码（与 cf-api / cf-dashboard 同一做法） */
function isDev(env: Env): boolean {
  return (env.ENVIRONMENT ?? "development") !== "production";
}

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

function generateCode(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(4));
  const n = ((bytes[0]! << 24) >>> 0) + (bytes[1]! << 16) + (bytes[2]! << 8) + bytes[3]!;
  return String(n % 1_000_000).padStart(6, "0");
}

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
       store_product_id, sort_order, status, supersedes_id, retired_at
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
      features: ["passwordless", "plan_kinds", "upgrade_quote"],
      min_app: "2.0.0",
    });
  }

  // ── 发验证码 ──
  if (method === "POST" && path === "/auth/send-code") {
    const body = await readBody(request);
    const email = normalizeEmail(body.email);
    if (!EMAIL_RE.test(email)) return err(400, "invalid_request", "邮箱格式不对");

    const now = Date.now();
    const existing = await env.DB.prepare(
      `SELECT sent_at FROM email_codes WHERE email = ?`,
    ).bind(email).first<{ sent_at: string }>();
    if (existing && now - Date.parse(existing.sent_at) < CODE_COOLDOWN_MS) {
      return json({ ok: true, cooldown: 60 }); // 恒定响应，不泄露是否已发过
    }

    const code = generateCode();
    const nowIso = new Date(now).toISOString();
    await env.DB.prepare(
      `INSERT INTO email_codes (email, code_hash, purpose, sent_at, expires_at, attempts)
       VALUES (?, ?, 'login', ?, ?, 0)
       ON CONFLICT(email) DO UPDATE SET
         code_hash = excluded.code_hash, sent_at = excluded.sent_at,
         expires_at = excluded.expires_at, attempts = 0`,
    )
      .bind(email, await sha256Hex(`${email}:${code}`), nowIso, new Date(now + CODE_TTL_MS).toISOString())
      .run();

    // 本地/开发环境：不发信，把码打到日志并回显（cf-api 的做法）
    if (isDev(env)) {
      console.log(`[send-code] ${email} => ${code}`);
      return json({ ok: true, cooldown: 60, code, dev: true });
    }
    if (!env.EMAIL) return err(503, "email_unavailable", "邮件服务未配置");
    await sendCodeEmail(env, email, code).catch((e: unknown) => {
      console.error("[send-code] 发送失败", e);
    });
    return json({ ok: true, cooldown: 60 });
  }

  // ── 验证码换 session ──
  if (method === "POST" && path === "/auth/verify") {
    const body = await readBody(request);
    const email = normalizeEmail(body.email);
    const code = typeof body.code === "string" ? body.code.trim() : "";
    if (!EMAIL_RE.test(email) || !/^\d{6}$/.test(code)) return err(400, "invalid_request");

    const row = await env.DB.prepare(
      `SELECT code_hash, expires_at, attempts FROM email_codes WHERE email = ?`,
    ).bind(email).first<{ code_hash: string; expires_at: string; attempts: number }>();
    if (!row) return err(400, "invalid_code", "验证码不对或已过期");
    if (Date.parse(row.expires_at) <= Date.now() || row.attempts >= CODE_MAX_ATTEMPTS) {
      return err(400, "invalid_code", "验证码不对或已过期");
    }

    const expected = await sha256Hex(`${email}:${code}`);
    if (!timingSafeEqual(expected, row.code_hash)) {
      await env.DB.prepare(`UPDATE email_codes SET attempts = attempts + 1 WHERE email = ?`)
        .bind(email).run();
      return err(400, "invalid_code", "验证码不对或已过期");
    }

    // 一次性
    await env.DB.prepare(`DELETE FROM email_codes WHERE email = ?`).bind(email).run();

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

async function sendCodeEmail(env: Env, email: string, code: string): Promise<void> {
  const from = env.EMAIL_FROM ?? "noreply@example.com";
  await env.EMAIL!.send({
    to: email,
    from: { email: from, name: "Clever VPN" },
    subject: `验证码: ${code}`,
    text: `您的验证码是 ${code}，10 分钟内有效。`,
    html: `<p>您的验证码是 <b style="font-size:24px;letter-spacing:6px">${code}</b></p>
           <p>10 分钟内有效。</p>`,
  });
}
