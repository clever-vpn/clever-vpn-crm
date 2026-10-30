/**
 * 礼包发放（**权益层**）—— 契约 `app-crm.md` §2.9.6
 *
 * 与优惠券的区别只有一句：优惠券少收钱，礼包改权益。所以这里
 * **一分钱都不碰**（`benefit_value` 恒 0），只动订阅的 `expires_at` / `period_extra_gb`。
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
import { rowToPlan } from "../plans/model";
import { subscriptionFromPlan } from "../plans/subscription";

import type { Env } from "../env";
import type { GiftRewards, Promotion, PromotionRow } from "./model";
import type { PlanRow } from "../plans/model";
import type { Subscription } from "../plans/subscription";

const DAY_MS = 86_400_000;

/** 发放来源：注册即送 / 到期前挽回 / 后台手动 / 用户自己输码 */
export type GiftSource = "signup" | "expiring" | "manual" | "redeem";

export interface GiftGrant {
  promotion_id: number;
  customer_id: number;
  /** 是否真的写到了订阅上 */
  granted: boolean;
  /** `true` = 本次是用载体套餐新开的订阅（客户原本没有订阅） */
  opened?: boolean;
  /** 没发出去的原因（给后台看的中文整句） */
  skipped: string | null;
  /** 0 元订单号；没发出去为 null */
  order_id: number | null;
  applied: GiftRewards;
}

function orderCode(now: Date, customerId: number): string {
  // 时间戳 + 客户号 + 3 位随机：人可读、可追溯。
  // **随机后缀是必须的** —— 同一客户在同一秒内收到两个礼包（比如注册礼包 + 立刻兑换）
  // 会撞 `orders.code` 的唯一约束。
  const stamp = now.toISOString().replace(/\D/g, "").slice(0, 14);
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  const bytes = new Uint8Array(3);
  crypto.getRandomValues(bytes);
  let suffix = "";
  for (const b of bytes) suffix += alphabet[b % alphabet.length];
  return `G${stamp}${String(customerId).padStart(6, "0")}${suffix}`;
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
  // 流量：period 进额外流量池（跨期不清零那本账）；traffic 直接加在剩余上
  if (gb > 0) {
    if (next.kind === "traffic") {
      if (next.traffic_remaining_gb !== null) next.traffic_remaining_gb += gb;
      if (next.traffic_total_gb !== null) next.traffic_total_gb += gb;
    } else {
      next.period_extra_gb = (next.period_extra_gb ?? 0) + gb;
    }
  }
  // 重置本月已用：period 侧靠下面这次落账把 `quota + extra` 重新推给平台；
  // traffic 侧直接把剩余拉到整包容量
  if (reset_month && next.kind === "traffic" && next.traffic_total_gb !== null) {
    next.traffic_remaining_gb = next.traffic_total_gb;
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
 * 用**载体套餐**给一个没有订阅的客户开户（契约 §2.9.7）。
 *
 * 语义分工：**套餐管"是什么包"**（流量 / 线路 / 设备数），
 * **礼包管"送多久"**（`rewards.days`）—— 与 XBoard 的 `plan_id` +
 * `plan_validity_days` 同一个道理，避免两个地方都说天数。
 *
 * 只允许 `visibility='hidden'` 的套餐：公开套餐能被直接买到，
 * 拿它当载体等于开了个 0 元购买通道。
 *
 * @returns `null` = 载体套餐不可用（调用方负责回滚刚建的订单）
 */
async function openFromCarrierPlan(
  env: Env,
  opts: {
    planId: string;
    customerId: number;
    rewards: GiftRewards;
    promotionId: number;
    orderId: number;
    source: GiftSource;
    now: Date;
  },
): Promise<{ subscriptionId: number; applied: GiftRewards } | null> {
  const row = await env.DB.prepare(
    `SELECT id, name, kind, price_minor, currency, licence_limit, term_days, monthly_quota_gb,
       traffic_gb, validity_days, line_ids, up_mbps, down_mbps, sales_channels,
       store_product_id, sort_order, status, retired_at
     FROM plans WHERE id = ?`,
  )
    .bind(opts.planId)
    .first<PlanRow>();
  if (!row) return null;

  const isHidden =
    (await env.DB.prepare(`SELECT visibility FROM plans WHERE id = ?`)
      .bind(opts.planId)
      .first<{ visibility: string }>())?.visibility === "hidden";
  if (!isHidden || row.status !== "active") return null;

  const plan = rowToPlan(row);
  if (plan.kind === "addon") return null; // 加购包不产生订阅

  // 0 元开户：套餐提供骨架，礼包的天数覆盖有效期
  const base = subscriptionFromPlan(plan, {
    customerId: opts.customerId,
    paidMinor: 0,
    now: opts.now,
  });
  const next: Subscription = {
    ...base,
    id: 0,
    expires_at:
      opts.rewards.days > 0
        ? new Date(opts.now.getTime() + opts.rewards.days * DAY_MS).toISOString()
        : base.expires_at,
    // 礼包额外送的 GB 跟着套餐类型走：period 进池子，traffic 加在整包上
    period_extra_gb: plan.kind === "period" && opts.rewards.gb > 0 ? opts.rewards.gb : 0,
    traffic_total_gb:
      plan.kind === "traffic" && opts.rewards.gb > 0
        ? (base.traffic_total_gb ?? 0) + opts.rewards.gb
        : base.traffic_total_gb,
    traffic_remaining_gb:
      plan.kind === "traffic" && opts.rewards.gb > 0
        ? (base.traffic_remaining_gb ?? 0) + opts.rewards.gb
        : base.traffic_remaining_gb,
  };

  const id = await upsertSubscription(env, next);
  const after = { ...next, id };

  await logChange(env, {
    customer_id: opts.customerId,
    subscription_id: id,
    action: "new",
    before: null,
    after,
    paid_minor: 0,
    detail: {
      source: opts.source,
      promotion_id: opts.promotionId,
      order_id: opts.orderId,
      carrier_plan_id: opts.planId,
      rewards: opts.rewards,
    },
  });

  try {
    await provisionSubscription(env, after);
  } catch (e) {
    console.error(
      `[gift] 开户落账失败 customer=${opts.customerId} plan=${opts.planId}: ${e instanceof Error ? e.message : e}`,
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
    /** 命中的批次码 id（`promotion_codes.id`）；用主码 / 系统发放时为 null */
    codeId?: number | null;
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

  // 有没有"地方可放"：有订阅 → 加权益；没有订阅 → 看礼包有没有配载体套餐。
  // 两者都没有就不建单 —— 否则账簿上会多一张 0 元订单，却对应不到任何权益。
  const before = await customerSubscription(env, opts.customerId);
  if (!before && !promo.plan_id) {
    return skip("还需要先有套餐；这个兑换码没有配置体验套餐，请联系客服");
  }

  const orderId = await createGiftOrder(env, promo, opts.customerId, now);

  let applied: { subscriptionId: number; applied: GiftRewards };
  let opened = false;
  if (before) {
    applied = await applyGift(env, {
      before,
      rewards: promo.rewards,
      promotionId: promo.id,
      orderId,
      source: opts.source,
    });
  } else {
    const result = await openFromCarrierPlan(env, {
      planId: promo.plan_id as string,
      customerId: opts.customerId,
      rewards: promo.rewards,
      promotionId: promo.id,
      orderId,
      source: opts.source,
      now,
    });
    if (!result) {
      // 载体套餐不可用（被删 / 不是 hidden / 已下架）：删掉刚建的单，保持账簿干净
      await env.DB.prepare(`DELETE FROM orders WHERE id = ?`).bind(orderId).run();
      return skip("礼包的体验套餐已不可用，请联系客服");
    }
    applied = result;
    opened = true;
  }

  await env.DB.prepare(
    `INSERT OR IGNORE INTO redemptions
       (promotion_id, customer_id, order_id, code_id, discount_minor, granted_json, created_at)
     VALUES (?, ?, ?, ?, 0, ?, ?)`,
  )
    .bind(
      promo.id,
      opts.customerId,
      orderId,
      opts.codeId ?? null,
      JSON.stringify(promo.rewards),
      now.toISOString(),
    )
    .run();

  return {
    promotion_id: promo.id,
    customer_id: opts.customerId,
    granted: true,
    opened,
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
