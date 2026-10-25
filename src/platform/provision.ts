/**
 * 落账：把 CRM 的订阅快照写成 cf-api 的**控制参数**（`crm-api.md` §3）
 *
 * 三条硬约束，每一条都有翻车代价：
 *
 *   1. `licence_limit` **创建后不可改** ⇒ 变了只能「删旧建新」（同一 `auth_id`），
 *      旧 `code` 立即失效，平台级联软删其 licences。
 *   2. 流量单位是**字节**（`1 GiB = 1024³`），不是 GB。写成 100 而不是 100×2³⁰，
 *      客户付完钱就会立刻断网。
 *   3. `quota` **恒为 NULL**：月度重置归 CRM（按用户购买锚点），平台只在 `quota`
 *      非空时才会按月重置，那是"记账自然月"，会给 10 号买的用户少半个月。
 *
 * 幂等：`auth_id = crm:<customer_id>`，跨换档不变；重复调用只会 PATCH 或复用既有客户。
 */

import {
  createCustomer,
  deleteCustomer,
  findCustomerByAuthId,
  getCustomer,
  updateCustomer,
  PlatformError,
  GIGA,
} from "./client";
import { loadSubscription } from "../subscriptions/store";

import type { Env } from "../env";
import type { Subscription } from "../plans/subscription";

/** 1 GiB = 1024³ 字节（定义在 `client.ts`，这里重导出方便引用） */
export { GIGA };

export interface Provisioned {
  platformCustomerId: number;
  code: string;
}

/** CRM 侧的稳定幂等键：一个客户一个，换档不换 */
export function authIdOf(customerId: number): string {
  return `crm:${customerId}`;
}

/**
 * 订阅快照 → 控制参数。
 * **不含 `licence_limit`**（不可改，变了要删旧建新）。
 */
export function controlParams(sub: Subscription): Record<string, unknown> {
  return {
    // 冻结/作废是"人的意图"，必须同步到平台，否则用户照样能连
    frozen: sub.hold === "none" ? 0 : 1,
    expire_date: sub.expires_at ? sub.expires_at.slice(0, 10) : null,
    // 平台自带的月度重置要关掉：重置权在 CRM
    quota: null,
    traffic_balance: trafficBytes(sub),
  };
}

/**
 * 剩余额度（**字节**）；`null` = 不限量（cf-api 侧等于不计费）。
 *
 * - `traffic`：剩余 GB（未同步时退化为整包容量，宁可多给不可误杀）
 * - `period`：本周期额度 + 加购包余额（不变量 `R = P + B`）
 */
export function trafficBytes(sub: Subscription): number | null {
  if (sub.kind === "traffic") {
    if (sub.traffic_total_gb === null) return null;
    const gb = sub.remaining_gb ?? sub.traffic_total_gb;
    return Math.max(0, Math.round(gb * GIGA));
  }
  if (sub.quota_gb === null) return null;
  const gb = sub.quota_gb + (sub.balance_gb ?? 0);
  return Math.max(0, Math.round(gb * GIGA));
}

interface CustomerIdentity {
  name: string;
  email: string | null;
}

async function identityOf(env: Env, customerId: number): Promise<CustomerIdentity> {
  const row = await env.DB.prepare(
    `SELECT email, display_name FROM customers WHERE id = ?`,
  )
    .bind(customerId)
    .first<{ email: string; display_name: string | null }>();
  return {
    name: row?.display_name ?? row?.email ?? `customer-${customerId}`,
    email: row?.email ?? null,
  };
}

/**
 * 把一条订阅落账到 cf-api。
 * 已有平台客户且 `licence_limit` 未变 → PATCH；变了或不存在 → 建新（必要时先删旧）。
 */
export async function provisionSubscription(env: Env, sub: Subscription): Promise<Provisioned> {
  const authId = authIdOf(sub.customer_id);
  const params = controlParams(sub);

  // ── 1) 已绑定：能原地改就改，改不了才换 ──
  if (sub.platform_customer_id) {
    const existing = await getCustomer(env, sub.platform_customer_id).catch((e: unknown) => {
      // 平台侧已被删（手工清理等）：当没有处理
      if (e instanceof PlatformError && e.status === 404) return null;
      throw e;
    });

    if (existing && existing.licence_limit === sub.licence_limit) {
      const updated = await updateCustomer(env, existing.id, params);
      return { platformCustomerId: updated.id, code: updated.code ?? existing.code };
    }
    if (existing) {
      // 换档：设备数是计费依据，平台不允许改 → 删旧建新（crm-api.md §3.4）
      await deleteCustomer(env, existing.id);
    }
  }

  // ── 2) 建新（先按 auth_id 查重：重试时可能已经建过了）──
  const claimed = await findCustomerByAuthId(env, authId);
  if (claimed) {
    if (claimed.licence_limit === sub.licence_limit) {
      const updated = await updateCustomer(env, claimed.id, params);
      return { platformCustomerId: updated.id, code: updated.code ?? claimed.code };
    }
    await deleteCustomer(env, claimed.id);
  }

  const identity = await identityOf(env, sub.customer_id);
  const created = await createCustomer(env, {
    ...identity,
    auth_id: authId,
    licence_limit: sub.licence_limit,
    ...params,
  });
  return { platformCustomerId: created.id, code: created.code };
}

/**
 * 按订单落账并标记完成。**失败不吞异常**——订单保持 `provisioning`，
 * 由 cron 重试（钱已经收了，绝不能回退订单状态）。
 */
export async function provisionOrder(env: Env, orderId: number): Promise<void> {
  const order = await env.DB.prepare(`SELECT subscription_id FROM orders WHERE id = ?`)
    .bind(orderId)
    .first<{ subscription_id: number | null }>();
  if (!order?.subscription_id) throw new Error(`订单 ${orderId} 没有关联订阅`);

  const sub = await loadSubscription(env, order.subscription_id);
  if (!sub) throw new Error(`订阅 ${order.subscription_id} 不存在`);

  const provisioned = await provisionSubscription(env, sub);
  const now = new Date().toISOString();

  await env.DB.batch([
    env.DB.prepare(
      `UPDATE platform_subscriptions SET platform_customer_id = ?, code = ? WHERE id = ?`,
    ).bind(provisioned.platformCustomerId, provisioned.code, sub.id),
    env.DB.prepare(
      `UPDATE orders SET status = 'active', provisioned_at = ?, provision_error = NULL, updated_at = ?
        WHERE id = ? AND status = 'provisioning'`,
    ).bind(now, now, orderId),
  ]);
}

/**
 * 重试所有卡在 `provisioning` 的订单（cron 每小时一次）。
 * @returns 成功 / 失败条数
 */
export async function retryProvisioning(
  env: Env,
  opts: { limit?: number } = {},
): Promise<{ retried: number; failed: number }> {
  const limit = opts.limit ?? 20;
  const rows = await env.DB.prepare(
    `SELECT id FROM orders
      WHERE status = 'provisioning' AND subscription_id IS NOT NULL
      ORDER BY id ASC LIMIT ?`,
  )
    .bind(limit)
    .all<{ id: number }>();

  let retried = 0;
  let failed = 0;
  for (const { id } of rows.results ?? []) {
    try {
      await provisionOrder(env, id);
      retried += 1;
    } catch (e) {
      failed += 1;
      const msg = e instanceof Error ? e.message : String(e);
      await env.DB.prepare(
        `UPDATE orders SET provision_attempts = provision_attempts + 1,
           provision_error = ?, updated_at = ? WHERE id = ?`,
      )
        .bind(msg.slice(0, 500), new Date().toISOString(), id)
        .run();
      console.error(`[provision] 重试失败 order=${id}: ${msg}`);
    }
  }
  return { retried, failed };
}
