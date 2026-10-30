/**
 * 礼包发放（**权益层**）—— 契约 `app-crm.md` §2.9.6
 *
 * 与优惠券的区别只有一句：优惠券少收钱，礼包改权益。所以这里
 * **一分钱都不碰**（`benefit_value` 恒 0），只动订阅的 `expires_at` / `period_extra_gb` /
 * `traffic_total_gb`+`traffic_remaining_gb`。
 *
 * 四条硬规则：
 *   1. **必须有地方放**：有订阅 ⇒ 加到订阅上；没订阅 ⇒ 用礼包的「载体套餐」0 元开户。
 *   2. **两个维度互相独立，而且都是「加」不是「替换」**：送天数是在**原到期日**上加、送 GB 是在
 *      **原余额**上加，谁也不推谁、谁也不会把套餐自带的期限/流量拿掉。
 *      **不提供 "重置本月已用"** —— 那等于把已消费的流量变回额度，是改账不是送礼。
 *   3. **订阅没有这个权益就不改**：无限期（`expires_at = null`）不收天数、
 *      不限量（period 的 `period_quota_gb = null` / traffic 的 `traffic_total_gb = null`）
 *      不收 GB —— 两项都不适用就直接跳过，连 0 元订单都不建。
 *   4. **一次发放 = 一张 0 元已付订单**，且幂等靠次数与冷却（`max_uses_per_customer`
 *      + `cooldown_hours` 在发放前判定）：否则财务侧永远解释不了"这个人为什么多了 7 天"。
 */
import { EMPTY_REWARDS, PROMOTION_COLUMNS, hasRewards, rowToPromotion } from "./model";
import { checkForCustomer } from "./service";
import { provisionSubscription } from "../platform/provision";
import { GIGA, updateCustomer } from "../platform/client";
import {
  customerSubscription,
  freshenTraffic,
  logChange,
  upsertSubscription,
} from "../subscriptions/store";
import { rowToPlan } from "../plans/model";
import { subscriptionFromPlan } from "../plans/subscription";

import type { Env } from "../env";
import type { GiftRewards, Promotion, PromotionRow } from "./model";
import type { Plan, PlanRow } from "../plans/model";
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
 * 这份订阅**能收下**哪些奖励 —— 不适用的维度归 0。
 *
 *   - `days`：`expires_at === null`（永久 / 无限期）⇒ 延长无处可延，归 0
 *   - `gb`  ：period 的 `period_quota_gb === null`、traffic 的 `traffic_total_gb === null`
 *             （不限量）⇒ 加流量没有意义，归 0
 *
 * 两个维度**互不牵连**：能收天数不代表能收流量，反之亦然。
 */
export function applicableRewards(
  sub: Pick<Subscription, "kind" | "expires_at" | "period_quota_gb" | "traffic_total_gb">,
  rewards: GiftRewards,
): GiftRewards {
  const unlimited =
    sub.kind === "period" ? sub.period_quota_gb === null : sub.traffic_total_gb === null;
  return {
    days: sub.expires_at === null ? 0 : rewards.days,
    gb: unlimited ? 0 : rewards.gb,
  };
}

/**
 * 只把这次礼包**真正改动的字段**推到平台。
 *
 * 为什么不复用 `provisionSubscription`：它会写**全量控制参数**，其中
 * `traffic_balance` 对 period 是 `额度 + 池子` 的绝对值 —— 只送天数时这么写，
 * 会把用户本月**已经用掉的流量还回去**。所以这里按维度精确写：
 *   - 只有天数 ⇒ 只 PATCH `expire_date`
 *   - 有 GB   ⇒ 写 `平台真实剩余 + gb`（基数由调用方先 `freshenTraffic` 拿到）
 *
 * 还没落账（没有 `platform_customer_id`）的直接返回：等 `retryProvisioning`
 * 全量落账，那时平台上还没有任何已用量，`额度 + 池子` 就是对的。
 */
async function pushGift(
  env: Env,
  sub: Subscription,
  applied: GiftRewards,
  platformRemainingGb: number | null | undefined,
  expiresAt: string | null,
): Promise<void> {
  if (!sub.platform_customer_id) return;

  const patch: Record<string, unknown> = {};
  if (applied.days > 0 && expiresAt) patch.expire_date = expiresAt.slice(0, 10);
  if (applied.gb > 0 && platformRemainingGb !== undefined && platformRemainingGb !== null) {
    patch.traffic_balance = Math.round((platformRemainingGb + applied.gb) * GIGA);
  }
  if (Object.keys(patch).length === 0) return;
  await updateCustomer(env, sub.platform_customer_id, patch);
}

/**
 * 把奖励项作用到**已有订阅**上，并落账到 cf-api。
 *
 * 调用方必须先确认订阅存在、且 `applied` 已经过 `applicableRewards` 过滤
 * （全 0 时不该走到这里）—— 这里不再判空，以免"先建单、后发现没订阅"留下无主订单。
 */
async function applyGift(
  env: Env,
  opts: {
    before: Subscription;
    /** 已经过滤过"这份订阅收不收得下"的奖励 */
    applied: GiftRewards;
    promotionId: number;
    orderId: number;
    source: GiftSource;
    /** 已落账时的平台真实剩余（GB）；未落账传 undefined */
    platformRemainingGb?: number | null;
  },
): Promise<{ subscriptionId: number; applied: GiftRewards }> {
  const before = opts.before;
  const customerId = before.customer_id;
  const { days, gb } = opts.applied;

  const next: Subscription = { ...before };

  // 天数：只改到期日（`applicableRewards` 已保证 expires_at 非 null）
  if (days > 0 && next.expires_at !== null) {
    next.expires_at = new Date(Date.parse(next.expires_at) + days * DAY_MS).toISOString();
  }

  // 流量：period 进额外池；traffic 抬高整包与剩余。基准都取平台真实剩余（有就优先）
  if (gb > 0) {
    if (next.kind === "traffic") {
      next.traffic_total_gb = (next.traffic_total_gb ?? 0) + gb;
    } else {
      next.period_extra_gb = (next.period_extra_gb ?? 0) + gb;
    }
    const base = opts.platformRemainingGb ?? next.traffic_remaining_gb;
    next.traffic_remaining_gb = base === null ? null : base + gb;
    if (opts.platformRemainingGb !== undefined && opts.platformRemainingGb !== null) {
      // 我们马上就把这个数写到平台 ⇒ 缓存就是真值
      next.traffic_synced_at = new Date().toISOString();
    }
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
      rewards: opts.applied,
    },
  });

  try {
    await pushGift(env, after, opts.applied, opts.platformRemainingGb, next.expires_at);
  } catch (e) {
    // 本地账已记；推特失败交给月结/人工补齐，不影响发放结论
    console.error(
      `[gift] 落账失败 customer=${customerId} promo=${opts.promotionId}: ${e instanceof Error ? e.message : e}`,
    );
  }

  return { subscriptionId: id, applied: opts.applied };
}

/**
 * 读礼包的**载体套餐**（客户还没有订阅时用它 0 元开户）。
 *
 * 语义分工：**套餐管"是什么包"**（流量 / 线路 / 设备数），
 * **礼包管"再多送多少"**（`rewards.days` / `rewards.gb`，都是在套餐基础上**累加**
 * 而不是覆盖）—— 与 XBoard 的 `plan_id` + `plan_validity_days` 同一个道理。
 *
 * 只允许 `visibility='hidden'` 的套餐：公开套餐能被直接买到，
 * 拿它当载体等于开了个 0 元购买通道。
 *
 * @returns `null` = 不可用（不存在 / 不是 hidden / 已下架 / 是加购包）
 */
async function loadCarrierPlan(env: Env, planId: string): Promise<Plan | null> {
  const row = await env.DB.prepare(
    `SELECT id, name, kind, price_minor, currency, licence_limit, term_days, monthly_quota_gb,
       traffic_gb, validity_days, line_ids, up_mbps, down_mbps, sales_channels,
       store_product_id, sort_order, status, retired_at, visibility
     FROM plans WHERE id = ?`,
  )
    .bind(planId)
    .first<PlanRow & { visibility: string }>();
  if (!row) return null;
  if (row.visibility !== "hidden" || row.status !== "active") return null;

  const plan = rowToPlan(row);
  if (plan.kind === "addon") return null; // 加购包不产生订阅
  return plan;
}

/**
 * 用载体套餐 0 元开户，并把已经过滤过的奖励叠上去。
 *
 * `base` 由调用方算好（同一份快照也用来判断"礼包对它有没有意义"），
 * 这里只负责落库与落账。
 */
async function openFromCarrierPlan(
  env: Env,
  opts: {
    planId: string;
    /** 已算好的骨架快照（同一份也用来判断礼包对它有没有意义） */
    base: Omit<Subscription, "id">;
    /** 已经过 `applicableRewards` 过滤 */
    applied: GiftRewards;
    promotionId: number;
    orderId: number;
    source: GiftSource;
  },
): Promise<{ subscriptionId: number; applied: GiftRewards }> {
  const { base, applied } = opts;
  const customerId = base.customer_id;

  const next: Subscription = { ...base, id: 0 };

  // 天数：在**套餐给的期限之上再加**（不是覆盖）—— 载体套餐自己有 30 天、
  // 礼包再送 7 天，用户拿到的是 37 天。`base.expires_at === null`（永久）时
  // `applied.days` 已经归 0，这里不会动。
  if (applied.days > 0 && base.expires_at !== null) {
    next.expires_at = new Date(Date.parse(base.expires_at) + applied.days * DAY_MS).toISOString();
  }
  if (applied.gb > 0) {
    if (base.kind === "traffic") {
      next.traffic_total_gb = (base.traffic_total_gb ?? 0) + applied.gb;
      next.traffic_remaining_gb = (base.traffic_remaining_gb ?? 0) + applied.gb;
    } else {
      next.period_extra_gb = (base.period_extra_gb ?? 0) + applied.gb;
    }
  }

  const id = await upsertSubscription(env, next);
  const after = { ...next, id };

  await logChange(env, {
    customer_id: customerId,
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
      rewards: opts.applied,
    },
  });

  try {
    // 新开户要**建客户**，所以走全量落账（此时平台上还没有已用量，`额度 + 池子` 就是对的）
    await provisionSubscription(env, after);
  } catch (e) {
    console.error(
      `[gift] 开户落账失败 customer=${customerId} plan=${opts.planId}: ${e instanceof Error ? e.message : e}`,
    );
  }

  return { subscriptionId: id, applied: opts.applied };
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
    applied: EMPTY_REWARDS,
  });

  const check = await checkForCustomer(env, promo, opts.customerId, now, {
    assumeFirstPurchase: opts.assumeFirstPurchase ?? opts.source === "signup",
  });
  if (!check.ok) return skip(check.reason);

  // 有没有"地方可放"：有订阅 → 加权益；没有订阅 → 看礼包有没有配载体套餐。
  const before = await customerSubscription(env, opts.customerId);

  let plan: Plan | null = null;
  if (!before) {
    if (!promo.plan_id) {
      return skip("还需要先有套餐；这个兑换码没有配置体验套餐，请联系客服");
    }
    plan = await loadCarrierPlan(env, promo.plan_id);
    if (!plan) return skip("礼包的体验套餐已不可用，请联系客服");
  }

  // 先算出"目标订阅快照"，再判断礼包**对它有没有意义**：
  // 无限期不收天数、不限量不收 GB。两条都不适用就**不发放、也不建 0 元订单**。
  const target =
    before ??
    subscriptionFromPlan(plan as Plan, { customerId: opts.customerId, paidMinor: 0, now });
  const appliedRewards = applicableRewards(target, promo.rewards);
  if (!hasRewards(appliedRewards)) {
    return skip("这个礼包送的内容对当前套餐不适用（不限量 / 无限期），未发放");
  }

  // 送 GB 必须落在**平台真实剩余**上：先回源，读不到就不发 ——
  // 拿旧缓存去加，会把用户这段时间用掉的流量又还回去。
  let platformRemainingGb: number | undefined;
  if (appliedRewards.gb > 0 && before?.platform_customer_id) {
    const fresh = await freshenTraffic(env, before);
    if (!fresh || fresh.traffic_remaining_gb === null) {
      return skip("平台的剩余流量暂时读不到，礼包稍后再发");
    }
    platformRemainingGb = fresh.traffic_remaining_gb;
  }

  const orderId = await createGiftOrder(env, promo, opts.customerId, now);

  let result: { subscriptionId: number; applied: GiftRewards };
  let opened = false;
  if (before) {
    result = await applyGift(env, {
      before,
      applied: appliedRewards,
      promotionId: promo.id,
      orderId,
      source: opts.source,
      platformRemainingGb,
    });
  } else {
    result = await openFromCarrierPlan(env, {
      planId: promo.plan_id as string,
      base: target,
      applied: appliedRewards,
      promotionId: promo.id,
      orderId,
      source: opts.source,
    });
    opened = true;
  }
  const applied = result;

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
      // 记**实际生效**的维度，不是配置值（不间断量/无限期时可能少一项）
      JSON.stringify(applied.applied),
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
