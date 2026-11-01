/**
 * 商店退款：**作废订单 + 撤销那次权益**
 *
 * 契约 §2.4.3 ⑧：退款只有单笔（没有订阅链）—— 商店退款通知 → 找到该事务号对应的订单 →
 * 按**退款模式 A（refund_and_void）**处理。
 *
 * 两条边界：
 *   - **不自动作废已发的激活码**（cf-api 不支持按码吊销，`crm-api.md` §4.2）；
 *     是否冻结**平台客户**由运营策略决定，这里不碰。
 *   - 已领的礼包不收回、已消耗的额度不退（与商店退款是两件事）。
 */
import { logChange } from "../subscriptions/store";

import type { Env } from "../env";

export type RefundResult = "refunded" | "already" | "not_found" | "not_paid";

/**
 * @param iapKey `"<platform>:<事务号>"`（`orders.iap_key` 的唯一键）
 */
export async function refundIapOrder(
  env: Env,
  opts: { iapKey: string; reason: string; now?: Date },
): Promise<RefundResult> {
  const now = opts.now ?? new Date();
  const iso = now.toISOString();

  const order = await env.DB.prepare(
    `SELECT id, code, customer_id, status, amount_minor, subscription_id
       FROM orders WHERE iap_key = ?`,
  )
    .bind(opts.iapKey)
    .first<{
      id: number;
      code: string;
      customer_id: number;
      status: string;
      amount_minor: number;
      subscription_id: number | null;
    }>();

  if (!order) return "not_found";
  if (order.status === "refunded") return "already";
  // 还没到账的单没有"退款"可言（通知乱序 / 恶意重放）
  if (order.status === "pending" || order.status === "closed") return "not_paid";

  await env.DB.prepare(
    `UPDATE orders SET status = 'refunded', refunded_minor = amount_minor,
       refund_mode = 'refund_and_void', refund_reason = ?, voided_at = ?, updated_at = ?
      WHERE id = ? AND status <> 'refunded'`,
  )
    .bind(opts.reason, iso, iso, order.id)
    .run();

  // 只有"让这份权益生效的那笔单"才撤销权益；续费/加量的退款由运营按策略处理
  const sub = await env.DB.prepare(
    `SELECT id, hold, order_id FROM platform_subscriptions WHERE customer_id = ?`,
  )
    .bind(order.customer_id)
    .first<{ id: number; hold: string; order_id: number | null }>();

  if (sub && sub.order_id === order.id && sub.hold !== "revoked") {
    await env.DB.prepare(
      `UPDATE platform_subscriptions SET hold = 'revoked', hold_reason = ?, hold_at = ?,
         updated_at = ? WHERE id = ?`,
    )
      .bind(opts.reason, iso, iso, sub.id)
      .run();
    await logChange(env, {
      customer_id: order.customer_id,
      subscription_id: sub.id,
      action: "hold",
      before: null,
      after: null,
      paid_minor: null,
      detail: { reason: "refund", order_id: order.id, order_code: order.code },
    });
  }

  return "refunded";
}
