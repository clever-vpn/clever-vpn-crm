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
import { revokeEntitlement } from "../subscriptions/hold";
import { customerSubscription, logChange } from "../subscriptions/store";
import { GIGA, updateCustomer } from "../platform/client";
import { currentOfSubscription, residualMinor } from "../plans/quote";

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

  if (sub && sub.order_id === order.id) {
    // 走统一的撤销通道：**本地 hold + 平台 frozen=1 一起做**。
    // 曾经这里只 UPDATE 本地，结果是 CRM 显示"权益已撤销"、VPN 却能照常连到自然
    // 到期 —— 平台侧的停服才是真正生效点。
    await revokeEntitlement(env, {
      customerId: order.customer_id,
      reason: opts.reason,
      now,
    });
  }

  return "refunded";
}

// ── 第三方网关订单的退款（人工在网关侧操作，CRM 只记账 + 调整权益）──────────
//
// 口径（与升级抵扣共用同一个 `residualMinor`，不另立一套折算）：
//
//   residual = paid_minor × 剩余比例          ← 这份权益**现在**还值多少钱
//   可退上限 = min(本单还没退的钱, residual)   ← 钱只能从"没用掉的"里退
//   退了 R 元 ⇒ 剩余比例减去 R / paid_minor   ← 客户不会套利，也不会被多扣
//
// `paid_minor` **不改**：它是"当初成交价"，残值公式靠它做分母；改了就会算出
// 一个既不是原价也不是剩余价的东西。
//
// 全退（扣到 0）等价于权益终止 ⇒ 走 `revokeEntitlement`（本地 revoked + 平台停服）；
// 部分退只缩期限/流量，并且**必须推 cf-api**，否则客户端照旧用满。

export interface RefundInput {
  orderCode: string;
  /** 本次退还金额（分） */
  amountMinor: number;
  reason: string;
  /** 网关侧退款流水号（人工操作后回填，便于对账） */
  gatewayRef?: string;
  actor?: string;
  now?: Date;
}

export type RefundOutcome =
  | {
      ok: true;
      refundedMinor: number;
      totalRefundedMinor: number;
      /** 退款后还剩多少（period 天 / traffic GB）；`null` = 权益已终止 */
      remaining: { days: number } | { gb: number } | null;
      voided: boolean;
      platformSynced: boolean;
    }
  | { ok: false; status: number; code: string; message: string };

export async function refundOrder(
  env: Env,
  input: RefundInput,
): Promise<RefundOutcome> {
  const now = input.now ?? new Date();
  const reason = input.reason.trim();
  if (!reason) {
    return { ok: false, status: 400, code: "reason_required", message: "必须写退款原因" };
  }
  const amount = Math.floor(input.amountMinor);
  if (!Number.isFinite(amount) || amount <= 0) {
    return { ok: false, status: 400, code: "bad_amount", message: "退款金额必须大于 0" };
  }

  const order = await env.DB.prepare(
    `SELECT id, code, customer_id, status, amount_minor, refunded_minor, iap_key
       FROM orders WHERE code = ?`,
  )
    .bind(input.orderCode)
    .first<{
      id: number;
      code: string;
      customer_id: number;
      status: string;
      amount_minor: number;
      refunded_minor: number;
      iap_key: string | null;
    }>();
  if (!order) {
    return { ok: false, status: 404, code: "order_not_found", message: "订单不存在" };
  }
  if (order.iap_key) {
    return {
      ok: false,
      status: 409,
      code: "iap_refund_by_store",
      message: "商店内购的退款由 Apple / Google 发起，CRM 只接收通知",
    };
  }
  if (order.status !== "active") {
    return {
      ok: false,
      status: 409,
      code: "not_paid",
      message: `只有已到账的订单能退款（当前状态：${order.status}）`,
    };
  }

  const refunded = Number(order.refunded_minor ?? 0);
  const leftOnOrder = order.amount_minor - refunded;
  if (amount > leftOnOrder) {
    return {
      ok: false,
      status: 400,
      code: "refund_too_large",
      message: `这一单最多还能退 ${(leftOnOrder / 100).toFixed(2)}`,
    };
  }

  const sub = await customerSubscription(env, order.customer_id);
  if (!sub) {
    return {
      ok: false,
      status: 409,
      code: "no_subscription",
      message: "这个客户当前没有生效中的订阅，权益无可调整",
    };
  }

  const residual = residualMinor(currentOfSubscription(sub), now);
  if (amount > residual) {
    return {
      ok: false,
      status: 400,
      code: "refund_exceeds_residual",
      message:
        residual <= 0
          ? "这份权益已经用完了，没有可退的剩余价值"
          : `最多可退 ${(residual / 100).toFixed(2)}（已用完的部分不退）`,
    };
  }
  if (!sub.paid_minor) {
    return {
      ok: false,
      status: 409,
      code: "cannot_prorate",
      message: "这份权益没有成交价，无法按比例折算（请走冻结或人工调整）",
    };
  }

  const newResidual = residual - amount;
  const ratio = Math.max(0, newResidual) / sub.paid_minor;
  const refundMode = newResidual <= 0 ? "refund_and_void" : "refund_prorate";

  // ── 权益：全退就终止，部分退就按比例缩 ──
  let remaining: { days: number } | { gb: number } | null = null;
  let platformSynced = false;
  const patch: Record<string, unknown> = {};

  if (refundMode === "refund_and_void") {
    const r = await revokeEntitlement(env, {
      customerId: order.customer_id,
      reason: `退款：${reason}`,
      now,
    });
    platformSynced = r.ok ? r.platform_synced : false;
  } else if (sub.kind === "period") {
    if (!sub.period_term_days) {
      return {
        ok: false,
        status: 409,
        code: "cannot_prorate",
        message: "这份周期套餐没有计费天数记录，无法按比例折算",
      };
    }
    const newExpires = new Date(
      now.getTime() + ratio * sub.period_term_days * 86_400_000,
    );
    remaining = {
      days: Math.max(
        0,
        Math.floor((newExpires.getTime() - now.getTime()) / 86_400_000),
      ),
    };
    await env.DB.prepare(
      `UPDATE platform_subscriptions SET expires_at = ?, updated_at = ? WHERE id = ?`,
    )
      .bind(newExpires.toISOString(), now.toISOString(), sub.id)
      .run();
    // cf-api 的 `expire_date` 只有天：向下取整，宁可少给几小时也不要多给一天
    patch.expire_date = newExpires.toISOString().slice(0, 10);
  } else {
    if (!sub.traffic_total_gb) {
      return {
        ok: false,
        status: 409,
        code: "cannot_prorate",
        message: "这份流量套餐没有总量记录，无法按比例折算",
      };
    }
    const newGb = ratio * sub.traffic_total_gb;
    remaining = { gb: Math.round(newGb * 100) / 100 };
    await env.DB.prepare(
      `UPDATE platform_subscriptions SET traffic_remaining_gb = ?, updated_at = ?
        WHERE id = ?`,
    )
      .bind(newGb, now.toISOString(), sub.id)
      .run();
    patch.traffic_balance = Math.round(newGb * GIGA);
  }

  if (Object.keys(patch).length > 0 && sub.platform_customer_id) {
    try {
      await updateCustomer(env, sub.platform_customer_id, patch);
      platformSynced = true;
    } catch {
      // 钱已经退出去了，不能因为平台抖动就否认退款；留给后台按 red flag 处理
      platformSynced = false;
    }
  }

  // ── 订单账 ──
  const totalRefunded = refunded + amount;
  const note = input.gatewayRef
    ? `${reason}（网关退款号 ${input.gatewayRef}）`
    : reason;
  await env.DB.prepare(
    `UPDATE orders SET refunded_minor = ?, refund_mode = ?, refund_reason = ?,
       status = ?, voided_at = COALESCE(voided_at, ?), updated_at = ?
     WHERE id = ?`,
  )
    .bind(
      totalRefunded,
      refundMode,
      note.slice(0, 200),
      refundMode === "refund_and_void" ? "refunded" : "active",
      refundMode === "refund_and_void" ? now.toISOString() : null,
      now.toISOString(),
      order.id,
    )
    .run();

  await logChange(env, {
    customer_id: order.customer_id,
    subscription_id: sub.id,
    action: "adjust",
    before: sub,
    after: null,
    detail: {
      kind: "refund",
      order_code: order.code,
      amount_minor: amount,
      refund_mode: refundMode,
      platform_synced: platformSynced,
      actor: input.actor ?? null,
      gateway_ref: input.gatewayRef ?? null,
    },
  });

  return {
    ok: true,
    refundedMinor: amount,
    totalRefundedMinor: totalRefunded,
    remaining,
    voided: refundMode === "refund_and_void",
    platformSynced,
  };
}
