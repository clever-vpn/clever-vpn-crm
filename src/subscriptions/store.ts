/**
 * 订阅存储 + 结算任务
 *
 * 结算只做一件"必须由我们做"的事：**周期套餐按用户锚点重置额度**。
 * 平台的 `customers.quota` 恒为 NULL（否则平台会按记账自然月重置，和购买日错位），
 * 所以重置、加购包抵扣都在这里算，算完把新余额 PATCH 回 cf-api。
 *
 * 幂等：`settle()` 只看 `last_settled_at`，跑多少次结果一样；同一小时重复触发不会多给额度。
 */

import { settle } from "../plans/subscription";
import { rowToPlan } from "../plans/model";

import type { Env } from "../env";
import type { PlanRow } from "../plans/model";
import type { Subscription, SubscriptionKind, SubscriptionStatus } from "../plans/subscription";

export interface SubscriptionRow {
  id: number;
  customer_id: number;
  plan_id: string;
  kind: string;
  status: string;
  paid_minor: number;
  currency: string;
  licence_limit: number;
  term_days: number | null;
  quota_gb: number | null;
  traffic_total_gb: number | null;
  validity_days: number | null;
  allow_addons: number;
  line_ids: string;
  started_at: string;
  expires_at: string | null;
  anchor_day: number | null;
  balance_gb: number | null;
  remaining_gb: number | null;
  last_settled_at: string | null;
  platform_customer_id: number | null;
}

const COLUMNS = `id, customer_id, plan_id, kind, status, paid_minor, currency, licence_limit,
  term_days, quota_gb, traffic_total_gb, validity_days, allow_addons, line_ids, started_at,
  expires_at, anchor_day, balance_gb, remaining_gb, last_settled_at, platform_customer_id`;

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
    plan_id: row.plan_id,
    kind: row.kind as SubscriptionKind,
    status: row.status as SubscriptionStatus,
    paid_minor: row.paid_minor,
    currency: row.currency,
    licence_limit: row.licence_limit,
    term_days: row.term_days,
    quota_gb: row.quota_gb,
    traffic_total_gb: row.traffic_total_gb,
    validity_days: row.validity_days,
    allow_addons: row.allow_addons === 1,
    line_ids: Array.isArray(lineIds) ? lineIds : [],
    started_at: row.started_at,
    expires_at: row.expires_at,
    anchor_day: row.anchor_day,
    balance_gb: row.balance_gb,
    remaining_gb: row.remaining_gb,
    last_settled_at: row.last_settled_at,
    platform_customer_id: row.platform_customer_id,
  };
}

export async function insertSubscription(
  env: Env,
  sub: Omit<Subscription, "id">,
): Promise<number> {
  const now = new Date().toISOString();
  const res = await env.DB.prepare(
    `INSERT INTO platform_subscriptions (customer_id, plan_id, kind, status, paid_minor, currency,
       licence_limit, term_days, quota_gb, traffic_total_gb, validity_days, allow_addons, line_ids,
       started_at, expires_at, anchor_day, balance_gb, remaining_gb, last_settled_at,
       platform_customer_id, code, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?)`,
  )
    .bind(
      sub.customer_id, sub.plan_id, sub.kind, sub.status, sub.paid_minor, sub.currency,
      sub.licence_limit, sub.term_days, sub.quota_gb, sub.traffic_total_gb, sub.validity_days,
      sub.allow_addons ? 1 : 0, JSON.stringify(sub.line_ids), sub.started_at, sub.expires_at,
      sub.anchor_day, sub.balance_gb, sub.remaining_gb, sub.last_settled_at,
      sub.platform_customer_id, now, now,
    )
    .run();
  return Number(res.meta.last_row_id ?? 0);
}

export async function loadSubscription(env: Env, id: number): Promise<Subscription | null> {
  const row = await env.DB.prepare(`SELECT ${COLUMNS} FROM platform_subscriptions WHERE id = ?`)
    .bind(id)
    .first<SubscriptionRow>();
  return row ? rowToSubscription(row) : null;
}

/** 当前生效的主订阅（period / traffic）；`null` = 没有 */
export async function currentMainSubscription(
  env: Env,
  customerId: number,
): Promise<Subscription | null> {
  const row = await env.DB.prepare(
    `SELECT ${COLUMNS} FROM platform_subscriptions
     WHERE customer_id = ? AND status = 'active' AND kind IN ('period','traffic')
     ORDER BY id DESC LIMIT 1`,
  )
    .bind(customerId)
    .first<SubscriptionRow>();
  return row ? rowToSubscription(row) : null;
}

export async function listSubscriptions(
  env: Env,
  customerId: number,
): Promise<Subscription[]> {
  const rows = await env.DB.prepare(
    `SELECT ${COLUMNS} FROM platform_subscriptions WHERE customer_id = ? ORDER BY id DESC`,
  )
    .bind(customerId)
    .all<SubscriptionRow>();
  return (rows.results ?? []).map(rowToSubscription);
}

export async function logChange(
  env: Env,
  change: {
    customer_id: number;
    action: string;
    from_subscription_id?: number | null;
    to_subscription_id?: number | null;
    paid_minor?: number | null;
    residual_minor?: number | null;
    payable_minor?: number | null;
    balance_before?: number | null;
    balance_after?: number | null;
    detail?: unknown;
  },
): Promise<void> {
  await env.DB.prepare(
    `INSERT INTO subscription_changes (at, customer_id, from_subscription_id, to_subscription_id,
       action, paid_minor, residual_minor, payable_minor, balance_before, balance_after, detail)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  )
    .bind(
      new Date().toISOString(),
      change.customer_id,
      change.from_subscription_id ?? null,
      change.to_subscription_id ?? null,
      change.action,
      change.paid_minor ?? null,
      change.residual_minor ?? null,
      change.payable_minor ?? null,
      change.balance_before ?? null,
      change.balance_after ?? null,
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

  const rows = opts.customerId
    ? await env.DB.prepare(
      `SELECT ${COLUMNS} FROM platform_subscriptions
       WHERE status = 'active' AND kind = 'period' AND customer_id = ?`,
    ).bind(opts.customerId).all<SubscriptionRow>()
    : await env.DB.prepare(
      `SELECT ${COLUMNS} FROM platform_subscriptions
       WHERE status = 'active' AND kind = 'period' ORDER BY id`,
    ).all<SubscriptionRow>();

  for (const row of rows.results ?? []) {
    report.scanned += 1;
    const sub = rowToSubscription(row);
    const plan = await loadPlanSnapshot(env, sub.plan_id);
    if (!plan) {
      report.failed += 1;
      report.errors.push(`#${sub.id} 套餐 ${sub.plan_id} 已不存在`);
      continue;
    }

    // 平台余额从这里读；拿不到就跳过（不要用"以为的值"结算）
    const platformBalance = await readPlatformBalance(env, sub);
    const result = settle(
      {
        quota_gb: sub.quota_gb,
        balance_gb: sub.balance_gb,
        platform_balance_gb: platformBalance,
        anchor_day: sub.anchor_day,
        last_settled_at: sub.last_settled_at,
        expires_at: sub.expires_at,
      },
      now,
    );

    if (!result.due) continue;

    report.items.push({
      subscription_id: sub.id,
      quota_gb: sub.quota_gb,
      balance_gb: sub.balance_gb,
      balance_after: result.balance_gb,
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

    await env.DB.prepare(
      `UPDATE platform_subscriptions
       SET balance_gb = ?, last_settled_at = ?, updated_at = ? WHERE id = ?`,
    )
      .bind(result.balance_gb, result.last_settled_at, now.toISOString(), sub.id)
      .run();

    await logChange(env, {
      customer_id: sub.customer_id,
      action: "settle",
      to_subscription_id: sub.id,
      balance_before: sub.balance_gb,
      balance_after: result.balance_gb,
      detail: { skipped_periods: result.skipped_periods, quota_gb: sub.quota_gb },
    });

    report.settled += 1;
  }

  return report;
}

async function loadPlanSnapshot(env: Env, planId: string) {
  const row = await env.DB.prepare(
    `SELECT id, name, kind, price_minor, currency, licence_limit, term_days, monthly_quota_gb,
       traffic_gb, validity_days, allow_addons, line_ids, up_mbps, down_mbps, channels,
       store_product_id, sort_order, status, retired_at
     FROM plans WHERE id = ?`,
  ).bind(planId).first<PlanRow>();
  return row ? rowToPlan(row) : null;
}

/** 平台侧余额。本地开发没有 `CF_API_TOKEN` 时返回 `null`（结算会被跳过并记错）。 */
async function readPlatformBalance(
  env: Env,
  sub: Subscription,
): Promise<number | null> {
  if (!env.CF_API_TOKEN || !sub.platform_customer_id) return null;
  const res = await fetch(
    `${env.CF_API_BASE}/api/v1/customers/${sub.platform_customer_id}`,
    { headers: { Authorization: `Bearer ${env.CF_API_TOKEN}` } },
  ).catch(() => null);
  if (!res?.ok) return null;
  const body = (await res.json().catch(() => null)) as { data?: { traffic_balance?: number | null } } | null;
  return body?.data?.traffic_balance ?? null;
}

async function writePlatformBalance(
  env: Env,
  sub: Subscription,
  balance: number | null,
): Promise<{ ok: boolean; error?: string }> {
  if (!env.CF_API_TOKEN || !sub.platform_customer_id) {
    return { ok: false, error: "missing CF_API_TOKEN 或 platform_customer_id" };
  }
  const res = await fetch(
    `${env.CF_API_BASE}/api/v1/customers/${sub.platform_customer_id}`,
    {
      method: "PATCH",
      headers: {
        Authorization: `Bearer ${env.CF_API_TOKEN}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ traffic_balance: balance }),
    },
  ).catch(() => null);
  if (!res?.ok) return { ok: false, error: `HTTP ${res?.status ?? "network"}` };
  return { ok: true };
}
