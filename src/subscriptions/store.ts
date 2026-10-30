/**
 * 订阅存储 + 结算任务
 *
 * 结算只做一件"必须由我们做"的事：**周期套餐按用户锚点重置额度**。
 * 平台的 `customers.quota` 恒为 NULL（否则平台会按记账自然月重置，和购买日错位），
 * 所以重置、加购包抵扣都在这里算，算完把新余额 PATCH 回 cf-api。
 *
 * 幂等：`settle()` 只看 `period_settled_at`，跑多少次结果一样；同一小时重复触发不会多给额度。
 */

import { settle } from "../plans/subscription";
import { rowToPlan } from "../plans/model";
import { GIGA, getCustomer, updateCustomer } from "../platform/client";

import type { Env } from "../env";
import type { PlanRow } from "../plans/model";
import type { Hold, Subscription, SubscriptionKind } from "../plans/subscription";

/** 展示/报价可以直接用 `traffic_remaining_gb` 缓存的时长；过期就必须回源 */
export const TRAFFIC_CACHE_TTL_MS = 15 * 60 * 1000;

export interface SubscriptionRow {
  id: number;
  customer_id: number;
  order_id: number | null;
  plan_id: string;
  kind: string;
  hold: string;
  hold_reason: string | null;
  hold_at: string | null;
  paid_minor: number;
  currency: string;
  licence_limit: number;
  period_term_days: number | null;
  period_quota_gb: number | null;
  traffic_total_gb: number | null;
  traffic_validity_days: number | null;
  traffic_remaining_gb: number | null;
  traffic_synced_at: string | null;
  line_ids: string;
  started_at: string;
  expires_at: string | null;
  period_anchor_day: number | null;
  period_extra_gb: number | null;
  period_settled_at: string | null;
  platform_customer_id: number | null;
  activation_code: string | null;
}

const COLUMNS = `id, customer_id, order_id, plan_id, kind, hold, hold_reason, hold_at, paid_minor, currency,
  licence_limit, period_term_days, period_quota_gb, traffic_total_gb, traffic_validity_days,
  traffic_remaining_gb, traffic_synced_at, line_ids, started_at, expires_at,
  period_anchor_day, period_extra_gb, period_settled_at, platform_customer_id, activation_code`;

export function rowToSubscription(row: SubscriptionRow): Subscription {
  let lineIds: number[] = [];
  try {
    lineIds = JSON.parse(row.line_ids) as number[];
  } catch {
    lineIds = [];
  }
  return {
    id: row.id,
    customer_id: row.customer_id,
    order_id: row.order_id,
    plan_id: row.plan_id,
    kind: row.kind as SubscriptionKind,
    hold: row.hold as Hold,
    hold_reason: row.hold_reason,
    hold_at: row.hold_at,
    paid_minor: row.paid_minor,
    currency: row.currency,
    licence_limit: row.licence_limit,
    period_term_days: row.period_term_days,
    period_quota_gb: row.period_quota_gb,
    traffic_total_gb: row.traffic_total_gb,
    traffic_validity_days: row.traffic_validity_days,
    traffic_remaining_gb: row.traffic_remaining_gb,
    traffic_synced_at: row.traffic_synced_at,
    line_ids: Array.isArray(lineIds) ? lineIds : [],
    started_at: row.started_at,
    expires_at: row.expires_at,
    period_anchor_day: row.period_anchor_day,
    period_extra_gb: row.period_extra_gb,
    period_settled_at: row.period_settled_at,
    platform_customer_id: row.platform_customer_id,
    activation_code: row.activation_code,
  };
}

const UPSERT_SQL = `INSERT INTO platform_subscriptions
    (customer_id, order_id, plan_id, kind, hold, hold_reason, hold_at, paid_minor, currency,
     licence_limit, period_term_days, period_quota_gb, traffic_total_gb, traffic_validity_days,
     traffic_remaining_gb, traffic_synced_at, line_ids, started_at, expires_at,
     period_anchor_day, period_extra_gb, period_settled_at, platform_customer_id, activation_code,
     created_at, updated_at)
   VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
   ON CONFLICT(customer_id) DO UPDATE SET
     plan_id = excluded.plan_id, kind = excluded.kind, hold = excluded.hold,
     hold_reason = excluded.hold_reason, hold_at = excluded.hold_at,
     paid_minor = excluded.paid_minor, currency = excluded.currency,
     licence_limit = excluded.licence_limit,
     period_term_days = excluded.period_term_days,
     period_quota_gb = excluded.period_quota_gb,
     traffic_total_gb = excluded.traffic_total_gb,
     traffic_validity_days = excluded.traffic_validity_days,
     traffic_remaining_gb = excluded.traffic_remaining_gb,
     traffic_synced_at = excluded.traffic_synced_at,
     line_ids = excluded.line_ids, started_at = excluded.started_at,
     expires_at = excluded.expires_at, period_anchor_day = excluded.period_anchor_day,
     period_extra_gb = excluded.period_extra_gb,
     period_settled_at = excluded.period_settled_at, updated_at = excluded.updated_at,
     -- 只有“新开”带着非空 order_id 来；续费/加量/升级为 null，不能把来源抹掉
     order_id = COALESCE(excluded.order_id, platform_subscriptions.order_id),
     -- 设备数变了就必须删旧建新（crm-api.md §3.4），旧码立即失效 ⇒ 先置空等重新落账
     activation_code = CASE
       WHEN platform_subscriptions.licence_limit <> excluded.licence_limit THEN NULL
       ELSE platform_subscriptions.activation_code END`;

/**
 * 写入这一行订阅（**一个客户只有一行**，见 `docs/domain.md` §1.2）。
 *
 * 新购 / 续订 / 升级都是"算出一份新快照 → overwrite 这一行"，
 * 差别只在价格与到期日。历史在 `orders` 与 `subscription_changes` 里。
 */
export async function upsertSubscription(env: Env, sub: Subscription): Promise<number> {
  const now = new Date().toISOString();
  await env.DB.prepare(UPSERT_SQL)
    .bind(
      sub.customer_id, sub.order_id, sub.plan_id, sub.kind, sub.hold, sub.hold_reason, sub.hold_at,
      sub.paid_minor, sub.currency, sub.licence_limit,
      sub.period_term_days, sub.period_quota_gb,
      sub.traffic_total_gb, sub.traffic_validity_days,
      sub.traffic_remaining_gb, sub.traffic_synced_at,
      JSON.stringify(sub.line_ids), sub.started_at, sub.expires_at,
      sub.period_anchor_day, sub.period_extra_gb, sub.period_settled_at,
      sub.platform_customer_id, sub.activation_code,
      now, now,
    )
    .run();
  const row = await env.DB.prepare(`SELECT id FROM platform_subscriptions WHERE customer_id = ?`)
    .bind(sub.customer_id)
    .first<{ id: number }>();
  return row?.id ?? 0;
}

export async function loadSubscription(env: Env, id: number): Promise<Subscription | null> {
  const row = await env.DB.prepare(`SELECT ${COLUMNS} FROM platform_subscriptions WHERE id = ?`)
    .bind(id)
    .first<SubscriptionRow>();
  return row ? rowToSubscription(row) : null;
}

/**
 * 这个客户的订阅（单行模型：`null` = 从没买过）。
 *
 * 注意它**不按状态过滤**：状态是算出来的（`statusOf`），到期/用完/冻结都还要用来
 * 报价（续订、升级、退款），所以库里这一行永远取得到。
 */
export async function customerSubscription(
  env: Env,
  customerId: number,
): Promise<Subscription | null> {
  const row = await env.DB.prepare(
    `SELECT ${COLUMNS} FROM platform_subscriptions WHERE customer_id = ?`,
  )
    .bind(customerId)
    .first<SubscriptionRow>();
  return row ? rowToSubscription(row) : null;
}

/** 这个客户的权益变更流水（新的在前）—— 后台客户详情用 */
export async function listChanges(
  env: Env,
  customerId: number,
  limit = 50,
): Promise<Record<string, unknown>[]> {
  const rows = await env.DB.prepare(
    `SELECT * FROM subscription_changes WHERE customer_id = ? ORDER BY id DESC LIMIT ?`,
  )
    .bind(customerId, limit)
    .all<Record<string, unknown>>();
  return rows.results ?? [];
}

/**
 * 记一条权益变更流水。
 *
 * 单行模型下"改之前"会被覆盖，所以 **before / after 必须传**（退款回滚的唯一依据）。
 */
export async function logChange(
  env: Env,
  change: {
    customer_id: number;
    subscription_id: number;
    action: "new" | "renewal" | "upgrade" | "addon" | "settle" | "hold" | "gift";
    before?: Subscription | null;
    after?: Subscription | null;
    paid_minor?: number | null;
    residual_minor?: number | null;
    payable_minor?: number | null;
    detail?: unknown;
  },
): Promise<void> {
  const b = change.before ?? null;
  const a = change.after ?? null;
  await env.DB.prepare(
    `INSERT INTO subscription_changes (at, customer_id, subscription_id, action,
       paid_minor, residual_minor, payable_minor,
       kind_before, kind_after, plan_before, plan_after, expires_before, expires_after,
       period_extra_before, period_extra_after, detail)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  )
    .bind(
      new Date().toISOString(),
      change.customer_id,
      change.subscription_id,
      change.action,
      change.paid_minor ?? null,
      change.residual_minor ?? null,
      change.payable_minor ?? null,
      b?.kind ?? null,
      a?.kind ?? null,
      b?.plan_id ?? null,
      a?.plan_id ?? null,
      b?.expires_at ?? null,
      a?.expires_at ?? null,
      b?.period_extra_gb ?? null,
      a?.period_extra_gb ?? null,
      change.detail === undefined ? null : JSON.stringify(change.detail),
    )
    .run();
}

// ---- 结算任务 ----

export interface SettlementReport {
  scanned: number;
  settled: number;
  failed: number;
  errors: string[];
}

/**
 * 跑一轮结算。返回统计，便于 cron 日志与后台"手动跑一次"按钮共用。
 *
 * 平台调用失败时**不写库**（保持 `last_settled_at` 不变），下一次自动重试；
 * 否则会出现"CRM 认为已重置、平台还是旧余额"的静默错位。
 */
export async function runSettlement(
  env: Env,
  opts: { now?: Date; customerId?: number; dryRun?: boolean } = {},
): Promise<SettlementReport & { items: unknown[] }> {
  const now = opts.now ?? new Date();
  const report: SettlementReport & { items: unknown[] } = {
    scanned: 0,
    settled: 0,
    failed: 0,
    errors: [],
    items: [],
  };

  // 状态是算出来的，所以这里直接按"没被人为停掉 + 还没到期"筛：
  //   hold = 'none' ⇒ 没冻结、没作废；expires_at 为空 = 永久。
  const nowIso = now.toISOString();
  const rows = opts.customerId
    ? await env.DB.prepare(
      `SELECT ${COLUMNS} FROM platform_subscriptions
       WHERE hold = 'none' AND kind = 'period' AND customer_id = ?
         AND (expires_at IS NULL OR expires_at > ?)`,
    ).bind(opts.customerId, nowIso).all<SubscriptionRow>()
    : await env.DB.prepare(
      `SELECT ${COLUMNS} FROM platform_subscriptions
       WHERE hold = 'none' AND kind = 'period'
         AND (expires_at IS NULL OR expires_at > ?)
       ORDER BY id`,
    ).bind(nowIso).all<SubscriptionRow>();

  for (const row of rows.results ?? []) {
    report.scanned += 1;
    const sub = rowToSubscription(row);
    const plan = await loadPlanSnapshot(env, sub.plan_id);
    if (!plan) {
      report.failed += 1;
      report.errors.push(`#${sub.id} 套餐 ${sub.plan_id} 已不存在`);
      continue;
    }

    // 还没落账（付款后 cf-api 没通）：跳过，交给 retryProvisioning 处理，不算失败
    if (!sub.platform_customer_id) continue;

    // 平台余额从这里读；拿不到就**跳过本轮**（不能拿"以为的值"去重置）。
    // 跳过不是错：下一小时会重试，而且宁可晚一期重置，也不能凭空造额度。
    const read = await readPlatformBalance(env, sub);
    if (!read.ok || read.gb === null) {
      report.failed += 1;
      report.errors.push(
        `#${sub.id} 读不到平台余额（${read.error ?? "平台未写余额"}），跳过`,
      );
      continue;
    }
    const result = settle(
      {
        period_quota_gb: sub.period_quota_gb,
        period_extra_gb: sub.period_extra_gb,
        platform_balance_gb: read.gb,
        period_anchor_day: sub.period_anchor_day,
        period_settled_at: sub.period_settled_at,
        expires_at: sub.expires_at,
      },
      now,
    );

    if (!result.due) continue;

    report.items.push({
      subscription_id: sub.id,
      period_quota_gb: sub.period_quota_gb,
      period_extra_gb: sub.period_extra_gb,
      period_extra_after: result.period_extra_gb,
      platform_balance_gb: result.platform_balance_gb,
      skipped_periods: result.skipped_periods,
    });

    if (opts.dryRun) {
      report.settled += 1;
      continue;
    }

    const written = await writePlatformBalance(env, sub, result.platform_balance_gb);
    if (!written.ok) {
      report.failed += 1;
      report.errors.push(`#${sub.id} 平台写入失败：${written.error}`);
      continue;
    }

    // 刚写过平台，余额就是我们刚算的值 ⇒ 顺手把缓存对齐，下次展示不必再回源
    await env.DB.prepare(
      `UPDATE platform_subscriptions
       SET period_extra_gb = ?, period_settled_at = ?,
           traffic_remaining_gb = ?, traffic_synced_at = ?, updated_at = ?
       WHERE id = ?`,
    )
      .bind(
        result.period_extra_gb,
        result.period_settled_at,
        result.platform_balance_gb,
        nowIso,
        nowIso,
        sub.id,
      )
      .run();

    await logChange(env, {
      customer_id: sub.customer_id,
      subscription_id: sub.id,
      action: "settle",
      before: sub,
      after: {
        ...sub,
        period_extra_gb: result.period_extra_gb,
        period_settled_at: result.period_settled_at,
      },
      detail: { skipped_periods: result.skipped_periods, period_quota_gb: sub.period_quota_gb },
    });

    report.settled += 1;
  }

  return report;
}

async function loadPlanSnapshot(env: Env, planId: string) {
  const row = await env.DB.prepare(
    `SELECT id, name, kind, price_minor, currency, licence_limit, term_days, monthly_quota_gb,
       traffic_gb, validity_days, line_ids, up_mbps, down_mbps, sales_channels,
       store_product_id, sort_order, status, retired_at
     FROM plans WHERE id = ?`,
  ).bind(planId).first<PlanRow>();
  return row ? rowToPlan(row) : null;
}

/**
 * 平台侧当前余额的读取结果。
 *
 * `ok` 与 `gb` 必须分开：`gb === null` 有两层含义（不限量 / 平台还没写），
 * 而“读不到”是另一回事 —— 把它俩混成一个 null 会让结算把不限量也当失败。
 */
export interface PlatformBalance {
  ok: boolean;
  /** 换算成 GB；null = 平台上就是空（不限量 / 尚未写） */
  gb: number | null;
  error?: string;
}

/** 平台侧当前余额，**换算成 GB**（cf-api 存的是字节） */
export async function readPlatformBalance(
  env: Env,
  sub: Subscription,
): Promise<PlatformBalance> {
  if (!sub.platform_customer_id) return { ok: false, gb: null, error: "尚未落账" };
  try {
    const customer = await getCustomer(env, sub.platform_customer_id);
    return { ok: true, gb: customer.traffic_balance === null ? null : customer.traffic_balance / GIGA };
  } catch (e) {
    return { ok: false, gb: null, error: e instanceof Error ? e.message : String(e) };
  }
}

/** 缓存还能直接用吗（展示 / 报价容忍 TTL 内的旧值） */
export function trafficCacheFresh(sub: Subscription, now: Date = new Date()): boolean {
  if (!sub.traffic_synced_at) return false;
  const at = Date.parse(sub.traffic_synced_at);
  return Number.isFinite(at) && now.getTime() - at < TRAFFIC_CACHE_TTL_MS;
}

/**
 * **强制**回源一次平台余额，并写进缓存（`traffic_remaining_gb` + `traffic_synced_at`）。
 *
 * 两种场合必须用它，不能用缓存：
 *   1. 往平台写余额之前（加量包、改额度）—— 否则会把用户已用掉的流量还回去；
 *   2. 慢眼结算（月结）—— 那一轮本身就是拿真相算账。
 *
 * 读不到平台就回 `null`（**不写库**）：调用方必须把这次操作当作“还没成”去重试。
 */
export async function freshenTraffic(
  env: Env,
  sub: Subscription,
  opts: { now?: Date } = {},
): Promise<Subscription | null> {
  const now = opts.now ?? new Date();
  const read = await readPlatformBalance(env, sub);
  if (!read.ok) return null;
  const at = now.toISOString();
  await env.DB.prepare(
    `UPDATE platform_subscriptions
     SET traffic_remaining_gb = ?, traffic_synced_at = ?, updated_at = ?
     WHERE id = ?`,
  )
    .bind(read.gb, at, at, sub.id)
    .run();
  return { ...sub, traffic_remaining_gb: read.gb, traffic_synced_at: at };
}

/**
 * 展示 / 报价用：缓存过期才回源，拿不到就用旧值（宁可显示旧数字，也不让页面报错）。
 */
export async function ensureTrafficFresh(
  env: Env,
  sub: Subscription,
  now: Date = new Date(),
): Promise<Subscription> {
  if (trafficCacheFresh(sub, now)) return sub;
  return (await freshenTraffic(env, sub, { now })) ?? sub;
}

/** 把新的剩余额度写回平台（GB → 字节） */
async function writePlatformBalance(
  env: Env,
  sub: Subscription,
  balanceGb: number | null,
): Promise<{ ok: boolean; error?: string }> {
  if (!sub.platform_customer_id) {
    return { ok: false, error: "没有 platform_customer_id（尚未落账）" };
  }
  try {
    await updateCustomer(env, sub.platform_customer_id, {
      // 单位：cf-api 的 traffic_balance 是**字节**
      traffic_balance: balanceGb === null ? null : Math.round(balanceGb * GIGA),
    });
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}
