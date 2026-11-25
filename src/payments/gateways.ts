/**
 * 网关的「能不能用」与路由选择
 *
 * 这里集中了所有**闸门**，别在路由/回调里各写一遍 —— 判断散开就会漏。
 *
 * 三道条件（全部满足才可能被选中）：
 *   1. `status = 'live'`（`draft` 在 App 里不存在、`disabled` 不再路由）；
 *   2. `methods` 含本次要收的支付方式；
 *   3. **白名单**：`allowed_emails` 为空 = 不限；非空则客户邮箱必须在名单里。
 *
 * `driver = 'mock'` 是租户自测网关：**只靠强制非空白名单隔离**，见
 * `docs/payments.md` §5.3。
 */

import { EPAY_V1_MAPPING } from "./builtin/epay";
import { MOCK_DRIVER, MOCK_MAPPING } from "./mock";
import { validateMapping, type GatewayMapping } from "./mapping";

import type { Env } from "../env";

export interface GatewayRow {
  id: number;
  driver: string;
  name: string;
  endpoint: string | null;
  /** PayPal 专属：sandbox | live；null 按 sandbox（历史数据） */
  paypal_env: string | null;
  merchant_id: string | null;
  secret_enc: string | null;
  /** 加密的 webhook 凭据（Stripe whsec / PayPal webhook id）；仅 stripe/paypal */
  webhook_enc: string | null;
  /** JSON 数组 */
  methods: string;
  /** 账户相关的通道号（JSON 对象） */
  channel_codes: string | null;
  /** JSON（只有 generic_json_v1 需要） */
  mapping: string | null;
  priority: number;
  status: string;
  currency: string;
  /** 1 单位网关币种 = X CNY；CNY 网关固定 1 */
  fx_rate: number;
  /** 测试支付金额（网关币种，最小单位） */
  test_amount_minor: number;
  test_create_ok_at: string | null;
  test_query_ok_at: string | null;
  test_callback_ok_at: string | null;
  test_require_callback: number;
  /** 测试通过时绑定的配置 hash */
  tested_config_hash: string | null;
  /** JSON 数组；`null` = 不限 */
  allowed_emails: string | null;
  last_test_order_id: number | null;
  last_ok_at: string | null;
  last_error: string | null;
}

export const GATEWAY_COLUMNS = `id, driver, name, endpoint, paypal_env, merchant_id, secret_enc, webhook_enc,
  methods, channel_codes, mapping, priority, status, currency, fx_rate, test_amount_minor,
  test_create_ok_at, test_query_ok_at, test_callback_ok_at, test_require_callback, tested_config_hash,
  allowed_emails, last_test_order_id, last_ok_at, last_error`;

function parseJsonArray(raw: string | null): string[] {
  if (!raw) return [];
  try {
    const v = JSON.parse(raw) as unknown;
    return Array.isArray(v) ? v.map((x) => String(x).trim()).filter(Boolean) : [];
  } catch {
    return [];
  }
}

export function parseMethods(raw: string | null): string[] {
  return parseJsonArray(raw);
}

/** 账户通道号：JSON 对象；坏数据按空对象处理 */
export function parseChannelCodes(raw: string | null): Record<string, string | number> {
  if (!raw) return {};
  try {
    const v = JSON.parse(raw) as unknown;
    if (!v || typeof v !== "object" || Array.isArray(v)) return {};
    const out: Record<string, string | number> = {};
    for (const [k, x] of Object.entries(v)) {
      if (typeof x === "string" || typeof x === "number") out[k] = x;
    }
    return out;
  } catch {
    return {};
  }
}

/** 白名单（邮箱已归一为小写）；返回空数组表示"不限" */
export function parseAllowedEmails(raw: string | null): string[] {
  return parseJsonArray(raw).map((e) => e.toLowerCase());
}

/**
 * 第三道条件：这条网关对某个客户可见吗？
 *
 * `mock` 特殊：它**额外要求白名单非空**（空名单 = 对任何人都不存在）。
 */
export function gatewayVisibleTo(gw: GatewayRow, email: string, _env: Env): boolean {
  const allowed = parseAllowedEmails(gw.allowed_emails);
  const who = email.trim().toLowerCase();

  if (gw.driver === MOCK_DRIVER) {
    // 生产/测试环境都允许 mock；只靠强制非空白名单隔离，绝不向陌生访客开放。
    if (allowed.length === 0) return false;
    return allowed.includes(who);
  }
  if (gw.driver === "paypal" && gw.paypal_env !== "live") {
    // PayPal sandbox（含历史 null）不产生真实扣款；同样只允许白名单测试客户，防止免费开通。
    if (allowed.length === 0) return false;
    return allowed.includes(who);
  }
  return allowed.length === 0 || allowed.includes(who);
}

/**
 * 取这条网关的**映射**配置（只对映射类 driver 有意义）。
 * @returns `null` = 不是映射类 driver（stripe/paypal/manual），或映射配置非法
 */
export function mappingOf(gw: GatewayRow): GatewayMapping | null {
  if (gw.driver === "epay_v1") return EPAY_V1_MAPPING;
  if (gw.driver === MOCK_DRIVER) return MOCK_MAPPING;
  if (gw.driver === "generic_json_v1") {
    let parsed: unknown;
    try {
      parsed = gw.mapping ? JSON.parse(gw.mapping) : null;
    } catch {
      return null;
    }
    const r = validateMapping(parsed);
    return r.ok ? r.mapping : null;
  }
  return null;
}

/** 路由真正走的实现：映射解释器，或两条薄 driver */
export type RouteDriver = "mapping" | "stripe" | "paypal" | "epay_v2";

/**
 * 这条网关有没有可路由的实现。
 * - `epay_v1` / `generic_json_v1` / `mock`：有合法 mapping ⇒ `"mapping"`；
 * - `stripe` / `paypal`：代码里的薄 driver ⇒ 自身；
 * - `manual`：`null`（线下到账，不参与路由）。
 */
export function routeDriverOf(gw: GatewayRow): RouteDriver | null {
  if (gw.driver === "stripe" || gw.driver === "paypal") return gw.driver;
  if (gw.driver === "epay_v2") return "epay_v2";
  return mappingOf(gw) ? "mapping" : null;
}

export interface RouteResult {
  gateway: GatewayRow;
  driver: RouteDriver;
  /** `driver === "mapping"` 时非空；薄 driver 为 null */
  mapping: GatewayMapping | null;
}

/**
 * 选出一条能收 `method` 的网关：`priority` 升序，同优先级按 `id`。
 *
 * @param rows 已按 `status='live'` 过滤过的候选（也允许传全量，这里会再判一次）
 */
export function pickGateway(
  rows: readonly GatewayRow[],
  method: string,
  email: string,
  env: Env,
): RouteResult | null {
  const candidates = rows
    .filter((g) => g.status === "live")
    .filter((g) => parseMethods(g.methods).includes(method))
    .filter((g) => gatewayVisibleTo(g, email, env))
    .sort((a, b) => a.priority - b.priority || a.id - b.id);

  for (const gateway of candidates) {
    const driver = routeDriverOf(gateway);
    if (!driver) continue; // manual / 映射配置非法
    return {
      gateway,
      driver,
      mapping: driver === "mapping" ? mappingOf(gateway) : null,
    };
  }
  return null;
}

/** 读取全部网关（管理端 / 路由共用） */
export async function listGateways(env: Env): Promise<GatewayRow[]> {
  const rows = await env.DB.prepare(
    `SELECT ${GATEWAY_COLUMNS} FROM payment_gateways ORDER BY priority, id`,
  ).all<GatewayRow>();
  return rows.results ?? [];
}

/**
 * 某个访客**实际能用**的支付方式（定价页的 `payment_methods` 就靠它）。
 *
 * 规则只有一条，但要看清楚它的三个后果：
 *
 *   `live` + 有可路由实现 + 对这个人是可见的（`gatewayVisibleTo`）
 *
 * 1. **白名单为空 = 公开网关**：谁都可见，游客也算（除 mock 外）。
 * 2. **白名单非空 = 私有网关**：只对名单内的**已登录**用户可见；游客一律不可见
 *    （游客没有邮箱，不可能命中名单）。
 * 3. **`driver='mock'` 额外要求名单非空**：空名单的测试网关等于不存在 —— 连登录
 *    用户也看不到。这条在 `gatewayVisibleTo` 里，这里不重复判。
 *
 * 为什么现在按访客算：测试网关是**给租户验证支付流程**用的产品功能，只有名单里的
 * 人能测到，就不可能靠"实例级可见"表达。代价是这个接口不能跨用户缓存 —— 而
 * `/plans` 本来就已经按访客变（`action` / `buyable` / 到期日都因人而异）。
 */
export async function methodsForViewer(
  env: Env,
  email: string | null,
): Promise<Set<string>> {
  const out = new Set<string>();
  const who = (email ?? "").trim().toLowerCase();
  for (const g of await listLiveGateways(env)) {
    if (!routeDriverOf(g)) continue;
    if (!gatewayVisibleTo(g, who, env)) continue;
    for (const m of parseMethods(g.methods)) out.add(m);
  }
  return out;
}

/** 只读可路由的（`status='live'`），路由热路径用这个 */
export async function listLiveGateways(env: Env): Promise<GatewayRow[]> {
  const rows = await env.DB.prepare(
    `SELECT ${GATEWAY_COLUMNS} FROM payment_gateways WHERE status = 'live' ORDER BY priority, id`,
  ).all<GatewayRow>();
  return rows.results ?? [];
}

/**
 * 这条网关现在**对外可见**的支付方式（App 的支付方式列表就靠它）。
 * 白名单/环境闸门都在里面判，所以界面与真实路由永远一致。
 */
export function visibleMethods(gw: GatewayRow, email: string, env: Env): string[] {
  if (gw.status !== "live") return [];
  if (!gatewayVisibleTo(gw, email, env)) return [];
  if (!routeDriverOf(gw)) return [];
  return parseMethods(gw.methods);
}
