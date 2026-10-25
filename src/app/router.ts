/**
 * App 端接口 `/api/app/v1/*` —— 契约见 `clever-vpn-docs` `app-crm.md`（contract 12）
 *
 * 这是**唯一对终端用户开放**的接口面，**App 与品牌官网共用**（官网用 httpOnly Cookie）。
 *
 * 当前实现的是**能本地跑通购买前链路**的最小集：
 *   GET  /meta                 版本协商 + 能力位
 *   POST /auth/send-code       发验证码（非 production 直接回显 code，方便本地联调）
 *   POST /auth/verify          验证码换 session_token（不存在则建号）
 *   POST /auth/logout
 *   GET  /me                   用户 + 订阅快照
 *   GET  /subscription         订阅状态（status + reason + status_text）
 *   GET  /plans                可售套餐（免登录；每项只带一个 `action`）
 *   GET  /payment-methods      可用支付方式（需登录）
 *   POST /quote                报价（唯一的应付金额来源）
 *   POST /orders               审计式创建一笔待支付订单
 *
 * **这里没有一行价格/资格计算**：可买性与报价都来自 `src/plans/*` 的纯函数，
 * 同一个函数给后台预览用，保证"后台预览 == App 看到"。
 *
 * 未实现（下一步）：支付回调、`/orders/iap`、取码与 cf-api 落账。
 */

import { randomToken, sha256Hex } from "../admin/crypto";
import { consumeCode, issueCode } from "../admin/email-code";
import { emailCodeAvailable } from "../mail";
import { listLiveGateways, visibleMethods } from "../payments/gateways";
import { createCharge } from "../payments/checkout";
import { rowToPlan, planForClient } from "../plans/model";
import { quotePurchase } from "../plans/quote";
import { statusOf } from "../plans/subscription";
import { customerSubscription } from "../subscriptions/store";
import { clientIp, turnstileEnabled, verifyTurnstile } from "../turnstile";

import type { Env } from "../env";
import type { Plan, PlanRow } from "../plans/model";
import type { CurrentSubscription } from "../plans/quote";
import type { Subscription } from "../plans/subscription";

const APP_CONTRACT = 12;
/** 报价有效期：超过这个时间，App 必须重新 `POST /quote`（契约 §2.4.8） */
const QUOTE_TTL_SECONDS = 900;
/** 会话不做硬过期（契约 §2.6），这里只在活跃度上留痕 */
const SESSION_TOUCH_MS = 5 * 60 * 1000;

/** 用户能看懂的支付方式名（聚合商/网关名字永远不出现，`docs/payments.md` §1.1） */
const PAY_METHOD_LABEL: Record<string, string> = {
  alipay: "支付宝",
  wechat: "微信支付",
  paypal: "PayPal",
  stripe: "银行卡",
  transfer: "银行转账",
};

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
       traffic_gb, validity_days, line_ids, up_mbps, down_mbps, sales_channels,
       store_product_id, sort_order, status, retired_at
     -- 只卖"公开"的套餐：hidden（礼品包之类，0 元）只能由后台赠送，
     -- 绝不能出现在 App 列表里，也不能被 POST /orders 直接点出来。
     FROM plans WHERE status = 'active' AND visibility = 'public'
     ORDER BY sort_order, created_at`,
  ).all<PlanRow>();
  return (rows.results ?? []).map(rowToPlan);
}

/** 当前套餐的**目录标价** —— 只用于比“谁更贵”；下架（retired）的套餐也得读得到 */
async function planListPrice(env: Env, planId: string): Promise<number> {
  const row = await env.DB.prepare(`SELECT price_minor FROM plans WHERE id = ?`)
    .bind(planId)
    .first<{ price_minor: number }>();
  return row?.price_minor ?? 0;
}

function toQuoteInput(sub: Subscription, listPriceMinor: number): CurrentSubscription {
  return {
    plan_id: sub.plan_id,
    kind: sub.kind === "traffic" ? "traffic" : "period",
    list_price_minor: listPriceMinor,
    paid_minor: sub.paid_minor,
    term_days: sub.term_days,
    traffic_gb: sub.traffic_total_gb,
    expires_at: sub.expires_at,
    remaining_gb: sub.remaining_gb,
    unlimited: sub.quota_gb === null && sub.kind === "period",
  };
}

/** 当前订阅 + 它的标价；两者要么都有，要么都没有 */
async function currentContext(
  env: Env,
  customerId: number,
): Promise<{ sub: Subscription | null; current: CurrentSubscription | null }> {
  const sub = await customerSubscription(env, customerId);
  if (!sub) return { sub: null, current: null };
  return { sub, current: toQuoteInput(sub, await planListPrice(env, sub.plan_id)) };
}

function subscriptionView(sub: Subscription | null): Record<string, unknown> {
  if (!sub) return { status: "none", reason: null, status_text: "还没有订阅" };
  const unlimited = sub.kind === "period" && sub.quota_gb === null;
  const base = {
    kind: sub.kind,
    plan_id: sub.plan_id,
    expires_at: sub.expires_at,
    licence_limit: sub.licence_limit,
    unlimited,
    // traffic 用同步过来的余量；period 由结算任务维护
    remaining_gb: unlimited ? null : sub.kind === "traffic" ? sub.remaining_gb : sub.quota_gb,
    line_ids: sub.line_ids,
  };

  // 已付款但 cf-api 还没建好客户 ⇒ 还没有码。App 应显示"正在开通"而不是"无订阅"
  if (!sub.code) {
    return {
      status: "provisioning",
      reason: null,
      status_text: "正在开通，通常 1 分钟内完成",
      ...base,
    };
  }

  const state = statusOf(sub);
  return {
    status: state.status,
    // 不能用的原因只有三种：到期 / 用完 / 冻结（撤销、退款也归 frozen）
    reason: state.reason,
    // 用户可见文案的唯一来源，App 不拼文案
    status_text: state.status_text,
    ...base,
    // 激活码只给 App 自己用：不展示、不写日志（app-crm.md §2.3）
    code: sub.code,
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

    const sub = await customerSubscription(env, customerId);
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

  // ── 套餐列表（免登录：商品与标价公开，动作与金额属于某个人）──
  if (method === "GET" && path === "/plans") {
    const viewer = await resolveSession(env, request);
    const plans = await loadActivePlans(env);
    const now = new Date();
    const ctx = viewer ? await currentContext(env, viewer.id) : { sub: null, current: null };

    const items = plans.map((plan) => {
      const base = planForClient(plan);
      if (!viewer) {
        // 匿名：能看商品与标价，不给可购买性与应付
        return {
          ...base,
          payable_minor: null,
          action: "login_required" as const,
          reason: "登录后购买",
          next_expires_at: null,
        };
      }
      const quote = quotePurchase(ctx.current, plan, now);
      return {
        ...base,
        // 列表只给"按标价买"的金额；升级的应付含残值，必须点开由 /quote 给
        payable_minor: quote.action === "upgrade" ? null : quote.payable_minor,
        // App 不做任何判断：按 action 渲染 购买 / 续订 / 升级 按钮
        action: quote.action,
        reason: quote.reason,
        // 只有续订给“续订后有效期至…”，升级的到期日由 /quote 给
        next_expires_at: quote.action === "renewal" ? quote.expires_at : null,
      };
    });
    return json(items);
  }

  // ── 以下需要登录 ──
  const customer = await resolveSession(env, request);

  if (method === "GET" && path === "/me") {
    if (!customer) return err(401, "unauthorized");
    const sub = await customerSubscription(env, customer.id);
    return json({
      user: { id: customer.id, email: customer.email, name: customer.display_name },
      subscription: subscriptionView(sub),
    });
  }

  if (method === "GET" && path === "/subscription") {
    if (!customer) return err(401, "unauthorized");
    const sub = await customerSubscription(env, customer.id);
    return json(subscriptionView(sub));
  }

  // ── 报价：所有下单的唯一金额来源（契约 §2.4.8）──
  if (method === "POST" && path === "/quote") {
    if (!customer) return err(401, "unauthorized");
    const body = await readBody(request);
    const planId = typeof body.plan_id === "string" ? body.plan_id.trim() : "";
    if (!planId) return err(400, "invalid_request", "plan_id 必填");
    const plan = (await loadActivePlans(env)).find((p) => p.id === planId);
    if (!plan) return err(404, "not_found", "套餐不存在或已下架");

    const { sub, current } = await currentContext(env, customer.id);
    const now = new Date();
    const quote = quotePurchase(current, plan, now);
    return json({
      // 与 /plans[].action 同值域；登录态下不会出现 login_required
      action: quote.action,
      allowed: quote.allowed,
      reason: quote.reason,
      currency: plan.currency,
      price_minor: plan.price_minor,
      paid_minor: sub?.paid_minor ?? null,
      residual_minor: quote.residual_minor,
      payable_minor: quote.payable_minor,
      expires_at: quote.expires_at,
      quoted_at: now.toISOString(),
      quote_ttl_s: QUOTE_TTL_SECONDS,
    });
  }

  // ── 可用的支付方式（受网关闸门约束：status / methods / 白名单 / 环境开关）──
  //    白名单按用户算，所以必须登录（契约 §2.2）
  if (method === "GET" && path === "/payment-methods") {
    if (!customer) return err(401, "unauthorized");
    const items: { id: string; label: string; channel: string }[] = [];
    const seen = new Set<string>();
    for (const gw of await listLiveGateways(env)) {
      for (const m of visibleMethods(gw, customer.email, env)) {
        if (seen.has(m)) continue;
        seen.add(m);
        items.push({ id: m, label: PAY_METHOD_LABEL[m] ?? m, channel: "web_checkout" });
      }
    }
    return json(items);
  }

  // ── 下单：一次支付尝试（见 docs/payments.md §2）──
  if (method === "POST" && path === "/orders") {
    if (!customer) return err(401, "unauthorized");
    const body = await readBody(request);
    const planId = typeof body.plan_id === "string" ? body.plan_id.trim() : "";
    const paymentMethod = typeof body.payment_method === "string" ? body.payment_method.trim() : "";
    if (!planId || !paymentMethod) return err(400, "invalid_request", "plan_id 与 payment_method 必填");

    const plan = (await loadActivePlans(env)).find((p) => p.id === planId);
    if (!plan) return err(404, "not_found", "套餐不存在或已下架");

    // 可买性用**同一个纯函数**（与 /plans、后台预览、报价一致）
    const { current } = await currentContext(env, customer.id);
    const quote = quotePurchase(current, plan);
    if (!quote.allowed) return err(409, "not_purchasable", quote.reason ?? "当前不可购买");

    // 报价过期 / 改价：差额 ≤1 分忽略（舍入），超出就让 App 重新报价
    const expected = typeof body.expected_payable_minor === "number" ? body.expected_payable_minor : null;
    if (expected !== null && Math.abs(expected - (quote.payable_minor ?? 0)) > 1) {
      return err(409, "price_changed", "价格已变化，请重新确认后再支付");
    }

    const result = await createCharge(env, {
      customerId: customer.id,
      customerEmail: customer.email,
      plan,
      method: paymentMethod,
      // 升级按"新价 − 残值"收钱；新购/续订就是目录价
      amountMinor: quote.payable_minor ?? plan.price_minor,
      origin: new URL(request.url).origin,
      clientIp: clientIp(request),
    });
    if (!result.ok) return err(result.status, result.code, result.message);

    return json(
      {
        order_code: result.orderCode,
        pay_url: result.payUrl,
        amount_minor: result.amountMinor,
        currency: result.currency,
        expires_at: result.expiresAt,
        reused: result.reused,
      },
      201,
    );
  }

  return err(404, "not_found", `未知接口：${method} ${path}`);
}

