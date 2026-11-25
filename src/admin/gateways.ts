/**
 * 管理后台：支付网关 `/api/admin/gateways*`
 *
 * 这里是**唯一能创建网关的地方**。三条硬规则写在这里，不靠前端自觉：
 *
 *   1. `driver` 决定它**能卖哪些方式**（`DRIVER_METHODS`）—— 不允许 "stripe + 支付宝"
 *      这种配置，否则显示名与真实能力会打架；
 *   2. 密钥只能通过 `secret`（明文，进来就加密）写入；列表/详情只回 `has_secret`，
 *      租户可通过显式 `GET /gateways/:id/secret` 查看当前值（审计，不写日志）；
 *   3. `mock` 的两道闸门在发布时校验：环境开关必须打开，白名单必须非空。
 *
 * `epay_v1` 的 `mapping` 是**覆盖项**（与内置映射深合并），租户只写差异；
 * `generic_json_v1` 的 `mapping` 是**完整配置**（必须能通过 `validateMapping`）。
 */

import { createCharge } from "../payments/checkout";
import { decryptSecret, encryptSecret, secretKeyConfigured } from "../payments/secret";
import { DRIVERS, validateMapping, type GatewayMapping } from "../payments/mapping";
import { EPAY_V1_MAPPING } from "../payments/builtin/epay";
import { isMockEnabled } from "../payments/gateways";
import { aiReady } from "../payments/ai";
import { pollOrderOnce } from "../payments/poll";
import { MOCK_DRIVER } from "../payments/mock";

import type { Env } from "../env";
import type { GatewayRow } from "../payments/gateways";

const GATEWAY_STATUSES = ["draft", "live", "disabled", "deleted"] as const;

/**
 * 后台可配置的驱动 = 真实驱动 + `mock`。
 * `mock` 不在 `DRIVERS` 里（它不参与真实下单映射校验），但租户做联调时必须在后台能看到它，
 * 所以这里单独并进来；能不能真正发布由 `ALLOW_MOCK_PAYMENTS` + 白名单把关。
 */
const ADMIN_DRIVERS = [...DRIVERS, MOCK_DRIVER];

/** 每种 driver 能卖的方式 —— 这就是"品牌即方式"的落地 */
const DRIVER_METHODS: Record<string, readonly string[]> = {
  epay_v1: ["alipay", "wechat"],
  epay_v2: ["alipay", "wechat"],
  generic_json_v1: ["alipay", "wechat"],
  mock: ["alipay", "wechat"],
  stripe: ["stripe"],
  paypal: ["paypal"],
  manual: ["transfer"],
};

const ALL_METHODS = ["alipay", "wechat", "stripe", "paypal", "transfer"] as const;

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8" },
  });
}

const fail = (status: number, error: string, message?: string): Response =>
  json(message ? { error, message } : { error }, status);

async function readBody(request: Request): Promise<Record<string, unknown>> {
  const body = await request.json().catch(() => null);
  return body && typeof body === "object" ? (body as Record<string, unknown>) : {};
}

async function audit(env: Env, actor: string, action: string, target: string, detail?: unknown): Promise<void> {
  await env.DB.prepare(
    `INSERT INTO audit_log (at, actor, action, target, detail) VALUES (?, ?, ?, ?, ?)`,
  )
    .bind(new Date().toISOString(), actor, action, target, detail === undefined ? null : JSON.stringify(detail))
    .run();
}

function parseArray(raw: string | null): string[] {
  if (!raw) return [];
  try {
    const v = JSON.parse(raw) as unknown;
    return Array.isArray(v) ? v.map((x) => String(x)) : [];
  } catch {
    return [];
  }
}

/** 对外视图：不含密钥；需要查看时走显式的 `/gateways/:id/secret` */
function view(row: GatewayRow): Record<string, unknown> {
  let mapping: unknown = null;
  if (row.mapping) {
    try {
      mapping = JSON.parse(row.mapping) as unknown;
    } catch {
      mapping = null;
    }
  }
  return {
    id: row.id,
    driver: row.driver,
    name: row.name,
    endpoint: row.endpoint,
    merchant_id: row.merchant_id,
    has_secret: !!row.secret_enc,
    has_webhook: !!row.webhook_enc,
    methods: parseArray(row.methods),
    channel_codes: row.channel_codes ? JSON.parse(row.channel_codes) : {},
    mapping,
    priority: row.priority,
    status: row.status,
    currency: row.currency,
    fx_rate: row.fx_rate,
    test_amount_minor: row.test_amount_minor,
    test_create_ok_at: row.test_create_ok_at,
    test_query_ok_at: row.test_query_ok_at,
    test_callback_ok_at: row.test_callback_ok_at,
    test_require_callback: Boolean(row.test_require_callback),
    tested_config_hash: row.tested_config_hash,
    test_ready: Boolean(row.test_create_ok_at && row.test_query_ok_at),
    allowed_emails: parseArray(row.allowed_emails),
    last_test_order_id: row.last_test_order_id,
    last_ok_at: row.last_ok_at,
    last_error: row.last_error,
  };
}

function deepMerge<T>(base: T, patch: unknown): T {
  if (!patch || typeof patch !== "object" || Array.isArray(patch)) return base;
  if (!base || typeof base !== "object" || Array.isArray(base)) return patch as T;
  const out: Record<string, unknown> = { ...(base as Record<string, unknown>) };
  for (const [k, v] of Object.entries(patch as Record<string, unknown>)) {
    out[k] = v && typeof v === "object" && !Array.isArray(v) ? deepMerge(out[k], v) : v;
  }
  return out as T;
}

/** 按 driver 求出最终映射（校验过的） */
function resolveMapping(
  driver: string,
  mapping: unknown,
): { ok: true; value: GatewayMapping | null } | { ok: false; error: string } {
  if (driver === "mock" || driver === "manual") return { ok: true, value: null };

  if (driver === "epay_v1") {
    // 覆盖项：只写差异（如渠道码、路径），与内置映射深合并
    const merged = mapping ? deepMerge(EPAY_V1_MAPPING, mapping) : EPAY_V1_MAPPING;
    const r = validateMapping(merged, { allowUnsignedQuery: true });
    return r.ok ? { ok: true, value: r.mapping } : { ok: false, error: `mapping 非法：${r.errors.join("；")}` };
  }

  if (driver === "generic_json_v1") {
    if (!mapping) return { ok: false, error: "generic_json_v1 必须提供完整 mapping" };
    const r = validateMapping(mapping);
    return r.ok ? { ok: true, value: r.mapping } : { ok: false, error: `mapping 非法：${r.errors.join("；")}` };
  }

  // stripe / paypal 用代码里的薄 driver，不需要 mapping
  return { ok: true, value: null };
}

interface NormalizedInput {
  driver: string;
  name: string;
  endpoint: string | null;
  merchant_id: string | null;
  methods: string[];
  channel_codes: Record<string, string | number>;
  mapping: unknown;
  priority: number;
  currency: string;
  fx_rate: number;
  test_amount_minor: number;
  test_require_callback: boolean;
  allowed_emails: string[];
}

function normalize(body: Record<string, unknown>, current?: GatewayRow): NormalizedInput | string {
  const driver = String(body.driver ?? current?.driver ?? "").trim();
  if (!ADMIN_DRIVERS.includes(driver as (typeof ADMIN_DRIVERS)[number])) {
    return `driver 必须是 ${ADMIN_DRIVERS.join(" / ")}`;
  }

  const name = String(body.name ?? current?.name ?? "").trim();
  if (!name) return "名称必填";
  if (name.length > 60) return "名称不能超过 60 字";

  const rawMethods = Array.isArray(body.methods)
    ? body.methods
    : current
      ? parseArray(current.methods)
      : [];
  const methods = [...new Set(rawMethods.map((m) => String(m).trim()).filter(Boolean))];
  if (methods.length === 0) return "至少勾一个支付方式";
  const allowed = DRIVER_METHODS[driver] ?? [];
  const bad = methods.filter((m) => !allowed.includes(m));
  if (bad.length) {
    return `${driver} 不支持 ${bad.join("/")}（可选：${allowed.join(" / ")}）`;
  }

  const priorityRaw = body.priority ?? current?.priority ?? 100;
  const priority = Number(priorityRaw);
  if (!Number.isInteger(priority) || priority < 0) return "优先级必须是非负整数";

  const currency = String(body.currency ?? current?.currency ?? "CNY").trim().toUpperCase();
  if (!/^[A-Z]{3}$/.test(currency)) return "币种必须是 3 位 ISO 4217 代码";

  const fxRaw = body.fx_rate ?? current?.fx_rate ?? (currency === "CNY" ? 1 : 0);
  const fx_rate = Number(fxRaw);
  if (!Number.isFinite(fx_rate) || fx_rate <= 0) {
    return "汇率必须大于 0（1 网关币种 = X CNY）";
  }

  const test_require_callback = Boolean(body.test_require_callback ?? current?.test_require_callback ?? false);

  const testAmountRaw = body.test_amount_minor ?? current?.test_amount_minor ?? 100;
  const test_amount_minor = Number(testAmountRaw);
  if (!Number.isInteger(test_amount_minor) || test_amount_minor < 1) {
    return "测试金额必须是正整数（网关币种最小单位）";
  }

  const emailsRaw = body.allowed_emails ?? (current ? parseArray(current.allowed_emails) : []);
  if (!Array.isArray(emailsRaw)) return "allowed_emails 必须是数组";
  const allowed_emails = [...new Set(emailsRaw.map((e) => String(e).trim().toLowerCase()).filter(Boolean))];
  if (allowed_emails.some((e) => !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(e))) {
    return "白名单里有不合法的邮箱";
  }

  const endpoint = body.endpoint === undefined ? (current?.endpoint ?? null) : String(body.endpoint ?? "").trim() || null;

  const rawChannelCodes = body.channel_codes === undefined
    ? (current?.channel_codes ? (JSON.parse(current.channel_codes) as unknown) : null)
    : body.channel_codes;
  const channel_codes: Record<string, string | number> = {};
  if (rawChannelCodes !== null && rawChannelCodes !== undefined) {
    if (!rawChannelCodes || typeof rawChannelCodes !== "object" || Array.isArray(rawChannelCodes)) {
      return "通道号必须是对象（支付方式 → 渠道号）";
    }
    for (const [k, v] of Object.entries(rawChannelCodes as Record<string, unknown>)) {
      if (typeof v !== "string" && typeof v !== "number") return `通道号 ${k} 只能是字符串或数字`;
      if (String(v) !== "") channel_codes[k] = v;
    }
  } else if (driver === "epay_v1") {
    channel_codes.alipay = "alipay";
    channel_codes.wechat = "wxpay";
  }
  const merchant_id =
    body.merchant_id === undefined ? (current?.merchant_id ?? null) : String(body.merchant_id ?? "").trim() || null;

  if (driver === "epay_v1" || driver === "epay_v2" || driver === "generic_json_v1") {
    if (!endpoint) return "网关地址必填（例如 https://pay.example.com）";
    if (!merchant_id) return "商户号必填";
  }
  if (driver === "paypal" && !merchant_id) return "PayPal 需要 Client ID（填在商户号）";

  return {
    driver,
    name,
    endpoint,
    merchant_id,
    methods,
    channel_codes,
    mapping: body.mapping === undefined ? (current?.mapping ? JSON.parse(current.mapping) : null) : body.mapping,
    priority,
    currency,
    fx_rate,
    test_amount_minor,
    test_require_callback,
    allowed_emails,
  };
}

export async function gatewayConfigHash(row: GatewayRow): Promise<string> {
  const payload = JSON.stringify({
    driver: row.driver,
    endpoint: row.endpoint,
    merchant_id: row.merchant_id,
    secret_enc: row.secret_enc,
    webhook_enc: row.webhook_enc,
    methods: row.methods,
    channel_codes: row.channel_codes,
    mapping: row.mapping,
    currency: row.currency,
    fx_rate: row.fx_rate,
    test_amount_minor: row.test_amount_minor,
    test_require_callback: row.test_require_callback,
  });
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(payload));
  return Array.from(new Uint8Array(digest)).map((b) => b.toString(16).padStart(2, "0")).join("");
}

async function loadGateway(env: Env, id: number): Promise<GatewayRow | null> {
  return env.DB.prepare(
    `SELECT id, driver, name, endpoint, merchant_id, secret_enc, webhook_enc, methods, mapping, priority,
       channel_codes, status, currency, fx_rate, test_amount_minor, test_create_ok_at, test_query_ok_at,
       test_callback_ok_at, test_require_callback, tested_config_hash, allowed_emails, last_test_order_id, last_ok_at, last_error
     FROM payment_gateways WHERE id = ?`,
  )
    .bind(id)
    .first<GatewayRow>();
}

/**
 * @returns 命中时返回 Response；未命中返回 `null`（交给 router 继续匹配）
 */
export async function handleAdminGateways(
  request: Request,
  env: Env,
  actor: string,
): Promise<Response | null> {
  const url = new URL(request.url);
  const path = url.pathname.replace(/^\/api\/admin/, "");
  const method = request.method;

  // ── 列表 ──
  if (method === "GET" && path === "/gateways") {
    const rows = await env.DB.prepare(
      `SELECT id, driver, name, endpoint, merchant_id, secret_enc, webhook_enc, methods, channel_codes, mapping, priority,
         status, currency, fx_rate, test_amount_minor, test_create_ok_at, test_query_ok_at,
         test_callback_ok_at, test_require_callback, tested_config_hash, allowed_emails, last_test_order_id, last_ok_at, last_error
       FROM payment_gateways WHERE status <> 'deleted' ORDER BY priority, id`,
    ).all<GatewayRow>();
    return json({
      gateways: (rows.results ?? []).map(view),
      mock_enabled: isMockEnabled(env),
      secret_key_ready: secretKeyConfigured(env),
      ai_ready: aiReady(env),
      drivers: ADMIN_DRIVERS.map((d) => ({ driver: d, methods: DRIVER_METHODS[d] ?? [] })),
      all_methods: ALL_METHODS,
    });
  }

  // ── 新建 ──
  if (method === "POST" && path === "/gateways") {
    const body = await readBody(request);
    const normalized = normalize(body);
    if (typeof normalized === "string") return fail(400, "invalid_gateway", normalized);

    if (normalized.driver === "mock" && !isMockEnabled(env)) {
      return fail(400, "mock_disabled", "测试网关未启用（需要 ALLOW_MOCK_PAYMENTS=true）");
    }

    const resolved = resolveMapping(normalized.driver, normalized.mapping);
    if (!resolved.ok) return fail(400, "invalid_mapping", resolved.error);

    // 密钥：只有传了非空 `secret` 才写；没配主密钥就拒绝（不存明文）
    let secretEnc: string | null = null;
    const plain = typeof body.secret === "string" ? body.secret.trim() : "";
    if (plain) {
      const enc = await encryptSecret(env, plain);
      if (!enc) return fail(400, "secret_key_missing", "未配置主密钥 APP_SECRET，无法保存网关密钥");
      secretEnc = enc;
    }

    // webhook 凭据：Stripe signing secret / PayPal webhook id
    let webhookEnc: string | null = null;
    const webhookPlain = typeof body.webhook_secret === "string" ? body.webhook_secret.trim() : "";
    if (webhookPlain) {
      const enc = await encryptSecret(env, webhookPlain);
      if (!enc) return fail(400, "secret_key_missing", "未配置主密钥 APP_SECRET，无法保存 webhook 凭据");
      webhookEnc = enc;
    }

    const now = new Date().toISOString();
    const res = await env.DB.prepare(
      `INSERT INTO payment_gateways (driver, name, endpoint, merchant_id, secret_enc, webhook_enc,
         methods, channel_codes, mapping, priority, status, currency, fx_rate, test_amount_minor, test_require_callback, allowed_emails, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'draft', ?, ?, ?, ?, ?, ?, ?)`,
    )
      .bind(
        normalized.driver,
        normalized.name,
        normalized.endpoint,
        normalized.merchant_id,
        secretEnc,
        webhookEnc,
        JSON.stringify(normalized.methods),
        Object.keys(normalized.channel_codes).length ? JSON.stringify(normalized.channel_codes) : null,
        resolved.value ? JSON.stringify(resolved.value) : null,
        normalized.priority,
        normalized.currency,
        normalized.fx_rate,
        normalized.test_amount_minor,
        normalized.test_require_callback ? 1 : 0,
        normalized.allowed_emails.length ? JSON.stringify(normalized.allowed_emails) : null,
        now,
        now,
      )
      .run();

    const id = Number(res.meta.last_row_id ?? 0);
    await audit(env, actor, "gateway_created", String(id), { driver: normalized.driver, name: normalized.name });
    const row = await loadGateway(env, id);
    return json({ gateway: row ? view(row) : null }, 201);
  }

  // ── 查看当前密钥（显式操作；审计；不写日志）──
  const reveal = /^\/gateways\/(\d+)\/secret$/.exec(path);
  if (method === "GET" && reveal) {
    const id = Number(reveal[1]);
    const current = await loadGateway(env, id);
    if (!current || current.status === "deleted") return fail(404, "gateway_not_found");
    if (!current.secret_enc) return fail(400, "secret_not_set", "这条网关还没有保存密钥");
    const secret = await decryptSecret(env, current.secret_enc);
    if (secret === null) {
      return fail(500, "secret_unavailable", "密钥解不开（主密钥未配置或已更换）");
    }
    await audit(env, actor, "gateway_secret_revealed", String(id), { name: current.name });
    return new Response(JSON.stringify({ secret }), {
      headers: {
        "Content-Type": "application/json; charset=utf-8",
        "Cache-Control": "no-store",
      },
    });
  }

  // ── 测试支付：只验证"这条网关能不能收钱"，不产生订阅 ──
  //    与用户下单的三点不同：允许 draft、忽略白名单、落成 `source='test'` 的 0 权益测试单。
  const testOne = /^\/gateways\/(\d+)\/test$/.exec(path);
  if (method === "POST" && testOne) {
    const id = Number(testOne[1]);
    const current = await loadGateway(env, id);
    if (!current || current.status === "deleted") return fail(404, "gateway_not_found");

    const body = await readBody(request);
    const methods = (JSON.parse(current.methods || "[]") as string[]) ?? [];
    const wanted = typeof body.method === "string" ? body.method.trim() : "";
    const method_ = wanted || methods[0] || "";
    if (!method_) return fail(400, "no_method", "这条网关没有配置任何支付方式");
    if (!methods.includes(method_)) {
      return fail(400, "method_not_supported", `这条网关不支持 ${method_}`);
    }

    // Stripe 的最小扣款额高于 1 分；测试单统一 USD $1.00，避免 session 创建就失败
    const brandTest = current.driver === "stripe" || current.driver === "paypal";
    const amount = Math.max(
      1,
      Number(body.amount_minor ?? current.test_amount_minor ?? 100) || current.test_amount_minor || 100,
    );
    const testCurrency = current.currency;
    const origin = (env.SITE_URL && env.SITE_URL.trim()) || new URL(request.url).origin;

    const res = await createCharge(env, {
      // 测试单没有真实客户：`customer_id = 0` 是哨兵值，用户侧永远看不到
      customerId: 0,
      customerEmail: actor,
      plan: {
        id: "__gateway_test__",
        name: "网关测试",
        kind: "period",
        price_minor: amount,
        currency: testCurrency,
        licence_limit: 1,
        term_days: 1,
        monthly_quota_gb: null,
        traffic_gb: null,
        validity_days: null,
        line_ids: [],
        up_mbps: null,
        down_mbps: null,
        sales_channels: [{ channel: "web_checkout", methods: [method_] }],
        store_product_id: {},
        sort_order: 0,
        status: "active",
        visibility: "hidden",
        retired_at: null,
        trial: false,
      },
      method: method_,
      amountMinor: amount,
      entry: "admin",
      origin,
      crmOrigin: new URL(request.url).origin,
      clientIp: request.headers.get("CF-Connecting-IP") ?? "127.0.0.1",
      testGatewayId: id,
    });

    if (!res.ok) return fail(res.status, res.code, res.message);

    const nowIso = new Date().toISOString();
    await env.DB.prepare(
      `UPDATE payment_gateways SET test_create_ok_at = ?, test_query_ok_at = NULL,
         test_callback_ok_at = NULL, tested_config_hash = NULL, last_test_order_id = ?, updated_at = ? WHERE id = ?`,
    )
      .bind(nowIso, null, nowIso, id)
      .run();

    const testOrder = await env.DB.prepare(`SELECT id FROM orders WHERE code = ?`).bind(res.orderCode).first<{ id: number }>();
    const queryResult = current.driver === "mock" ? { verdict: "no_query" as const } : await pollOrderOnce(env, res.orderCode);
    const queryOk = current.driver === "mock" || (!!queryResult && queryResult.verdict !== "no_query" && queryResult.verdict !== "error");
    if (!queryOk) {
      return fail(
        502,
        "test_query_failed",
        !queryResult || queryResult.verdict === "no_query"
          ? "创建成功，但该网关没有可用的查单接口；请先配置查单后再发布"
          : "创建成功，但查单失败；请检查查单路径、参数和签名",
      );
    }

    const tested = await loadGateway(env, id);
    const hash = tested ? await gatewayConfigHash(tested) : null;
    await env.DB.prepare(
      `UPDATE payment_gateways SET test_query_ok_at = ?, tested_config_hash = ?,
         last_test_order_id = ?, updated_at = ? WHERE id = ?`,
    )
      .bind(nowIso, hash, testOrder?.id ?? null, nowIso, id)
      .run();

    return json({
      ok: true,
      order_code: res.orderCode,
      pay_url: res.payUrl,
      amount_minor: res.amountMinor,
      currency: res.currency,
      expires_at: res.expiresAt,
      test_ready: !current.test_require_callback,
      callback_required: current.test_require_callback,
      actor,
    });
  }

  const byId = /^\/gateways\/(\d+)$/.exec(path);
  const action = /^\/gateways\/(\d+)\/(publish|disable)$/.exec(path);
  const id = Number(byId?.[1] ?? action?.[1] ?? 0);

  if (id > 0 && method === "PATCH" && byId) {
    const current = await loadGateway(env, id);
    if (!current || current.status === "deleted") return fail(404, "gateway_not_found");

    const body = await readBody(request);
    const normalized = normalize(body, current);
    if (typeof normalized === "string") return fail(400, "invalid_gateway", normalized);

    if (normalized.driver !== current.driver && current.status !== "draft") {
      return fail(409, "driver_locked", "已发布/已停用的网关不能改驱动（新建一条更安全）");
    }

    // 已发布的测试网关不能把白名单清空：清空后它对**任何人**都不可见（含登录用户），
    // 但后台仍显示"已发布" —— 这是最难查的一类故障，直接在保存时拦住。
    if (
      normalized.driver === "mock" &&
      current.status === "live" &&
      normalized.allowed_emails.length === 0
    ) {
      return fail(
        400,
        "mock_whitelist_required",
        "测试网关必须保留至少一个白名单邮箱（清空后它等于不存在）",
      );
    }

    const resolved = resolveMapping(normalized.driver, normalized.mapping);
    if (!resolved.ok) return fail(400, "invalid_mapping", resolved.error);

    // 草稿改驱动：沿用上一条驱动的密钥/webhook 等于把 Stripe 的 whsec 发给 PayPal。
    // 两边都清掉，强制重新填。
    const driverChanged = normalized.driver !== current.driver;
    let secretEnc = driverChanged ? null : current.secret_enc;
    if (body.clear_secret === true) secretEnc = null;
    if (typeof body.secret === "string" && body.secret.trim()) {
      const enc = await encryptSecret(env, body.secret.trim());
      if (!enc) return fail(400, "secret_key_missing", "未配置主密钥 APP_SECRET，无法保存网关密钥");
      secretEnc = enc;
    }

    let webhookEnc = driverChanged ? null : current.webhook_enc;
    if (body.clear_webhook === true) webhookEnc = null;
    if (typeof body.webhook_secret === "string" && body.webhook_secret.trim()) {
      const enc = await encryptSecret(env, body.webhook_secret.trim());
      if (!enc) return fail(400, "secret_key_missing", "未配置主密钥 APP_SECRET，无法保存 webhook 凭据");
      webhookEnc = enc;
    }

    await env.DB.prepare(
      `UPDATE payment_gateways SET driver = ?, name = ?, endpoint = ?, merchant_id = ?, secret_enc = ?,
         webhook_enc = ?, methods = ?, channel_codes = ?, mapping = ?, priority = ?, currency = ?, fx_rate = ?, test_amount_minor = ?, test_require_callback = ?, allowed_emails = ?,
         updated_at = ? WHERE id = ?`,
    )
      .bind(
        normalized.driver,
        normalized.name,
        normalized.endpoint,
        normalized.merchant_id,
        secretEnc,
        webhookEnc,
        JSON.stringify(normalized.methods),
        Object.keys(normalized.channel_codes).length ? JSON.stringify(normalized.channel_codes) : null,
        resolved.value ? JSON.stringify(resolved.value) : null,
        normalized.priority,
        normalized.currency,
        normalized.fx_rate,
        normalized.test_amount_minor,
        normalized.test_require_callback ? 1 : 0,
        normalized.allowed_emails.length ? JSON.stringify(normalized.allowed_emails) : null,
        new Date().toISOString(),
        id,
      )
      .run();

    await audit(env, actor, "gateway_updated", String(id), { name: normalized.name });
    const row = await loadGateway(env, id);
    if (row && current.tested_config_hash && (await gatewayConfigHash(row)) !== current.tested_config_hash) {
      await env.DB.prepare(
        `UPDATE payment_gateways SET test_create_ok_at = NULL, test_query_ok_at = NULL,
           test_callback_ok_at = NULL, tested_config_hash = NULL, updated_at = ? WHERE id = ?`,
      )
        .bind(new Date().toISOString(), id)
        .run();
    }
    return json({ gateway: row ? view(row) : null });
  }

  // ── 复制为草稿：从一条现有网关复制完整集成配置（密钥/webhook 也复制）──
  const copyOne = /^\/gateways\/(\d+)\/copy$/.exec(path);
  if (method === "POST" && copyOne) {
    const id = Number(copyOne[1]);
    const current = await loadGateway(env, id);
    if (!current || current.status === "deleted") return fail(404, "gateway_not_found");
    const now = new Date().toISOString();
    const name = `${current.name}（副本）`.slice(0, 60);
    const res = await env.DB.prepare(
      `INSERT INTO payment_gateways (driver, name, endpoint, merchant_id, secret_enc, webhook_enc,
         methods, channel_codes, mapping, priority, status, currency, fx_rate, test_amount_minor, test_require_callback, allowed_emails, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'draft', ?, ?, ?, ?, ?, ?, ?)`,
    )
      .bind(
        current.driver,
        name,
        current.endpoint,
        current.merchant_id,
        current.secret_enc,
        current.webhook_enc,
        current.methods,
        current.channel_codes,
        current.mapping,
        current.priority,
        current.currency,
        current.fx_rate,
        current.test_amount_minor,
        current.test_require_callback,
        current.allowed_emails,
        now,
        now,
      )
      .run();
    const newId = Number(res.meta.last_row_id ?? 0);
    await audit(env, actor, "gateway_copied", String(newId), { from: id, name });
    const row = await loadGateway(env, newId);
    return json({ gateway: row ? view(row) : null }, 201);
  }

  // ── 删除（软删除）──
  //    不物理删：orders.gateway_id、在途 webhook/查单、审计都还引用这一行。
  //    删除后列表隐藏、新下单不再路由；老订单仍能按 id 加载并确认。
  if (id > 0 && method === "DELETE" && byId) {
    const current = await loadGateway(env, id);
    if (!current || current.status === "deleted") return fail(404, "gateway_not_found");
    await env.DB.prepare(
      `UPDATE payment_gateways SET status = 'deleted', updated_at = ? WHERE id = ?`,
    )
      .bind(new Date().toISOString(), id)
      .run();
    await audit(env, actor, "gateway_deleted", String(id), {
      driver: current.driver,
      name: current.name,
    });
    return json({ ok: true });
  }

  if (id > 0 && method === "POST" && action) {
    const current = await loadGateway(env, id);
    if (!current || current.status === "deleted") return fail(404, "gateway_not_found");
    const verb = action[2];

    if (verb === "disable") {
      await env.DB.prepare(`UPDATE payment_gateways SET status = 'disabled', updated_at = ? WHERE id = ?`)
        .bind(new Date().toISOString(), id)
        .run();
      await audit(env, actor, "gateway_disabled", String(id));
      const row = await loadGateway(env, id);
      return json({ gateway: row ? view(row) : null });
    }

    // publish：三道检查
    if (current.driver === "mock") {
      if (!isMockEnabled(env)) return fail(400, "mock_disabled", "测试网关未启用（需要 ALLOW_MOCK_PAYMENTS=true）");
      if (parseArray(current.allowed_emails).length === 0) {
        return fail(400, "mock_whitelist_required", "测试网关必须配置客户白名单才能发布（否则等于向所有人免费开通）");
      }
    }
    if (["epay_v1", "epay_v2", "generic_json_v1", "stripe", "paypal"].includes(current.driver)) {
      if (!current.secret_enc) return fail(400, "secret_required", "发布前必须设置网关密钥");
    }
    if (current.driver === "paypal" && !current.merchant_id) {
      return fail(400, "paypal_client_id_required", "PayPal 发布前必须设置 Client ID");
    }
    if ((current.driver === "stripe" || current.driver === "paypal") && !current.webhook_enc) {
      return fail(400, "webhook_required", "发布前必须配置 Webhook 凭据（Stripe signing secret / PayPal webhook id）");
    }
    const resolved = resolveMapping(
      current.driver,
      current.mapping ? (JSON.parse(current.mapping) as unknown) : null,
    );
    if (!resolved.ok) return fail(400, "invalid_mapping", resolved.error);

    if (current.driver !== "mock") {
      if (!current.test_create_ok_at || !current.test_query_ok_at) {
        return fail(400, "test_required", "发布前必须先测试：创建订单 + 查询订单");
      }
      if (current.test_require_callback && !current.test_callback_ok_at) {
        return fail(400, "test_callback_required", "已开启通知验证：请完成测试支付并收到通知后再发布");
      }
      if (!current.tested_config_hash || current.tested_config_hash !== (await gatewayConfigHash(current))) {
        return fail(400, "test_required", "配置已变更，请重新测试后再发布");
      }
    }

    await env.DB.prepare(`UPDATE payment_gateways SET status = 'live', updated_at = ? WHERE id = ?`)
      .bind(new Date().toISOString(), id)
      .run();
    await audit(env, actor, "gateway_published", String(id), { driver: current.driver });
    const row = await loadGateway(env, id);
    return json({ gateway: row ? view(row) : null });
  }

  return null;
}

export { GATEWAY_STATUSES };
