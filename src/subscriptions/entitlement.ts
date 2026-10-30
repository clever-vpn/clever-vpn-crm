/**
 * 「往订阅上**加**天数 / 加流量」—— 这件事的唯一实现。
 *
 * 两个入口共用它：
 *   - 营销礼包（`promotions/gift.ts`）：按活动规则送；
 *   - 管理员直接调整（`subscriptions/adjust.ts`）：特殊补偿，一个人一次。
 *
 * 为什么必须共用：这里有两个极易出错的点，各写一份一定会漂移 ——
 *   1. **维度独立**：无限期（`expires_at = null`）收了天数没意义，不限量收了 GB 也没意义；
 *   2. **写平台只能写差值**：period 的 `traffic_balance = 额度 + 池子` 是绝对值，
 *      拿它去 PATCH 会把用户本月已经用掉的流量还回去。
 */
import { GIGA, updateCustomer } from "../platform/client";

import type { Env } from "../env";
import type { Subscription } from "../plans/subscription";

const DAY_MS = 86_400_000;

/** 一次"加多少"。两个维度互相独立，都只能为正（减权益要走别的流程） */
export interface Additive {
  days: number;
  gb: number;
}

/**
 * 这份订阅**能收下**哪些增量 —— 不适用的维度归 0。
 *
 *   - `days`：`expires_at === null`（永久 / 无限期）⇒ 延长无处可延，归 0
 *   - `gb`  ：period 的 `period_quota_gb === null`、traffic 的 `traffic_total_gb === null`
 *             （不限量）⇒ 加流量没有意义，归 0
 */
export function applicableAdditive(
  sub: Pick<Subscription, "kind" | "expires_at" | "period_quota_gb" | "traffic_total_gb">,
  add: Additive,
): Additive {
  const unlimited =
    sub.kind === "period" ? sub.period_quota_gb === null : sub.traffic_total_gb === null;
  return {
    days: sub.expires_at === null ? 0 : Math.max(0, add.days),
    gb: unlimited ? 0 : Math.max(0, add.gb),
  };
}

/**
 * 纯函数：算出叠加后的新快照（不写库、不碰平台）。
 *
 * - `days`：在**原到期日**上加（不是从今天算，也不是覆盖）
 * - `gb` ：period 进额外流量池；traffic 同时抬高整包容量与剩余
 *
 * `platformRemainingGb` 是**平台真实剩余**（调用方先 `freshenTraffic` 拿到的）。
 * 有它就用它当基数 —— 本地 `traffic_remaining_gb` 只是 15 分钟的缓存，
 * 拿它加会把用户这段时间用掉的流量又还回去。
 */
export function applyAdditive(
  sub: Subscription,
  add: Additive,
  opts: { platformRemainingGb?: number | null; now?: Date } = {},
): Subscription {
  const next: Subscription = { ...sub };

  if (add.days > 0 && next.expires_at !== null) {
    next.expires_at = new Date(Date.parse(next.expires_at) + add.days * DAY_MS).toISOString();
  }

  if (add.gb > 0) {
    if (next.kind === "traffic") {
      next.traffic_total_gb = (next.traffic_total_gb ?? 0) + add.gb;
    } else {
      next.period_extra_gb = (next.period_extra_gb ?? 0) + add.gb;
    }
    const base = opts.platformRemainingGb ?? next.traffic_remaining_gb;
    next.traffic_remaining_gb = base === null ? null : base + add.gb;

    if (opts.platformRemainingGb !== undefined && opts.platformRemainingGb !== null) {
      // 我们马上就把这个数写到平台 ⇒ 缓存就是真值
      next.traffic_synced_at = (opts.now ?? new Date()).toISOString();
    }
  }

  return next;
}

/**
 * 只把这次增量**真正改动的字段**推到平台。
 *
 * 为什么不复用 `provisionSubscription`：它会写**全量控制参数**（`traffic_balance` 是
 * `额度 + 池子` 的绝对值），只加天数时这么写等于把已用量还回去。所以按维度精确写：
 *   - 只有天数 ⇒ 只 PATCH `expire_date`
 *   - 有 GB   ⇒ 写 `平台真实剩余 + gb`（基数由调用方先拿到）
 *
 * 还没落账（没有 `platform_customer_id`）直接返回：等 `retryProvisioning` 全量落账，
 * 那时平台上还没有任何已用量，`额度 + 池子` 就是对的。
 */
export async function pushAdditive(
  env: Env,
  sub: Subscription,
  add: Additive,
  platformRemainingGb: number | null | undefined,
  expiresAt: string | null,
): Promise<void> {
  if (!sub.platform_customer_id) return;

  const patch: Record<string, unknown> = {};
  if (add.days > 0 && expiresAt) patch.expire_date = expiresAt.slice(0, 10);
  if (add.gb > 0 && platformRemainingGb !== undefined && platformRemainingGb !== null) {
    patch.traffic_balance = Math.round((platformRemainingGb + add.gb) * GIGA);
  }
  if (Object.keys(patch).length === 0) return;
  await updateCustomer(env, sub.platform_customer_id, patch);
}
