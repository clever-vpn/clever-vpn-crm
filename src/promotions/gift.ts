/**
 * 礼包发放（**权益层**）—— 契约 `app-crm.md` §2.9.6
 *
 * 与优惠券的区别只有一句：优惠券少收钱，礼包改权益。所以这里
 * **一分钱都不碰**（`benefit_value` 恒 0），只动订阅的 `expires_at` / `balance_gb`。
 *
 * 三条硬规则：
 *   1. **必须有订阅**：没有订阅就没有地方存放权益 —— 跳过并留痕，不报错。
 *   2. **一次发放 = 一张 0 元已付订单**：礼包也要能被"订单/对账"看见，
 *      否则财务侧永远解释不了"这个人为什么多了 7 天"。
 *   3. **幂等靠次数与冷却**：`max_uses_per_customer` + `cooldown_hours`
 *      在发放前判定；重复点"发放"不会发两次。
 */
import { PROMOTION_COLUMNS, rowToPromotion } from "./model";
import { checkForCustomer } from "./service";
import { provisionSubscription } from "../platform/provision";
import { customerSubscription, logChange, upsertSubscription } from "../subscriptions/store";

import type { Env } from "../env";
import type { GiftRewards, Promotion, PromotionRow } from "./model";
import type { Subscription } from "../plans/subscription";

/** 发放来源：注册即送 / 到期前挽回 / 后台手动 */
export type GiftSource = "signup" | "expiring" | "manual";

export interface GiftGrant {
  promotion_id: number;
  customer_id: number;
  /** 是否真的写到了订阅上 */
  granted: boolean;
  /** 没发出去的原因（给后台看的中文整句） */
  skipped: string | null;
  /** 0 元订单号；没发出去为 null */
  order_id: number | null;
  applied: GiftRewards;
}

function orderCode(now: Date, customerId: number): string {
  // 时间戳 + 客户号：人可读、可追溯，且天然不重复
  const stamp = now.toISOString().replace(/\D/g, "").slice(0, 14);
  return `G${stamp}${String(customerId).padStart(6, "0")}`;
}

/**
 * 一张 0 元、直接“已支付”的订单 —— 礼包的账簿凭证。
 *
 * `source='gift'`：统计里与真实销售分开；`payment_method='gift'`：
 * 永远不会进对账（没有渠道流水）。
 */
async function createGiftOrder(
  env: Env,
  promo: Promotion,
  customerId: number,
  now: Date,
): Promise<number> {
  const iso = now.toISOString();
  const res = await env.DB.prepare(
    `INSERT INTO orders (code, customer_id, plan_id, kind, plan_snapshot, amount_minor,
       discount_minor, promotion_id, currency, source, payment_method, entry, status,
       paid_at, note, created_at, updated_at)
     VALUES (?, ?, ?, 'addon', ?, 0, 0, ?, 'CNY', 'gift', 'gift', 'admin', 'paid', ?, ?, ?, ?)`,
  )
    .bind(
      orderCode(now, customerId),
      customerId,
      `gift:${promo.id}`,
      JSON.stringify({ gift: promo.name, promotion_id: promo.id, rewards: promo.rewards }),
      promo.id,
      iso,
      `礼包「${promo.name}」`,
      iso,
      iso,
    )
    .run();
  return Number(res.meta.last_row_id ?? 0);
}

/**
 * 把奖励项作用到**已有订阅**上，并落账到 cf-api。
 *
 * 调用方必须先确认订阅存在（见 `grantGift`）—— 这里不再判空，
 * 以免"先建单、后发现没订阅"留下无主订单。
 */
async function applyGift(
  env: Env,
  opts: {
    before: Subscription;
    rewards: GiftRewards;
    promotionId: number;
    orderId: number;
    source: GiftSource;
  },
): Promise<{ subscriptionId: number; applied: GiftRewards }> {
  const before = opts.before;
  const customerId = before.customer_id;

  const { days, gb, reset_month } = opts.rewards;
  const next: Subscription = { ...before };

  // 天数：永久订阅（expires_at = null）不动 —— 给期限没意义
  if (days > 0 && next.expires_at !== null) {
    next.expires_at = new Date(Date.parse(next.expires_at) + days * 86_400_000).toISOString();
  }
  // 流量：进加购余额（跨期不清零那本账）
  if (gb > 0) {
    next.balance_gb = (next.balance_gb ?? 0) + gb;
    if (next.kind === "traffic" && next.remaining_gb !== null) {
      next.remaining_gb = next.remaining_gb + gb;
    }
  }
  // 重置本月已用：period 侧靠下面这次落账把 `quota + balance` 重新推给平台；
  // traffic 侧直接把剩余拉到整包容量
  if (reset_month && next.kind === "traffic" && next.traffic_total_gb !== null) {
    next.remaining_gb = next.traffic_total_gb;
  }

  const id = await upsertSubscription(env, next);
  const after = { ...next, id };

  await logChange(env, {
    customer_id: customerId,
    subscription_id: id,
    action: "gift",
    before,
    after,
    detail: {
      source: opts.source,
      promotion_id: opts.promotionId,
      order_id: opts.orderId,
      rewards: opts.rewards,
    },
  });

  try {
    await provisionSubscription(env, after);
  } catch (e) {
    // 本地账已记；落账失败交给结算重试，不影响发放结论
    console.error(
      `[gift] 落账失败 customer=${customerId} promo=${opts.promotionId}: ${e instanceof Error ? e.message : e}`,
    );
  }

  return { subscriptionId: id, applied: opts.rewards };
}

/**
 * 给一个客户发一个礼包。
 *
 * 幂等：先过 `checkForCustomer`（含次数上限与冷却），通过了才建单发放。
 * 重复调用（手抖点两次、注册流程重放）第二次会被 `max_uses_per_customer` 挡下。
 */
export async function grantGift(
  env: Env,
  opts: {
    promotionId: number;
    customerId: number;
    source: GiftSource;
    now?: Date;
    assumeFirstPurchase?: boolean;
  },
): Promise<GiftGrant | null> {
  const now = opts.now ?? new Date();
  const row = await env.DB.prepare(`SELECT ${PROMOTION_COLUMNS} FROM promotions WHERE id = ?`)
    .bind(opts.promotionId)
    .first<PromotionRow>();
  if (!row) return null;
  const promo = rowToPromotion(row);
  if (promo.kind !== "gift") return null;

  const skip = (reason: string): GiftGrant => ({
    promotion_id: promo.id,
    customer_id: opts.customerId,
    granted: false,
    skipped: reason,
    order_id: null,
    applied: { days: 0, gb: 0, reset_month: false },
  });

  const check = await checkForCustomer(env, promo, opts.customerId, now, {
    assumeFirstPurchase: opts.assumeFirstPurchase ?? opts.source === "signup",
  });
  if (!check.ok) return skip(check.reason);

  // 先确认"有没有地方可放"：没有订阅就不建单 ——
  // 否则账簿上会多一张 0 元已付订单，却对应不到任何权益。
  const before = await customerSubscription(env, opts.customerId);
  if (!before) return skip("该客户还没有订阅，权益无处可放");

  const orderId = await createGiftOrder(env, promo, opts.customerId, now);
  const applied = await applyGift(env, {
    before,
    rewards: promo.rewards,
    promotionId: promo.id,
    orderId,
    source: opts.source,
  });

  await env.DB.prepare(
    `INSERT OR IGNORE INTO redemptions
       (promotion_id, customer_id, order_id, discount_minor, granted_json, created_at)
     VALUES (?, ?, ?, 0, ?, ?)`,
  )
    .bind(promo.id, opts.customerId, orderId, JSON.stringify(promo.rewards), now.toISOString())
    .run();

  return {
    promotion_id: promo.id,
    customer_id: opts.customerId,
    granted: true,
    skipped: null,
    order_id: orderId,
    applied: applied.applied,
  };
}

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
): Promise<GiftGrant[]> {
  const rows = await env.DB.prepare(
    `SELECT ${PROMOTION_COLUMNS} FROM promotions
      WHERE status = 'active' AND kind = 'gift' AND audience = 'new'
      ORDER BY id`,
  ).all<PromotionRow>();

  const out: GiftGrant[] = [];
  for (const row of rows.results ?? []) {
    const promo = rowToPromotion(row);
    try {
      const result = await grantGift(env, {
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
): Promise<{ granted: number; skipped: number }> {
  const rows = await env.DB.prepare(
    `SELECT ${PROMOTION_COLUMNS} FROM promotions
      WHERE status = 'active' AND kind = 'gift' AND audience = 'expiring'
      ORDER BY id`,
  ).all<PromotionRow>();

  const report = { granted: 0, skipped: 0 };
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
        const result = await grantGift(env, {
          promotionId: promo.id,
          customerId: t.customer_id,
          source: "expiring",
          now,
        });
        if (result?.granted) report.granted += 1;
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
