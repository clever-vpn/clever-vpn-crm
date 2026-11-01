/**
 * 商店订单的 cron 查单（与网关的 `queryOnce` 同一个"结论"形状）
 *
 * 为什么必须有：`POST /orders/iap` 落下的 `pending` 单（Google 家长审批、延迟入账、
 * 客户端提交后网络断了）不能只靠客户端重试 —— 商品是**一次性**的，客户端不重试就永远
 * 停在 pending。cron 每轮把到点的 iap 单再问一次商店，查到了就走同一个
 * `settlePaidOrder()`。
 *
 * 原则与网关一致：**通知/凭据只当触发器，真相以回源查询为准**。
 */
import { consumeGooglePurchase, verifyApplePurchase, verifyGooglePurchase } from "./iap";
import { refundIapOrder } from "./refund";
import { decryptSecret } from "./secret";
import { loadStoreChannel } from "./store-channels";
import { settlePaidOrder } from "./notify";

import type { Env } from "../env";
import type { StoreChannelConfig, StoreSecret } from "./iap";
import type { PayableOrder } from "./notify";

export type IapVerdict = "paid" | "pending" | "terminal" | "no_query" | "error";

export interface IapOutcome {
  verdict: IapVerdict;
  message?: string;
}

async function channel(env: Env, platform: string): Promise<StoreChannelConfig | null> {
  if (platform !== "apple" && platform !== "google") return null;
  const row = await loadStoreChannel(env, platform);
  if (!row || row.status !== "live") return null;
  const plain = await decryptSecret(env, row.secret_enc);
  if (!plain) return null;
  try {
    return {
      platform,
      endpoint: (row.endpoint || "").replace(/\/+$/, ""),
      identifier: row.identifier,
      environment: row.environment,
      secret: JSON.parse(plain) as StoreSecret,
    };
  } catch {
    return null;
  }
}

/** 商品号从订单快照里取（Google 的 `purchases.products.get` 必须要它） */
function productIdOf(order: PayableOrder, platform: string): string {
  try {
    const plan = JSON.parse(order.plan_snapshot) as {
      store_product_id?: Record<string, string>;
    };
    return plan.store_product_id?.[platform] ?? "";
  } catch {
    return "";
  }
}

/**
 * 问一次商店。
 *
 * @returns `paid` 已结算 / `pending` 还没确认（排下一轮）/ `terminal` 已退款作废 /
 *          `no_query` 没法查（渠道没启用、缺凭据）/ `error` 这次失败（排下一轮）
 */
export async function queryIapOnce(
  env: Env,
  order: PayableOrder,
  deps: { fetch?: typeof fetch; now?: Date } = {},
): Promise<IapOutcome> {
  const platform = order.payment_method;
  const ch = await channel(env, platform);
  if (!ch) return { verdict: "no_query", message: "store_channel_not_live" };

  const tradeNo = order.provider_trade_no ?? "";
  if (!tradeNo) return { verdict: "no_query", message: "no_transaction" };

  const now = deps.now ?? new Date();
  const verified =
    platform === "apple"
      ? await verifyApplePurchase(ch, `h.${btoa(JSON.stringify({ transactionId: tradeNo }))}.s`, {
          fetch: deps.fetch,
          now,
        })
      : await verifyGooglePurchase(ch, productIdOf(order, platform), tradeNo, {
          fetch: deps.fetch,
          now,
        });

  if (!verified.ok) {
    // 商店查不到（404 / 400）说明这笔凭据根本不存在 ⇒ 别无限重试
    if (verified.code === "invalid_receipt") {
      return { verdict: "no_query", message: verified.message };
    }
    return { verdict: "error", message: verified.message };
  }

  const purchase = verified.purchase;
  // 已退款 / 已撤销：走同一条作废路径，然后不用再查
  if (purchase.revoked) {
    await refundIapOrder(env, {
      iapKey: `${platform}:${tradeNo}`,
      reason: `stores:${platform}:revoked`,
      now,
    });
    return { verdict: "terminal" };
  }

  // Google 的"待处理"（家长审批 / 延迟入账）：还不是钱，排下一轮
  if (platform === "google" && purchase.raw.includes('"purchaseState":2')) {
    return { verdict: "pending" };
  }

  await settlePaidOrder(env, order, tradeNo, purchase.raw, now);

  // 落库之后才 consume（Google）；失败不回滚订单，下一轮会再试
  if (platform === "google") {
    await consumeGooglePurchase(ch, purchase.productId, tradeNo, { fetch: deps.fetch, now }).catch(
      () => false,
    );
  }
  return { verdict: "paid" };
}
