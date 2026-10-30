/**
 * 礼包的**触发点** —— 什么时候该送礼包。
 *
 * 与「怎么送」分开：怎么送只有一份实现（`gift.ts` 的 `grantGift` / `deliverGift`），
 * 这里只回答"扫谁"。三个触发点：
 *
 *   1. `grantSignupGifts`  首单开通后 —— 注册礼（`audience='new'`）
 *   2. `runExpiringGifts`  每小时扫 —— 快到期的人（`audience='expiring'`）
 *   3. 后台点名发放（`POST /api/admin/promotions/{id}/grant`）—— 不走这里
 *
 * 三个触发点都走 `deliverGift`：所以活动配了「待领取」时，扫出来的是**券**而不是权益。
 */
import { PROMOTION_COLUMNS, rowToPromotion } from "./model";
import { deliverGift } from "./gift";

import type { Env } from "../env";
import type { GiftDelivery } from "./gift";
import type { PromotionRow } from "./model";

/**
 * 「注册即送」：首单开通后给新客发 `audience='new'` 的礼包。
 *
 * 时机放在**首单开通之后**而不是注册那一刻 —— 新注册的人还没有订阅，
 * 天数与流量都无处可放。`audience='new'` 就是"注册礼包"的标记，不需要额外字段。
 *
 * 幂等：`max_uses_per_customer`（默认 1）+ 冷却；重复调用不会双发。
 */
export async function grantSignupGifts(
  env: Env,
  customerId: number,
  now: Date = new Date(),
): Promise<GiftDelivery[]> {
  const rows = await env.DB.prepare(
    `SELECT ${PROMOTION_COLUMNS} FROM promotions
      WHERE status = 'active' AND kind = 'gift' AND audience = 'new'
      ORDER BY id`,
  ).all<PromotionRow>();

  const out: GiftDelivery[] = [];
  for (const row of rows.results ?? []) {
    const promo = rowToPromotion(row);
    try {
      const result = await deliverGift(env, {
        promotionId: promo.id,
        customerId,
        source: "signup",
        now,
      });
      if (result) out.push(result);
    } catch (e) {
      console.error(
        `[gift] 注册礼包发放失败 promo=${promo.id} customer=${customerId}: ${e instanceof Error ? e.message : e}`,
      );
    }
  }
  return out;
}

/**
 * 扫描"即将到期"的礼包并自动发下去（`scheduled` 每天跑一次）。
 *
 * - 只看 `audience='expiring'` 的活动：别的受众不靠自动发放；
 * - 每个客户最多一次由 `max_uses_per_customer` 保证；
 * - **错了不影响别的客户**：单个失败只记日志，绝不中断整轮。
 */
export async function runExpiringGifts(
  env: Env,
  now: Date = new Date(),
): Promise<{ granted: number; pending: number; skipped: number }> {
  const rows = await env.DB.prepare(
    `SELECT ${PROMOTION_COLUMNS} FROM promotions
      WHERE status = 'active' AND kind = 'gift' AND audience = 'expiring'
      ORDER BY id`,
  ).all<PromotionRow>();

  const report = { granted: 0, pending: 0, skipped: 0 };
  for (const row of rows.results ?? []) {
    const promo = rowToPromotion(row);
    const days = promo.audience_days ?? 7;
    const horizon = new Date(now.getTime() + days * 86_400_000);

    const targets = await env.DB.prepare(
      `SELECT customer_id FROM platform_subscriptions
        WHERE hold = 'none' AND expires_at IS NOT NULL
          AND expires_at > ? AND expires_at <= ?`,
    )
      .bind(now.toISOString(), horizon.toISOString())
      .all<{ customer_id: number }>();

    for (const t of targets.results ?? []) {
      try {
        const result = await deliverGift(env, {
          promotionId: promo.id,
          customerId: t.customer_id,
          source: "expiring",
          now,
        });
        // 送出去有两种成功：已经到账（auto）/ 已发券等人领（claim）
        if (result?.granted) report.granted += 1;
        else if (result?.pending) report.pending += 1;
        else report.skipped += 1;
      } catch (e) {
        console.error(
          `[gift] 到期礼包发放失败 promo=${promo.id} customer=${t.customer_id}: ${e instanceof Error ? e.message : e}`,
        );
        report.skipped += 1;
      }
    }
  }
  return report;
}
