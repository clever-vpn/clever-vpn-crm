/**
 * 临时冻结 / 解冻一个客户（**停服务，不减权益**）
 *
 * 契约 §2.6 ⑦ 的第一条：想"让他连不上"就改平台客户的 `frozen`，
 * **不要**撤销会话 —— 那会把人踢出登录，连客服入口都进不去。
 *
 * 两处必须同时动，缺一不可：
 *   1. **cf-api**：`frozen = 1` ⇒ VPN server 侧直接拒绝这个码的流量（生效点在那里）；
 *   2. **CRM**：订阅 `hold = 'frozen'` ⇒ `/subscription` 变成 `inactive / frozen`，
 *      App 显示"服务已暂停"+ 客服入口（而不是含糊的"已到期"）。
 *
 * 解冻只恢复 `hold = 'frozen'`；**不会**把 `revoked`（退款撤销）改回来 ——
 * 那是另一件事，得走运营策略。
 */
import { updateCustomer } from "../platform/client";
import { customerSubscription, logChange } from "./store";

import type { Env } from "../env";
import type { Subscription } from "../plans/subscription";

export type HoldResult =
  | { ok: true; hold: "none" | "frozen"; platform_synced: boolean }
  | { ok: false; code: string; message: string };

export async function setCustomerHold(
  env: Env,
  input: { customerId: number; frozen: boolean; reason: string; now?: Date },
): Promise<HoldResult> {
  const reason = input.reason.trim();
  if (!reason) {
    return { ok: false, code: "invalid", message: "必须写原因（会记进变更台账）" };
  }

  const sub = await customerSubscription(env, input.customerId);
  if (!sub) {
    return { ok: false, code: "no_subscription", message: "这个客户还没有订阅" };
  }

  const now = input.now ?? new Date();

  // 解冻只对"因冻结而停"的订阅生效；退款撤销的单不能借这个口子复活
  if (!input.frozen && sub.hold === "revoked") {
    return { ok: false, code: "invalid_state", message: "这份权益已被退款撤销，不能解冻" };
  }

  const target: Subscription = {
    ...sub,
    hold: input.frozen ? "frozen" : "none",
    hold_reason: input.frozen ? reason : sub.hold === "frozen" ? null : sub.hold_reason,
    hold_at: now.toISOString(),
  };

  // ① 先推平台：平台拒绝就等于没冻住，本地也不该显示"已暂停"
  let platformSynced = false;
  if (sub.platform_customer_id) {
    try {
      await updateCustomer(env, sub.platform_customer_id, { frozen: input.frozen ? 1 : 0 });
      platformSynced = true;
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      return { ok: false, code: "platform_failed", message: `平台侧未生效：${msg}` };
    }
  }

  // ② 再改本地（顺序不能反：本地先改会出现"CRM 说停了、VPN 还能连"）
  await env.DB.prepare(
    `UPDATE platform_subscriptions SET hold = ?, hold_reason = ?, hold_at = ?, updated_at = ?
      WHERE id = ?`,
  )
    .bind(target.hold, target.hold_reason, target.hold_at, now.toISOString(), sub.id)
    .run();

  await logChange(env, {
    customer_id: input.customerId,
    subscription_id: sub.id,
    action: "hold",
    before: sub,
    after: target,
    detail: { frozen: input.frozen, reason },
  });

  return { ok: true, hold: target.hold as "none" | "frozen", platform_synced: platformSynced };
}

export interface RevokeResult {
  ok: true;
  /** 平台侧是否真的停服了；`false` 表示要人工补一刀（见下） */
  platform_synced: boolean;
  /** 已经是撤销状态（重复的退款通知 / 重放），本次没有改动 */
  already: boolean;
}

/**
 * **撤销权益（退款 / 吊销）：不可逆，且必须让平台侧停服。**
 *
 * 与 `setCustomerHold` 的三点不同：
 *
 * 1. 目标态是 `revoked`，不是 `frozen` —— `setCustomerHold` 只在**解冻**方向拒
 *    绝 revoked，冻结方向会把它覆盖成 frozen，所以退款**不能**走那个口子。
 * 2. **顺序相反**：冻结是"平台没生效就当没冻"（可自愈），退款是钱已经退出去了，
 *    所以先推平台、无论成败都落本地账，把 `platform_synced` 如实标出来。
 * 3. 停服手段是 `frozen=1`：cf-api 不支持按激活码吊销（`crm-api.md` §4.2），
 *    只改到期日的话客户端还能用到那天结束。
 *
 * 平台推失败不抛错：退款是既成事实，调用方不该因为网络抖动就认为"没退"。
 */
export async function revokeEntitlement(
  env: Env,
  input: { customerId: number; reason: string; now?: Date },
): Promise<RevokeResult | { ok: false; code: string; message: string }> {
  const reason = input.reason.trim();
  if (!reason) {
    return { ok: false, code: "invalid", message: "必须写原因（会记进变更台账）" };
  }

  const sub = await customerSubscription(env, input.customerId);
  if (!sub) {
    return { ok: false, code: "no_subscription", message: "这个客户还没有订阅" };
  }
  if (sub.hold === "revoked") {
    return { ok: true, platform_synced: true, already: true };
  }

  const now = input.now ?? new Date();

  // ① 先推平台停服
  let platformSynced = false;
  if (sub.platform_customer_id) {
    try {
      await updateCustomer(env, sub.platform_customer_id, { frozen: 1 });
      platformSynced = true;
    } catch {
      // 网络/平台故障：照样落本地账，让后台能看见"该补一刀"
      platformSynced = false;
    }
  }

  // ② 再落本地（即使平台失败也要改：CRM 的权益已经终止了）
  const target: Subscription = {
    ...sub,
    hold: "revoked",
    hold_reason: reason,
    hold_at: now.toISOString(),
  };
  await env.DB.prepare(
    `UPDATE platform_subscriptions SET hold = 'revoked', hold_reason = ?, hold_at = ?,
       updated_at = ? WHERE id = ?`,
  )
    .bind(reason, now.toISOString(), now.toISOString(), sub.id)
    .run();

  await logChange(env, {
    customer_id: input.customerId,
    subscription_id: sub.id,
    action: "hold",
    before: sub,
    after: target,
    detail: { reason, platform_synced: platformSynced },
  });

  return { ok: true, platform_synced: platformSynced, already: false };
}
