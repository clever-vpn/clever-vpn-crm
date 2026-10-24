/**
 * 管理后台：支付网关 `/api/admin/gateways*`
 *
 * 这里是**唯一能创建网关的地方**。三条硬规则写在这里，不靠前端自觉：
 *
 *   1. `driver` 决定它**能卖哪些方式**（`DRIVER_METHODS`）—— 不允许 "stripe + 支付宝"
 *      这种配置，否则显示名与真实能力会打架；
 *   2. 密钥只能通过 `secret`（明文，进来就加密）写入，**任何响应都不回显**，
 *      只回 `has_secret`；
 *   3. `mock` 的两道闸门在发布时校验：环境开关必须打开，白名单必须非空。
 *
 * `epay_v1` 的 `mapping` 是**覆盖项**（与内置映射深合并），租户只写差异；
 * `generic_json_v1` 的 `mapping` 是**完整配置**（必须能通过 `validateMapping`）。
 */

import { encryptSecret, secretKeyConfigured } from "../payments/secret";
import { DRIVERS, validateMapping, type GatewayMapping } from "../payments/mapping";
import { EPAY_V1_MAPPING } from "../payments/builtin/epay";
import { isMockEnabled } from "../payments/gateways";
import { MOCK_DRIVER } from "../payments/mock";

import type { Env } from "../env";
import type { GatewayRow } from "../payments/gateways";

const GATEWAY_STATUSES = ["draft", "live", "disabled"] as const;

/**
 * 后台可配置的驱动 = 真实驱动 + `mock`。
 * `mock` 不在 `DRIVERS` 里（它不参与真实下单映射校验），但租户做联调时必须在后台能看到它，
 * 所以这里单独并进来；能不能真正发布由 `ALLOW_MOCK_PAYMENTS` + 白名单把关。
 */
const ADMIN_DRIVERS = [...DRIVERS, MOCK_DRIVER];

/** 每种 driver 能卖的方式 —— 这就是"品牌即方式"的落地 */
const DRIVER_METHODS: Record<string, readonly string[]> = {
  epay_v1: ["alipay", "wechat"],
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

/** 对外视图：**永远不含密钥** */
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
    methods: parseArray(row.methods),
    mapping,
    priority: row.priority,
    status: row.status,
    currency: row.currency,
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
    const r = validateMapping(merged);
    return r.ok ? { ok: true, value: r.mapping } : { ok: false, error: `mapping 非法：${r.errors.join("；")}` };
  }

  if (driver === "generic_json_v1") {
    if (!mapping) return { ok: false, error: "generic_json_v1 必须提供完整 mapping" };
    const r = validateMapping(mapping);
    return r.ok ? { ok: true, value: r.mapping } : { ok: false, error: `mapping 非法：${r.errors.join("；")}` };
  }

  // stripe / paypal 用代码里的 driver，不需要 mapping
  return { ok: true, value: null };
}

interface NormalizedInput {
  driver: string;
  name: string;
  endpoint: string | null;
  merchant_id: string | null;
  methods: string[];
  mapping: unknown;
  priority: number;
  currency: string;
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

  const emailsRaw = body.allowed_emails ?? (current ? parseArray(current.allowed_emails) : []);
  if (!Array.isArray(emailsRaw)) return "allowed_emails 必须是数组";
  const allowed_emails = [...new Set(emailsRaw.map((e) => String(e).trim().toLowerCase()).filter(Boolean))];
  if (allowed_emails.some((e) => !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(e))) {
    return "白名单里有不合法的邮箱";
  }

  const endpoint = body.endpoint === undefined ? (current?.endpoint ?? null) : String(body.endpoint ?? "").trim() || null;
  const merchant_id =
    body.merchant_id === undefined ? (current?.merchant_id ?? null) : String(body.merchant_id ?? "").trim() || null;

  if (driver === "epay_v1" || driver === "generic_json_v1") {
    if (!endpoint) return "网关地址必填（例如 https://pay.example.com）";
    if (!merchant_id) return "商户号必填";
  }

  return {
    driver,
    name,
    endpoint,
    merchant_id,
    methods,
    mapping: body.mapping === undefined ? (current?.mapping ? JSON.parse(current.mapping) : null) : body.mapping,
    priority,
    currency,
    allowed_emails,
  };
}

async function loadGateway(env: Env, id: number): Promise<GatewayRow | null> {
  return env.DB.prepare(
    `SELECT id, driver, name, endpoint, merchant_id, secret_enc, methods, mapping, priority,
       status, currency, allowed_emails, last_test_order_id, last_ok_at, last_error
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
      `SELECT id, driver, name, endpoint, merchant_id, secret_enc, methods, mapping, priority,
         status, currency, allowed_emails, last_test_order_id, last_ok_at, last_error
       FROM payment_gateways ORDER BY priority, id`,
    ).all<GatewayRow>();
    return json({
      gateways: (rows.results ?? []).map(view),
      mock_enabled: isMockEnabled(env),
      secret_key_ready: secretKeyConfigured(env),
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
      if (!enc) return fail(400, "secret_key_missing", "未配置 PAYMENT_SECRET_KEY，无法保存网关密钥");
      secretEnc = enc;
    }

    const now = new Date().toISOString();
    const res = await env.DB.prepare(
      `INSERT INTO payment_gateways (driver, name, endpoint, merchant_id, secret_enc, methods, mapping,
         priority, status, currency, allowed_emails, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'draft', ?, ?, ?, ?)`,
    )
      .bind(
        normalized.driver,
        normalized.name,
        normalized.endpoint,
        normalized.merchant_id,
        secretEnc,
        JSON.stringify(normalized.methods),
        resolved.value ? JSON.stringify(resolved.value) : null,
        normalized.priority,
        normalized.currency,
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

  const byId = /^\/gateways\/(\d+)$/.exec(path);
  const action = /^\/gateways\/(\d+)\/(publish|disable)$/.exec(path);
  const id = Number(byId?.[1] ?? action?.[1] ?? 0);

  if (id > 0 && method === "PATCH" && byId) {
    const current = await loadGateway(env, id);
    if (!current) return fail(404, "gateway_not_found");

    const body = await readBody(request);
    const normalized = normalize(body, current);
    if (typeof normalized === "string") return fail(400, "invalid_gateway", normalized);

    if (normalized.driver !== current.driver && current.status !== "draft") {
      return fail(409, "driver_locked", "已发布/已停用的网关不能改驱动（新建一条更安全）");
    }

    const resolved = resolveMapping(normalized.driver, normalized.mapping);
    if (!resolved.ok) return fail(400, "invalid_mapping", resolved.error);

    let secretEnc = current.secret_enc;
    if (body.clear_secret === true) secretEnc = null;
    if (typeof body.secret === "string" && body.secret.trim()) {
      const enc = await encryptSecret(env, body.secret.trim());
      if (!enc) return fail(400, "secret_key_missing", "未配置 PAYMENT_SECRET_KEY，无法保存网关密钥");
      secretEnc = enc;
    }

    await env.DB.prepare(
      `UPDATE payment_gateways SET driver = ?, name = ?, endpoint = ?, merchant_id = ?, secret_enc = ?,
         methods = ?, mapping = ?, priority = ?, currency = ?, allowed_emails = ?, updated_at = ?
       WHERE id = ?`,
    )
      .bind(
        normalized.driver,
        normalized.name,
        normalized.endpoint,
        normalized.merchant_id,
        secretEnc,
        JSON.stringify(normalized.methods),
        resolved.value ? JSON.stringify(resolved.value) : null,
        normalized.priority,
        normalized.currency,
        normalized.allowed_emails.length ? JSON.stringify(normalized.allowed_emails) : null,
        new Date().toISOString(),
        id,
      )
      .run();

    await audit(env, actor, "gateway_updated", String(id), { name: normalized.name });
    const row = await loadGateway(env, id);
    return json({ gateway: row ? view(row) : null });
  }

  if (id > 0 && method === "POST" && action) {
    const current = await loadGateway(env, id);
    if (!current) return fail(404, "gateway_not_found");
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
    if (current.driver === "epay_v1" || current.driver === "generic_json_v1") {
      if (!current.secret_enc) return fail(400, "secret_required", "发布前必须设置网关密钥");
    }
    const resolved = resolveMapping(
      current.driver,
      current.mapping ? (JSON.parse(current.mapping) as unknown) : null,
    );
    if (!resolved.ok) return fail(400, "invalid_mapping", resolved.error);

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
