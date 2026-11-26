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
 *   4. `line_ids` 是**线路权益**，与到期日/流量同级：绝对值投影（`[]` → `null` = 全部），
 *      平台据此过滤 `key-lines` 并在发放许可时校验。
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

/**
 * 这次落账是哪种动作 —— **决定写哪些字段**，不是在决定价格（价格在 `plans/quote.ts`）。
 *
 * - `new` / `upgrade`：开了新周期（或刚建客户）⇒ 全量投影
 * - `renewal`：周期没变 ⇒ period 只延到期日、traffic 只加余额
 * - `addon`：只加余额（不动到期日）
 */
export type ProvisionAction = "new" | "renewal" | "upgrade" | "addon";

const PROVISION_ACTIONS: readonly ProvisionAction[] = ["new", "renewal", "upgrade", "addon"];

/** 库里的文本 → 动作；未知/空（存量单）按 `new`，与旧行为一致 */
export function asProvisionAction(value: unknown): ProvisionAction {
  return PROVISION_ACTIONS.includes(value as ProvisionAction) ? (value as ProvisionAction) : "new";
}

export interface Provisioned {
  platformCustomerId: number;
  code: string;
  /**
   * 本次**实际写给平台**的余额（GB；`null` = 不限量）。
   * `undefined` = 本次没碰余额 ⇒ 本地缓存不该动。
   */
  balanceGb?: number | null;
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
    // 线路权益（绝对值投影）：空 = 全部线路（含以后新增的）；有值 = 只允许这些 id
    line_ids: sub.line_ids.length ? sub.line_ids : null,
  };
}

/**
 * 剩余额度（**字节**）；`null` = 不限量（cf-api 侧等于不计费）。
 *
 * - `traffic`：剩余 GB（尚未同步时退化为整包容量，宁可多给不可误杀）
 * - `period`：本周期额度 + 额外流量池（不变量 `R = P + B`）
 */
export function trafficBytes(sub: Subscription): number | null {
  if (sub.kind === "traffic") {
    if (sub.traffic_total_gb === null) return null;
    const gb = sub.traffic_remaining_gb ?? sub.traffic_total_gb;
    return Math.max(0, Math.round(gb * GIGA));
  }
  if (sub.period_quota_gb === null) return null;
  const gb = sub.period_quota_gb + (sub.period_extra_gb ?? 0);
  return Math.max(0, Math.round(gb * GIGA));
}

/** 同一个口径的 GB 值（给本地缓存用）；`null` = 不限量 */
function balanceGbOf(sub: Subscription): number | null {
  const bytes = trafficBytes(sub);
  return bytes === null ? null : bytes / GIGA;
}

/** GB → 字节；`null` = 不限量（cf-api 侧等于不计费） */
function gbToBytes(gb: number | null): number | null {
  return gb === null ? null : Math.max(0, Math.round(gb * GIGA));
}

/**
 * 已存在的客户：**只写这次真的变了的字段**。
 *
 * 为什么不能一律全量：`traffic_balance` 的全量值是"这个周期满额 `P+B`"，
 * 而续订/加量时周期没变、平台上的真实剩余已经小于满额 —— 全量写回去
 * 等于把用户已用掉的流量还给他（`docs/domain.md` I4）。
 *
 *   - `renewal` + period：只延到期日（额度、池子、余额、锚点都不动）
 *   - `renewal` + traffic：延到期日 + 加上新余额（`remaining` 已由调用方回源并 +gb）
 *   - `addon`：只加余额（不动到期日）
 *   - `new` / `upgrade`：全量（开了新周期，满额是对的）—— 见 `controlParams`
 */
export function patchParams(sub: Subscription, action: ProvisionAction): Record<string, unknown> {
  if (action === "new" || action === "upgrade") return controlParams(sub);

  if (action === "addon") {
    return { traffic_balance: gbToBytes(sub.traffic_remaining_gb) };
  }

  const patch: Record<string, unknown> = {
    expire_date: sub.expires_at ? sub.expires_at.slice(0, 10) : null,
  };
  if (sub.kind === "traffic") patch.traffic_balance = gbToBytes(sub.traffic_remaining_gb);
  return patch;
}

/** 这次写入实际落了哪个余额（GB）——`undefined` = 没写，缓存别动 */
function balanceAfter(sub: Subscription, action: ProvisionAction): number | null | undefined {
  if (action === "new" || action === "upgrade") return balanceGbOf(sub);
  if (action === "renewal" && sub.kind === "period") return undefined;
  return sub.traffic_remaining_gb;
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
 * 把一条订阅落账到 cf-api（**不写本地**，写回见 `provisionSubscriptionNow`）。
 *
 * 已有平台客户且 `licence_limit` 未变 → PATCH（只写这次变了的字段）；
 * 变了或不存在 → 建新（必要时先删旧，新客户必须**全量**参数）。
 */
export async function provisionSubscription(
  env: Env,
  sub: Subscription,
  action: ProvisionAction = "new",
): Promise<Provisioned> {
  const authId = authIdOf(sub.customer_id);
  const patch = patchParams(sub, action);

  // ── 1) 已绑定：能原地改就改，改不了才换 ──
  if (sub.platform_customer_id) {
    const existing = await getCustomer(env, sub.platform_customer_id).catch((e: unknown) => {
      // 平台侧已被删（手工清理等）：当没有处理
      if (e instanceof PlatformError && e.status === 404) return null;
      throw e;
    });

    if (existing && existing.licence_limit === sub.licence_limit) {
      const updated = await updateCustomer(env, existing.id, patch);
      return {
        platformCustomerId: updated.id,
        code: updated.code ?? existing.code,
        balanceGb: balanceAfter(sub, action),
      };
    }
    if (existing) {
      // 换档：设备数是计费依据，平台不允许改 → 删旧建新（crm-api.md §3.4）
      await deleteCustomer(env, existing.id);
    }
  }

  // ── 2) 建新（先按 auth_id 查重：重试时可能已经建过了）──
  const claimed = await findCustomerByAuthId(env, authId);
  if (claimed) {
    // 认回之前先确认这确实是"我们的人"：跨实例共用一把租户 token 时，
    // 只按 id 认回会接管别人的客户（`auth_id` 里没有实例前缀）。
    if (claimed.auth_id !== authId) {
      throw new Error(
        `平台客户 ${claimed.id} 的 auth_id 是 ${claimed.auth_id ?? "(空)"}，不是 ${authId}——拒绝认回`,
      );
    }
    if (claimed.licence_limit === sub.licence_limit) {
      const updated = await updateCustomer(env, claimed.id, patch);
      return {
        platformCustomerId: updated.id,
        code: updated.code ?? claimed.code,
        balanceGb: balanceAfter(sub, action),
      };
    }
    await deleteCustomer(env, claimed.id);
  }

  const identity = await identityOf(env, sub.customer_id);
  const created = await createCustomer(env, {
    ...identity,
    auth_id: authId,
    licence_limit: sub.licence_limit,
    // 新建必须全量：cf-api 里缺的参数等于"永久 / 不限量 / 全部线路"（fail-open）
    ...controlParams(sub),
  });
  return {
    platformCustomerId: created.id,
    code: created.code,
    balanceGb: balanceGbOf(sub),
  };
}

/**
 * 落账 + 把 `platform_customer_id`/`activation_code`（以及余额缓存）写回本地。
 *
 * **不碰订单** —— 三条入口共用：订单落账、登录时发现平台客户丢失、后台「重新落账」。
 */
export async function provisionSubscriptionNow(
  env: Env,
  sub: Subscription,
  action: ProvisionAction = "new",
): Promise<Provisioned> {
  const provisioned = await provisionSubscription(env, sub, action);
  const now = new Date().toISOString();

  const sets = ["platform_customer_id = ?", "activation_code = ?", "updated_at = ?"];
  const binds: unknown[] = [provisioned.platformCustomerId, provisioned.code, now];
  // 写了余额就顺手把缓存对齐：否则展示/报价会继续用旧剩余，直到 15 分钟后自己纠正
  if (provisioned.balanceGb !== undefined) {
    sets.push("traffic_remaining_gb = ?", "traffic_synced_at = ?");
    binds.push(provisioned.balanceGb, now);
  }
  binds.push(sub.id);

  await env.DB.prepare(`UPDATE platform_subscriptions SET ${sets.join(", ")} WHERE id = ?`)
    .bind(...binds)
    .run();

  return provisioned;
}

/**
 * 按订单落账并标记完成。**失败不吞异常**——订单保持 `provisioning`，
 * 由 cron 重试（钱已经收了，绝不能回退订单状态）。
 *
 * `action` 由 `settlePaidOrder` 传入；cron 重试时从 `orders.provision_action` 读回
 * ——重试必须用**同一种写法**，否则续订会被写成"新周期满额"。
 */
export async function provisionOrder(
  env: Env,
  orderId: number,
  action?: ProvisionAction,
): Promise<void> {
  const order = await env.DB.prepare(
    `SELECT subscription_id, provision_action FROM orders WHERE id = ?`,
  )
    .bind(orderId)
    .first<{ subscription_id: number | null; provision_action: string | null }>();
  if (!order?.subscription_id) throw new Error(`订单 ${orderId} 没有关联订阅`);

  const sub = await loadSubscription(env, order.subscription_id);
  if (!sub) throw new Error(`订阅 ${order.subscription_id} 不存在`);

  await provisionSubscriptionNow(env, sub, action ?? asProvisionAction(order.provision_action));

  const now = new Date().toISOString();
  await env.DB.prepare(
    `UPDATE orders SET status = 'active', provisioned_at = ?, provision_error = NULL, updated_at = ?
      WHERE id = ? AND status = 'provisioning'`,
  )
    .bind(now, now, orderId)
    .run();
}

/**
 * 登录时的一次性自检：平台客户还在不在。**绝不抛**——登录不能因为 cf-api 故障失败。
 *
 * 只有 404 才重建（"平台行被误删"）。超时 / 429 / 5xx 一律不动：把"平台暂时不可用"
 * 当成"被删了"，会白换一次码（换码 = 所有设备要重新取许可）。
 *
 * 重建按当前订阅**全量**写（`new`）：这是我们的运维事故，宁可多给（本周期满额）
 * 也不能修完还是不能用。退款撤销 / 已到期的订阅重建出来仍是 `frozen=1` / 已过期，
 * 不会被重登"复活"。
 */
export async function repairPlatformIfMissing(
  env: Env,
  sub: Subscription | null,
): Promise<Subscription | null> {
  if (!sub) return null;

  if (sub.platform_customer_id) {
    try {
      await getCustomer(env, sub.platform_customer_id);
      return sub;
    } catch (e) {
      if (!(e instanceof PlatformError && e.status === 404)) return sub;
    }
  }

  try {
    const provisioned = await provisionSubscriptionNow(env, sub, "new");
    console.warn(
      `[platform] 重建客户 customer=${sub.customer_id} 旧=${sub.platform_customer_id ?? "-"} 新=${provisioned.platformCustomerId}`,
    );
    return {
      ...sub,
      platform_customer_id: provisioned.platformCustomerId,
      activation_code: provisioned.code,
      ...(provisioned.balanceGb === undefined
        ? {}
        : { traffic_remaining_gb: provisioned.balanceGb }),
    };
  } catch (e) {
    console.error(
      `[platform] 重建失败 customer=${sub.customer_id}: ${e instanceof Error ? e.message : e}`,
    );
    return sub;
  }
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
