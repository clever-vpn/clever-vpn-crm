/**
 * **单客户线路权益**（管理员直接改某个客户的可用线路）
 *
 * 为什么需要它：线路权益是按套餐快照下来的（`subscriptionFromPlan`），但运营会遇到
 * "这个用户先给我开一条线路"这种一次性诉求。走改套餐再让用户重新购买太重，
 * 所以提供一个直接改**订阅快照**的入口 —— 改完就是这条订阅的真相，
 * 后续落账（续费/结算）不会把它冲掉（除非用户换了套餐）。
 *
 * 三条硬约束：
 *   1. 只写绝对值（`[]` = 全部线路，落账写成 `null`）—— 与 `crm-api.md` §3.2 同口径；
 *   2. **先推平台、再写本地**（与 `adjust.ts` 同一理由）：这里没有重试机制，
 *      宁可整体失败让管理员重试，也不要"本地改了、平台没改、用户其实还能用旧线路"；
 *   3. 必须写原因，并记一条 `subscription_changes(action='adjust')` —— 权益变化要能追溯。
 */
import { logChange, customerSubscription, upsertSubscription } from "./store";
import { updateCustomer } from "../platform/client";

import type { Env } from "../env";
import type { Subscription } from "../plans/subscription";

/** 归一线路集合：正整数、去重、升序；`[]` = 全部线路 */
export function normalizeLineIds(input: unknown): number[] {
  const raw = Array.isArray(input) ? input : [];
  const ids = raw
    .map((v) => (typeof v === "number" ? v : typeof v === "string" ? Number(v) : Number.NaN))
    .filter((n): n is number => Number.isInteger(n) && n > 0);
  return [...new Set(ids)].sort((a, b) => a - b);
}

export interface SetLinesInput {
  customerId: number;
  /** `[]` = 全部线路 */
  lineIds: unknown;
  /** **必填**：为什么改（审计与客服复盘都靠它） */
  reason: string;
  operator: string;
}

export interface SetLinesResult {
  ok: boolean;
  error?: "invalid" | "no_subscription" | "platform_failed";
  message?: string;
  before?: Subscription;
  after?: Subscription;
  /** 实际写下的线路集合（`[]` = 全部） */
  applied: number[];
  /** 平台是否已写入（没落账的订阅会等 provisioning 全量落账） */
  platform_synced: boolean;
}

const fail = (error: NonNullable<SetLinesResult["error"]>, message: string): SetLinesResult => ({
  ok: false,
  error,
  message,
  applied: [],
  platform_synced: false,
});

const sameIds = (a: number[], b: number[]): boolean =>
  a.length === b.length && a.every((v, i) => v === b[i]);

export async function setSubscriptionLines(env: Env, input: SetLinesInput): Promise<SetLinesResult> {
  const reason = input.reason?.trim() ?? "";
  if (!reason) return fail("invalid", "必须写变更原因（会记进变更流水与审计）");

  const before = await customerSubscription(env, input.customerId);
  if (!before) return fail("no_subscription", "这个客户还没有订阅，先开通再改线路");

  const applied = normalizeLineIds(input.lineIds);
  if (sameIds(applied, before.line_ids)) {
    // 幂等：没变化就不写平台、不记流水
    return { ok: true, before, after: before, applied, platform_synced: true };
  }

  const next: Subscription = { ...before, line_ids: applied };

  // ── ① 先推平台（还没落账的订阅跳过：provisioning 会用快照全量写）──
  let platformSynced = false;
  if (before.platform_customer_id) {
    try {
      await updateCustomer(env, before.platform_customer_id, {
        line_ids: applied.length ? applied : null,
      });
      platformSynced = true;
    } catch (e) {
      return fail(
        "platform_failed",
        `平台侧未生效：${e instanceof Error ? e.message : String(e)}（这次没有改动任何数据）`,
      );
    }
  }

  // ── ② 再写本地 ──
  const id = await upsertSubscription(env, next);
  const after = { ...next, id };

  await logChange(env, {
    customer_id: input.customerId,
    subscription_id: id,
    action: "adjust",
    before,
    after,
    detail: {
      lines: { before: before.line_ids, after: applied },
      reason,
      operator: input.operator,
    },
  });

  return { ok: true, before, after, applied, platform_synced: platformSynced };
}
