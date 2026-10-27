/**
 * App 端接口 `/api/app/v1/*` —— 契约见 `clever-vpn-docs` `app-crm.md`（contract 13）
 *
 * 这是**唯一对终端用户开放**的接口面，**App 与品牌官网共用**（官网用 httpOnly Cookie）。
 *
 * 当前实现的端点：
 *   GET  /meta                 版本协商 + 能力位
 *   POST /auth/send-code       发验证码（非 production 直接回显 code，方便本地联调）
 *   POST /auth/verify          验证码换 session_token（不存在则建号；可选 referral_code）
 *   POST /auth/logout
 *   GET  /me                   用户 + 订阅快照 + 邀请面板
 *   GET  /subscription         订阅状态（status + reason + status_text）
 *   GET  /plans                可售套餐（免登录；每项只带一个 `action` + 促销展示位）
 *   GET  /payment-methods      可用支付方式（需登录）
 *   POST /quote                报价（唯一的应付金额来源；可带 promo_code）
 *   POST /orders               审计式创建一笔待支付订单（可带 promo_code / origin）
 *   GET  /orders               我的订单列表（官网收据用）
 *   GET  /orders/{order_code}  订单详情（App/官网轮询用）
 *
 * **这里没有一行价格/资格计算**：可买性与报价都来自 `src/plans/*` 的纯函数，
 * 促销折扣来自 `src/promotions/*`，同一个函数给后台预览用，保证"后台预览 == App 看到"。
 *
 * 未实现（下一步）：`/orders/iap`（Apple / Google 内购）。
 */

import { randomToken, sha256Hex } from "../admin/crypto";
import { consumeCode, issueCode } from "../admin/email-code";
import { emailCodeAvailable } from "../mail";
import { listLiveGateways, visibleMethods } from "../payments/gateways";
import { createCharge } from "../payments/checkout";
import { rowToPlan, planForClient } from "../plans/model";
import { quotePurchase } from "../plans/quote";
import { statusOf } from "../plans/subscription";
import { bindReferral, referralPanel } from "../promotions/referral";
import { redeemGiftCode } from "../promotions/redeem";
import { planPromos, resolveForPlans, resolvePromotion } from "../promotions/service";
import { customerSubscription } from "../subscriptions/store";
import { clientIp, turnstileEnabled, verifyTurnstile } from "../turnstile";

import type { Env } from "../env";
import type { Plan, PlanRow } from "../plans/model";
import type { CurrentSubscription } from "../plans/quote";
import type { Subscription } from "../plans/subscription";

const APP_CONTRACT = 19;
/** 报价有效期：超过这个时间，App 必须重新 `POST /quote`（契约 §2.4.8） */
const QUOTE_TTL_SECONDS = 900;
/**
 * 官网用的会话 Cookie。
 * App 走 `Authorization: Bearer`（原生安全存储），官网走 httpOnly Cookie——
 * **同一个 `session_token`，只是传输形态不同**（`app-crm.md` §2.2）。
 */
const SESSION_COOKIE = "cv_session";
const SESSION_COOKIE_MAX_AGE = 30 * 24 * 3600;
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

/** 从 `Authorization: Bearer` 取 token（App） */
function bearerToken(request: Request): string {
  const header = request.headers.get("Authorization") ?? "";
  return header.startsWith("Bearer ") ? header.slice(7).trim() : "";
}

/** 从 Cookie 取 token（官网） */
function cookieToken(request: Request): string {
  const raw = request.headers.get("Cookie") ?? "";
  for (const part of raw.split(";")) {
    const idx = part.indexOf("=");
    if (idx < 0) continue;
    if (part.slice(0, idx).trim() !== SESSION_COOKIE) continue;
    return decodeURIComponent(part.slice(idx + 1).trim());
  }
  return "";
}

/** 登录 / 登出时下发的 Set-Cookie；本地 http 不加 Secure（否则浏览器不存） */
function sessionCookie(env: Env, token: string | null): string {
  const secure = env.ENVIRONMENT === "production" ? "; Secure" : "";
  const base = `Path=/; HttpOnly; SameSite=Lax${secure}`;
  return token
    ? `${SESSION_COOKIE}=${encodeURIComponent(token)}; ${base}; Max-Age=${SESSION_COOKIE_MAX_AGE}`
    : `${SESSION_COOKIE}=; ${base}; Max-Age=0`;
}

async function resolveSession(env: Env, request: Request): Promise<CustomerRow | null> {
  // 先 Bearer（App），没有再看 Cookie（官网）；命中后走完全相同的校验
  const token = bearerToken(request) || cookieToken(request);
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

  // CSRF：靠 Cookie 认证时，写操作必须是同源或**白名单内的跨域**。
  //
  // Bearer 不会被浏览器自动附加，所以 App 天然免疫。登录（还没有 token）也是写操作：
  // 官网独立部署后要跨域发起 `/auth/send-code`，所以 `APP_ORIGINS` 里的 origin 必须放行
  // —— 它拿不到 Cookie（跨域响应的 Set-Cookie 会被浏览器丢掉），也就无从 CSRF。
  if (method !== "GET" && !bearerToken(request)) {
    const origin = request.headers.get("Origin");
    const sameOrigin = !origin || origin === url.origin;
    if (!sameOrigin && !allowedOrigins(env).includes(origin)) {
      return err(403, "forbidden", "跨站请求被拒绝");
    }
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
        // 促销两层（app-crm.md §2.9）：有这两个才渲染划线价/角标与邀请面板
        "promotions",
        "referral",
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

    // 邀请码：**选填、只在建号那一刻生效、永不报错**（app-crm.md §2.9.3）。
    // 失败也只是少一条归因，绝不能把注册挡下来。
    if (!existing) {
      await bindReferral(env, { customerId, code: body.referral_code }).catch(() => false);
    }

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
    const view = subscriptionView(sub);
    // 平台快照：**只有拿到 code 才算有**。provisioning 时 App 应显示"正在开通"（§2.6）
    const platform = sub?.code
      ? {
          token: sub.code,
          status: view.status,
          reason: view.reason,
          status_text: view.status_text,
          expires_at: sub.expires_at,
          licence_limit: sub.licence_limit,
        }
      : null;
    return json(
      {
        session_token: token,
        user: { id: customerId, email, name: existing?.display_name ?? null },
        platform,
        platform_status: sub ? (sub.code ? view.status : "provisioning") : "none",
      },
      200,
      // 官网直接拿到登录态；App 忽略这个头（它用 Bearer）
      { "Set-Cookie": sessionCookie(env, token) },
    );
  }

  // ── 退出 ──
  if (method === "POST" && path === "/auth/logout") {
    // Bearer 优先，其次 Cookie：两端都能登出
    const token = bearerToken(request) || cookieToken(request);
    if (token) {
      await env.DB.prepare(`UPDATE app_sessions SET revoked_at = ? WHERE id = ?`)
        .bind(new Date().toISOString(), await sha256Hex(token))
        .run();
    }
    return json({ ok: true }, 200, { "Set-Cookie": sessionCookie(env, null) });
  }

  // ── 套餐列表（免登录：商品与标价公开，动作与金额属于某个人）──
  if (method === "GET" && path === "/plans") {
    const viewer = await resolveSession(env, request);
    const plans = await loadActivePlans(env);
    const now = new Date();
    const ctx = viewer ? await currentContext(env, viewer.id) : { sub: null, current: null };
    // 促销展示位（§2.9.3，v19）：按**真实访客**算 —— 登录用户与 `/quote` 同源，
    // 匿名只按“该人群最优情形”算，并把条件写进角标前缀
    const promos = await planPromos(env, { plans, customerId: viewer?.id ?? null, now });
    const mine = viewer
      ? await resolveForPlans(env, { plans, customerId: viewer.id, now })
      : new Map<string, { discount_minor: number }>();

    const items = plans.map((plan) => {
      const base = planForClient(plan);
      const best = promos.get(plan.id);
      const promo = {
        // 划线价：就是套餐标价
        original_price_minor: plan.price_minor,
        // 活动价（满足活动条件时的价）：只给**宣传位**用，不代表这个人的应付
        promo_price_minor: best?.promo_price_minor ?? null,
        // null = 没有公开活动；文案由 CRM 给（含人群前缀），App 不拼
        promo_badge: best?.badge_label ?? null,
      };
      if (!viewer) {
        // 匿名：只有“所有人都能用”的活动才敢当报价报给游客；限人群的等登录
        const openToAll = best?.promotion.audience === "all";
        return {
          ...base,
          ...promo,
          payable_minor: openToAll ? (best?.promo_price_minor ?? null) : null,
          action: "login_required" as const,
          reason: "登录后购买",
          next_expires_at: null,
        };
      }
      const quote = quotePurchase(ctx.current, plan, now);
      const discount = mine.get(plan.id)?.discount_minor ?? 0;
      // 与 /quote 同一个公式：payable = max(0, promo(price) − residual)
      const payable = quote.allowed
        ? Math.max(0, plan.price_minor - discount - (quote.residual_minor ?? 0))
        : null;
      return {
        ...base,
        ...promo,
        // 列表只给"按标价买"的金额；升级的应付含残值，必须点开由 /quote 给
        payable_minor: quote.action === "upgrade" ? null : payable,
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
      // 邀请面板：官网与 App 共用（§2.9.3）。不需要邀请功能的客户端忽略即可
      referral: await referralPanel(env, customer.id),
    });
  }

  if (method === "GET" && path === "/subscription") {
    if (!customer) return err(401, "unauthorized");
    const sub = await customerSubscription(env, customer.id);
    return json(subscriptionView(sub));
  }

  // ── 兑换码（契约 §2.9.7）──
  //  业务性失败（码错 / 用完 / 冷却 / 没订阅）一律 200 + ok:false + reason，
  //  与 /quote 的 allowed:false 同口径；只有猜码过频才是 429。
  if (method === "POST" && path === "/redeem") {
    if (!customer) return err(401, "unauthorized");
    const body = await readBody(request);
    const result = await redeemGiftCode(env, {
      customerId: customer.id,
      code: typeof body.code === "string" ? body.code : "",
    });
    if (result.status === 429) {
      return json(result.body, 429, { "Retry-After": String(result.body.retry_after_s) });
    }
    return json(result.body);
  }

  // ── 我的订单（列表）──
  //    契约只规定了 `GET /orders/{order_code}`；列表是**只增不改**的补充，
  //    给官网"我的"页做收据用。只返回当前登录用户自己的订单，不接受任何 userId 入参。
  if (method === "GET" && path === "/orders") {
    if (!customer) return err(401, "unauthorized");
    const limit = Math.min(
      50,
      Math.max(1, Number(new URL(request.url).searchParams.get("pagination[limit]") ?? 20) || 20),
    );
    const rows = await env.DB.prepare(
      `SELECT code, plan_id, amount_minor, discount_minor, currency, status,
              created_at, paid_at
         FROM orders WHERE customer_id = ? ORDER BY id DESC LIMIT ?`,
    )
      .bind(customer.id, limit)
      .all<{
        code: string;
        plan_id: string;
        amount_minor: number;
        discount_minor: number;
        currency: string;
        status: string;
        created_at: string;
        paid_at: string | null;
      }>();
    return json({
      items: (rows.results ?? []).map((row) => ({
        order_code: row.code,
        plan_id: row.plan_id,
        amount_minor: row.amount_minor,
        discount_minor: row.discount_minor,
        currency: row.currency,
        status: row.status,
        created_at: row.created_at,
        paid_at: row.paid_at,
      })),
    });
  }

  // ── 订单详情（App/官网轮询用；契约 §2.4.1）──
  //    只能看**自己的**单：不做 order_code 全库查找，避免拿单号枚举别人的订单。
  const orderDetail = path.match(/^\/orders\/([A-Za-z0-9_-]{4,64})$/);
  if (method === "GET" && orderDetail) {
    if (!customer) return err(401, "unauthorized");
    const row = await env.DB.prepare(
      `SELECT code, status, amount_minor, discount_minor, currency, pay_url, expires_at,
              paid_at, created_at
         FROM orders WHERE code = ? AND customer_id = ?`,
    )
      .bind(orderDetail[1], customer.id)
      .first<{
        code: string;
        status: string;
        amount_minor: number;
        discount_minor: number;
        currency: string;
        pay_url: string | null;
        expires_at: string | null;
        paid_at: string | null;
        created_at: string;
      }>();
    if (!row) return err(404, "not_found", "订单不存在");

    // 已付款的订单顺带把订阅快照一起给，客户端少一次往返
    const settled = row.status !== "pending" && row.status !== "expired" && row.status !== "closed";
    const sub = settled ? await customerSubscription(env, customer.id) : null;
    return json({
      order_code: row.code,
      status: row.status,
      amount_minor: row.amount_minor,
      discount_minor: row.discount_minor,
      currency: row.currency,
      pay_url: row.pay_url,
      expires_at: row.expires_at,
      paid_at: row.paid_at,
      created_at: row.created_at,
      ...(settled ? { subscription: subscriptionView(sub) } : {}),
    });
  }

  // ── 报价：所有下单的唯一金额来源（契约 §2.4.8）──
  if (method === "POST" && path === "/quote") {
    if (!customer) return err(401, "unauthorized");
    const body = await readBody(request);
    const planId = typeof body.plan_id === "string" ? body.plan_id.trim() : "";
    if (!planId) return err(400, "invalid_request", "plan_id 必填");
    const plan = (await loadActivePlans(env)).find((p) => p.id === planId);
    if (!plan) return err(404, "not_found", "套餐不存在或已下架");

    // 码归一（大写）：响应里的 `applied_promotions[].code` 才是"实际用的那串"
    const promoCode = typeof body.promo_code === "string" ? body.promo_code.trim().toUpperCase() : "";
    const { sub, current } = await currentContext(env, customer.id);
    const now = new Date();
    const quote = quotePurchase(current, plan, now);
    const promo = await resolvePromotion(env, {
      plan,
      customerId: customer.id,
      code: promoCode || null,
      // 折扣只作用于**标价**：残值另算（不变量 1/2，promotion.md §4）
      subtotalMinor: plan.price_minor,
      now,
    });

    const base = {
      // 与 /plans[].action 同值域；登录态下不会出现 login_required
      action: quote.action,
      currency: plan.currency,
      price_minor: plan.price_minor,
      paid_minor: sub?.paid_minor ?? null,
      residual_minor: quote.residual_minor,
      expires_at: quote.expires_at,
      quoted_at: now.toISOString(),
      quote_ttl_s: QUOTE_TTL_SECONDS,
      // 促销明细（§2.9.3）：App 只渲染 `discount_label`，不自己拼文案
      discount_minor: promo.applied?.discount_minor ?? 0,
      discount_label: promo.applied?.label ?? null,
      applied_promotions: promo.applied
        ? [{ code: promoCode || null, label: promo.applied.promotion.name }]
        : [],
    };

    if (!quote.allowed) return json({ ...base, allowed: false, reason: quote.reason, payable_minor: null });
    // 用户**主动输入的码**不可用 ⇒ 明确拒绝。自动活动不适用则静默跳过（handler 里已过滤）
    if (promo.error) {
      return json({
        ...base,
        allowed: false,
        reason: promo.error,
        payable_minor: null,
        discount_minor: 0,
        discount_label: null,
        applied_promotions: [],
      });
    }

    const payable = Math.max(
      0,
      plan.price_minor - (promo.applied?.discount_minor ?? 0) - (quote.residual_minor ?? 0),
    );
    // 0 元单走不通任何网关：宁可在报价这一步就说清楚
    if (payable <= 0) {
      return json({ ...base, allowed: false, reason: "优惠已抵扣全部金额，请选择其他套餐", payable_minor: null });
    }
    return json({ ...base, allowed: true, reason: null, payable_minor: payable });
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

    // ── 促销：下单时**重新校验**（不信任 /quote 的旧结论），支付成功才核销 ──
    // 码归一（大写）：响应里的 `applied_promotions[].code` 才是"实际用的那串"
    const promoCode = typeof body.promo_code === "string" ? body.promo_code.trim().toUpperCase() : "";
    const entry = body.origin === "web" || body.origin === "app" ? body.origin : null;
    const promo = await resolvePromotion(env, {
      plan,
      customerId: customer.id,
      code: promoCode || null,
      subtotalMinor: plan.price_minor,
    });
    if (promo.error) return err(409, "promo_unavailable", promo.error);

    const payable = Math.max(
      0,
      plan.price_minor - (promo.applied?.discount_minor ?? 0) - (quote.residual_minor ?? 0),
    );
    if (payable <= 0) return err(409, "not_purchasable", "优惠已抵扣全部金额，请选择其他套餐");

    // 报价过期 / 改价：差额 ≤1 分忽略（舍入），超出就让 App 重新报价
    const expected = typeof body.expected_payable_minor === "number" ? body.expected_payable_minor : null;
    if (expected !== null && Math.abs(expected - payable) > 1) {
      return err(409, "price_changed", "价格已变化，请重新确认后再支付");
    }

    const result = await createCharge(env, {
      customerId: customer.id,
      customerEmail: customer.email,
      plan,
      method: paymentMethod,
      // 促销后应付（升级已含残值抵扣）。折扣与残值都只影响这一次收款
      amountMinor: payable,
      discountMinor: promo.applied?.discount_minor ?? 0,
      promotionId: promo.applied?.promotion.id ?? null,
      codeId: promo.codeId,
      entry,
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

