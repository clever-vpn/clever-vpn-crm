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
 * 另外 `driver = 'mock'` 还有一道**环境闸门**（`env.ALLOW_MOCK_PAYMENTS`）与
 * 「白名单必须非空」，见 `docs/payments.md` §5.3。
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
  merchant_id: string | null;
  secret_enc: string | null;
  /** JSON 数组 */
  methods: string;
  /** JSON（只有 generic_json_v1 需要） */
  mapping: string | null;
  priority: number;
  status: string;
  currency: string;
  /** JSON 数组；`null` = 不限 */
  allowed_emails: string | null;
  last_test_order_id: number | null;
  last_ok_at: string | null;
  last_error: string | null;
}

export const GATEWAY_COLUMNS = `id, driver, name, endpoint, merchant_id, secret_enc,
  methods, mapping, priority, status, currency, allowed_emails, last_test_order_id,
  last_ok_at, last_error`;

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

/** 白名单（邮箱已归一为小写）；返回空数组表示"不限" */
export function parseAllowedEmails(raw: string | null): string[] {
  return parseJsonArray(raw).map((e) => e.toLowerCase());
}

/** 第一道闸门：mock 网关的环境总开关（默认关） */
export function isMockEnabled(env: Env): boolean {
  return String(env.ALLOW_MOCK_PAYMENTS ?? "").trim().toLowerCase() === "true";
}

/**
 * 第三道条件：这条网关对某个客户可见吗？
 *
 * `mock` 特殊：它**额外要求白名单非空**（空名单 = 对所有真实用户开放 = 免费开通）。
 */
export function gatewayVisibleTo(gw: GatewayRow, email: string, env: Env): boolean {
  const allowed = parseAllowedEmails(gw.allowed_emails);
  const who = email.trim().toLowerCase();

  if (gw.driver === MOCK_DRIVER) {
    if (!isMockEnabled(env)) return false;
    if (allowed.length === 0) return false;
    return allowed.includes(who);
  }
  return allowed.length === 0 || allowed.includes(who);
}

/**
 * 取这条网关的映射配置。
 * @returns `null` = 这个 driver 还没有自动下单实现（stripe/paypal/manual，或映射配置非法）
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

export interface RouteResult {
  gateway: GatewayRow;
  mapping: GatewayMapping;
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
    const mapping = mappingOf(gateway);
    // 没有自动下单实现的 driver 不参与路由（stripe/paypal 将来补 driver 后自然会进来）
    if (mapping) return { gateway, mapping };
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
  if (!mappingOf(gw)) return [];
  return parseMethods(gw.methods);
}
