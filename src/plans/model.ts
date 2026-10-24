/**
 * 套餐模型 —— CRM 的**唯一销售资产**
 *
 * 设计原则（见 `clever-vpn-docs` `app-crm.md` §2.4.7 / §2.4.8）：
 *   1. 只有 `kind` 一个开关，只有三种值：`period` / `traffic` / `addon`。
 *      不允许租户自由拼"时长 × 流量 × …"，否则"这单怎么算"就成了客服问题。
 *   2. App 里**没有**任何销售规则：可买性、价格、升级补多少，全部由这里算出。
 *   3. 平台（cf-api）不识别套餐，套餐落到平台只是一组控制参数
 *      （`expire_date` / `traffic_balance` / `quota` / 速率 …）——见 `planToControlParams`。
 *
 * 为什么 `quota` 恒为 `null`：平台的月度重置边界是"记账自然月"，10 号买的用户
 * 永远拿不到完整 30 天额度。所以额度重置权归 CRM（按每个用户的购买锚点结算），
 * `traffic_balance` 就是唯一的余额账本。
 *
 * 不限量 = `traffic_balance = NULL`：cf-api 的带宽计费对 `NULL` 直接跳过
 * （`packages/tenant/src/modules/customers/bandwidth.ts:263`），不需要额外标志位。
 */

export const PLAN_KINDS = ["period", "traffic", "addon"] as const;
export type PlanKind = (typeof PLAN_KINDS)[number];

export const PLAN_STATUSES = ["draft", "active", "retired"] as const;
export type PlanStatus = (typeof PLAN_STATUSES)[number];

/** 售卖渠道：在**哪儿卖**（与"用什么付钱"的 `payment_method` 不是一回事） */
export const SALES_CHANNELS = ["web_checkout", "apple_iap", "google_play"] as const;
export type SalesChannel = (typeof SALES_CHANNELS)[number];

export interface PlanChannel {
  channel: SalesChannel;
  /** 仅 `web_checkout` 有意义（`alipay` / `wechat` …）；商店通道留空 */
  methods?: string[];
}

export interface Plan {
  id: string;
  name: string;
  kind: PlanKind;
  price_minor: number;
  currency: string;
  licence_limit: number;
  /** period 必填 */
  term_days: number | null;
  /** period 必填；null = 不限量 */
  monthly_quota_gb: number | null;
  /** traffic / addon 必填 */
  traffic_gb: number | null;
  /** traffic 可空：null = 永久有效 */
  validity_days: number | null;
  /** 空数组 = 不限线路；只影响 App 展示，不是权限边界 */
  line_ids: number[];
  up_mbps: number | null;
  down_mbps: number | null;
  sales_channels: PlanChannel[];
  store_product_id: { apple?: string; google?: string };
  sort_order: number;
  status: PlanStatus;
  retired_at: string | null;
}

/** 落账参数 —— 也就是调用 cf-api `PATCH /customers/:id` 的那几个字段 */
export interface ControlParams {
  expire_date: string | null;
  traffic_balance: number | null;
  quota: null;
  up_mbps: number | null;
  down_mbps: number | null;
  licence_limit: number;
}

// ---- 校验 ----

export type ValidationResult =
  | { ok: true; plan: Plan }
  | { ok: false; errors: string[] };

const PLAN_ID_RE = /^[a-z0-9][a-z0-9_-]{1,39}$/;

const num = (v: unknown): number | null => {
  if (v === null || v === undefined || v === "") return null;
  const n = typeof v === "number" ? v : Number(v);
  return Number.isFinite(n) ? n : null;
};

const int = (v: unknown): number | null => {
  const n = num(v);
  return n === null ? null : Math.trunc(n);
};

/**
 * 校验并归一化套餐输入（新建/修改/预览共用）。
 * 返回的错误串是后台直接可读的中文，不要依赖它给终端用户看。
 */
export function validatePlan(input: Record<string, unknown>, opts?: { requireId?: boolean }): ValidationResult {
  const errors: string[] = [];

  const id = typeof input.id === "string" ? input.id.trim() : "";
  if (opts?.requireId !== false && !PLAN_ID_RE.test(id)) {
    errors.push("id 只能是小写字母/数字/下划线/短横线，2–40 位");
  }

  const name = typeof input.name === "string" ? input.name.trim() : "";
  if (!name) errors.push("名称必填");
  if (name.length > 60) errors.push("名称不能超过 60 字");

  const kind = input.kind as PlanKind;
  if (!PLAN_KINDS.includes(kind)) errors.push(`kind 必须是 ${PLAN_KINDS.join(" / ")}`);

  const price_minor = int(input.price_minor);
  if (price_minor === null || price_minor < 0) errors.push("价格必须是非负整数（最小货币单位）");

  const currency = typeof input.currency === "string" ? input.currency.trim().toUpperCase() : "";
  if (!/^[A-Z]{3}$/.test(currency)) errors.push("币种必须是 3 位 ISO 4217 代码");

  const licence_limit = int(input.licence_limit ?? 1);
  if (![1, 2, 3].includes(licence_limit ?? 0)) {
    errors.push("设备数只能是 1 / 2 / 3（平台硬约束）");
  }

  const term_days = int(input.term_days);
  const monthly_quota_gb = num(input.monthly_quota_gb);
  const traffic_gb = num(input.traffic_gb);
  const validity_days = int(input.validity_days);

  if (kind === "period") {
    if (term_days === null || term_days < 1 || term_days > 3650) errors.push("周期套餐必须填 1–3650 天");
    if (monthly_quota_gb !== null && monthly_quota_gb <= 0) errors.push("月度额度必须 > 0（不限量请留空）");
    if (traffic_gb !== null) errors.push("周期套餐不要填 traffic_gb");
  }
  if (kind === "traffic") {
    if (traffic_gb === null || traffic_gb <= 0) errors.push("流量套餐必须填流量（GB）");
    if (validity_days !== null && validity_days < 1) errors.push("有效期至少 1 天（永久请留空）");
    if (term_days !== null || monthly_quota_gb !== null) errors.push("流量套餐不要填周期/月度额度");
  }
  if (kind === "addon") {
    if (traffic_gb === null || traffic_gb <= 0) errors.push("加购包必须填流量（GB）");
    if (validity_days !== null) errors.push("加购包跟随主套餐到期，不能单独设有效期");
    if (term_days !== null || monthly_quota_gb !== null) errors.push("加购包不要填周期/月度额度");
  }


  const rawLines = Array.isArray(input.line_ids) ? input.line_ids : [];
  const line_ids = [...new Set(rawLines.map((v) => int(v)).filter((v): v is number => v !== null && v > 0))];

  const rawChannels = Array.isArray(input.sales_channels) ? input.sales_channels : [];
  const normalizedChannels: PlanChannel[] = [];
  for (const raw of rawChannels) {
    const ch = (raw as PlanChannel | undefined)?.channel;
    if (!ch || !SALES_CHANNELS.includes(ch)) {
      errors.push(`未知售卖渠道：${String(ch)}`);
      continue;
    }
    const methods = Array.isArray((raw as PlanChannel).methods)
      ? [...new Set((raw as PlanChannel).methods!.map((m) => String(m).trim()).filter(Boolean))]
      : undefined;
    normalizedChannels.push(ch === "web_checkout" ? { channel: ch, methods: methods ?? ["alipay"] } : { channel: ch });
  }
  if (!normalizedChannels.length) errors.push("至少选一个售卖渠道");

  const store = (input.store_product_id ?? {}) as Record<string, unknown>;
  const store_product_id: { apple?: string; google?: string } = {};
  if (typeof store.apple === "string" && store.apple.trim()) store_product_id.apple = store.apple.trim();
  if (typeof store.google === "string" && store.google.trim()) store_product_id.google = store.google.trim();
  for (const ch of normalizedChannels) {
    if (ch.channel === "apple_iap" && !store_product_id.apple) errors.push("选了 App Store，必须填 Apple 商品 ID");
    if (ch.channel === "google_play" && !store_product_id.google) errors.push("选了 Google Play，必须填商品 ID");
  }

  if (errors.length) return { ok: false, errors };

  return {
    ok: true,
    plan: {
      id,
      name,
      kind,
      price_minor: price_minor!,
      currency,
      licence_limit: licence_limit!,
      term_days,
      monthly_quota_gb,
      traffic_gb,
      validity_days,
      line_ids,
      up_mbps: int(input.up_mbps),
      down_mbps: int(input.down_mbps),
      sales_channels: normalizedChannels,
      store_product_id,
      sort_order: int(input.sort_order) ?? 0,
      status: (input.status as PlanStatus) ?? "draft",
      retired_at: null,
    },
  };
}

/** 把 `Plan` 摊平成校验函数能吃的形状（PATCH 合并用；字段必须齐全） */
export function planToFields(plan: Plan): Record<string, unknown> {
  return {
    id: plan.id,
    name: plan.name,
    kind: plan.kind,
    price_minor: plan.price_minor,
    currency: plan.currency,
    licence_limit: plan.licence_limit,
    term_days: plan.term_days,
    monthly_quota_gb: plan.monthly_quota_gb,
    traffic_gb: plan.traffic_gb,
    validity_days: plan.validity_days,
    line_ids: plan.line_ids,
    up_mbps: plan.up_mbps,
    down_mbps: plan.down_mbps,
    sales_channels: plan.sales_channels,
    store_product_id: plan.store_product_id,
    sort_order: plan.sort_order,
    status: plan.status,
  };
}

/**
 * `PATCH /api/admin/plans/:id` 的合并规则（**受保护字段写在代码里，不靠调用方自觉**）：
 *
 * - `id` 不可改：订单与订阅都指着它；
 * - `status` / `retired_at` 只能由 `publish` / `retire` 改，不能用一次 PATCH 绕过状态机；
 * - 其余字段允许任意改 —— `plans` 是可变目录，历史由订单/订阅各自的快照保证。
 */
export function applyPlanPatch(current: Plan, patch: Record<string, unknown>): ValidationResult {
  const merged = {
    ...planToFields(current),
    ...patch,
    id: current.id,
    status: current.status,
  };
  const result = validatePlan(merged);
  if (!result.ok) return result;
  return {
    ok: true,
    plan: { ...result.plan, status: current.status, retired_at: current.retired_at },
  };
}

// ---- 落账（plan → cf-api 控制参数） ----

const DAY_MS = 24 * 60 * 60 * 1000;

/** 按天加，返回 `YYYY-MM-DD`（cf-api 的 `expire_date` 是日期串） */
export function addDaysIso(now: Date, days: number): string {
  return new Date(now.getTime() + days * DAY_MS).toISOString().slice(0, 10);
}

/**
 * 新订阅（或换购后重建）要写入 cf-api 的控制参数。
 *
 * | kind | expire_date | traffic_balance |
 * |---|---|---|
 * | period | today + term_days | monthly_quota_gb（null = 不限量） |
 * | traffic | today + validity_days（null = 永久） | traffic_gb |
 *
 * `quota` **恒为 null**：重置权在 CRM，平台不参与。
 */
export function planToControlParams(plan: Plan, now: Date = new Date()): ControlParams {
  if (plan.kind === "period") {
    return {
      expire_date: addDaysIso(now, plan.term_days ?? 0),
      traffic_balance: plan.monthly_quota_gb,
      quota: null,
      up_mbps: plan.up_mbps,
      down_mbps: plan.down_mbps,
      licence_limit: plan.licence_limit,
    };
  }
  if (plan.kind === "traffic") {
    return {
      expire_date: plan.validity_days === null ? null : addDaysIso(now, plan.validity_days),
      traffic_balance: plan.traffic_gb,
      quota: null,
      up_mbps: plan.up_mbps,
      down_mbps: plan.down_mbps,
      licence_limit: plan.licence_limit,
    };
  }
  throw new Error(`addon 不是主订阅，不能直接落账（plan ${plan.id}）`);
}

/**
 * 加购包：只动余额，不动到期日/额度。
 * `current === null` 表示平台侧是不限量（`traffic_balance = NULL`）—— 不允许加购。
 */
export function applyAddon(current: number | null, plan: Plan): number {
  if (plan.kind !== "addon") throw new Error(`plan ${plan.id} 不是加购包`);
  if (current === null) throw new Error("不限量套餐不能加购");
  return current + (plan.traffic_gb ?? 0);
}

// ---- DB 映射 ----

export interface PlanRow {
  id: string;
  name: string;
  kind: string;
  price_minor: number;
  currency: string;
  licence_limit: number;
  term_days: number | null;
  monthly_quota_gb: number | null;
  traffic_gb: number | null;
  validity_days: number | null;
  line_ids: string;
  up_mbps: number | null;
  down_mbps: number | null;
  sales_channels: string;
  store_product_id: string;
  sort_order: number;
  status: string;
  retired_at: string | null;
}

function parseJson<T>(raw: string | null, fallback: T): T {
  if (!raw) return fallback;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

export function rowToPlan(row: PlanRow): Plan {
  return {
    id: row.id,
    name: row.name,
    kind: row.kind as PlanKind,
    price_minor: row.price_minor,
    currency: row.currency,
    licence_limit: row.licence_limit,
    term_days: row.term_days,
    monthly_quota_gb: row.monthly_quota_gb,
    traffic_gb: row.traffic_gb,
    validity_days: row.validity_days,
    line_ids: parseJson<number[]>(row.line_ids, []),
    up_mbps: row.up_mbps,
    down_mbps: row.down_mbps,
    sales_channels: parseJson<PlanChannel[]>(row.sales_channels, []),
    store_product_id: parseJson<Record<string, string>>(row.store_product_id, {}) as Plan["store_product_id"],
    sort_order: row.sort_order,
    status: row.status as PlanStatus,
    retired_at: row.retired_at,
  };
}

/** 对外（App / 后台展示）的形状：与 `app-crm.md` §2.4.7 的 Plan 结构一致 */
export function planForClient(plan: Plan): Record<string, unknown> {
  return {
    plan_id: plan.id,
    name: plan.name,
    kind: plan.kind,
    price_minor: plan.price_minor,
    currency: plan.currency,
    licence_limit: plan.licence_limit,
    term_days: plan.term_days,
    monthly_quota_gb: plan.monthly_quota_gb,
    traffic_gb: plan.traffic_gb,
    validity_days: plan.validity_days,
    line_ids: plan.line_ids,
    speed: plan.up_mbps || plan.down_mbps ? { up_mbps: plan.up_mbps, down_mbps: plan.down_mbps } : null,
    sales_channels: plan.sales_channels,
    store_product_id: plan.store_product_id,
  };
}
