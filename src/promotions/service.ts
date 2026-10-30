/**
 * 促销取数层：把 `promotions` / `redemptions` 读成纯函数要的上下文
 *
 * 纯判断在 `./model.ts`，这里只做「查库 + 拼上下文 + 记一次核销」。
 * 拆开的好处：所有"能不能用 / 便宜多少"的规则都能脱离 D1 单测。
 */
import { lookupCode } from "./codes";
import { PROMOTION_COLUMNS, canAppearInList, checkPromotion, appliedOf, promoBadgeText, rowToPromotion, discountOf } from "./model";

import type { AppliedPromotion, PromoContext, Promotion, PromotionCheck, PromotionRow } from "./model";
import type { PlanKind } from "../plans/model";
import type { Env } from "../env";
import type { Plan } from "../plans/model";

/** 一次报价/下单的促销结论 */
export interface PromoResolution {
  /** 命中的活动（已含折扣金额与文案）；`null` = 没有可用活动 */
  applied: AppliedPromotion | null;
  /**
   * 用户**主动输入了码**却不能用时的整句理由。
   * 只有"输入了码"才可能非 null —— 自动活动不适用时静默跳过。
   */
  error: string | null;
  /** 命中的批次码 id（一码一人的券），下单时要落到订单上才能算用量 */
  codeId: number | null;
}

async function allActivePromotions(env: Env): Promise<Promotion[]> {
  const rows = await env.DB.prepare(
    `SELECT ${PROMOTION_COLUMNS} FROM promotions WHERE status = 'active' ORDER BY id`,
  ).all<PromotionRow>();
  return (rows.results ?? []).map(rowToPromotion);
}

/** 活动 → 已核销次数（总量 / 该用户）+ 该用户上次核销时间（冷却用） */
export async function usageOf(
  env: Env,
  promotionIds: readonly number[],
  customerId: number | null,
): Promise<Map<number, { total: number; byCustomer: number; lastAt: string | null }>> {
  const out = new Map<number, { total: number; byCustomer: number; lastAt: string | null }>();
  if (!promotionIds.length) return out;
  const marks = promotionIds.map(() => "?").join(",");

  // **只数已完成的核销**（`order_id IS NOT NULL`）：占位行代表"正在发"，
  // 它不是核销 —— 数进去会让同一份礼包在发放途中被认为是"已经领过"，
  // 也会让名额在发放失败前被白占。
  const totals = await env.DB.prepare(
    `SELECT promotion_id, COUNT(*) AS n FROM redemptions
      WHERE promotion_id IN (${marks}) AND order_id IS NOT NULL GROUP BY promotion_id`,
  )
    .bind(...promotionIds)
    .all<{ promotion_id: number; n: number }>();
  for (const row of totals.results ?? []) {
    out.set(row.promotion_id, { total: row.n, byCustomer: 0, lastAt: null });
  }

  if (customerId !== null) {
    const mine = await env.DB.prepare(
      `SELECT promotion_id, COUNT(*) AS n, MAX(created_at) AS last_at FROM redemptions
        WHERE promotion_id IN (${marks}) AND customer_id = ? AND order_id IS NOT NULL
        GROUP BY promotion_id`,
    )
      .bind(...promotionIds, customerId)
      .all<{ promotion_id: number; n: number; last_at: string | null }>();
    for (const row of mine.results ?? []) {
      const cur = out.get(row.promotion_id) ?? { total: 0, byCustomer: 0, lastAt: null };
      out.set(row.promotion_id, { ...cur, byCustomer: row.n, lastAt: row.last_at });
    }
  }
  return out;
}

/** 哪些活动**点名**了这个客户（`audience='specific'`） */
async function targetedOf(
  env: Env,
  promotionIds: readonly number[],
  customerId: number | null,
): Promise<Set<number>> {
  const out = new Set<number>();
  if (customerId === null || !promotionIds.length) return out;
  const marks = promotionIds.map(() => "?").join(",");
  const rows = await env.DB.prepare(
    `SELECT promotion_id FROM promotion_targets
      WHERE promotion_id IN (${marks}) AND customer_id = ?`,
  )
    .bind(...promotionIds, customerId)
    .all<{ promotion_id: number }>();
  for (const row of rows.results ?? []) out.add(row.promotion_id);
  return out;
}

/** 客户侧的事实：首单?、注册几天?、有没有在用订阅?、还有几天到期?（匿名时都是 null） */
type CustomerFacts = {
  first_purchase: boolean | null;
  customer_age_days: number | null;
  has_active_sub: boolean | null;
  days_to_expiry: number | null;
};

const ANON_FACTS: CustomerFacts = {
  first_purchase: null,
  customer_age_days: null,
  has_active_sub: null,
  days_to_expiry: null,
};

async function customerFacts(env: Env, customerId: number | null, now: Date): Promise<CustomerFacts> {
  if (customerId === null) return ANON_FACTS;

  const row = await env.DB.prepare(`SELECT created_at FROM customers WHERE id = ?`)
    .bind(customerId)
    .first<{ created_at: string }>();
  const ageDays = row
    ? Math.max(0, Math.floor((now.getTime() - Date.parse(row.created_at)) / 86_400_000))
    : null;

  // "付过钱"的口径：**真的收过钱**才算。0 元单（赠单 / 注册试用）不算 ——
  // 否则用户一领试用就失去所有新人优惠，而那正是最需要优惠的转化时刻（I5 也规定赠单不计收入）。
  const paid = await env.DB.prepare(
    `SELECT 1 AS x FROM orders
      WHERE customer_id = ? AND amount_minor > 0
        AND status IN ('paid', 'provisioning', 'active', 'refunded') LIMIT 1`,
  )
    .bind(customerId)
    .first<{ x: number }>();

  // 订阅状态是**算出来的**（domain.md §1.3）：hold=none 且未到期才算在用
  const sub = await env.DB.prepare(
    `SELECT hold, expires_at FROM platform_subscriptions WHERE customer_id = ?`,
  )
    .bind(customerId)
    .first<{ hold: string; expires_at: string | null }>();
  let hasActive = false;
  let daysToExpiry: number | null = null;
  if (sub && sub.hold === "none") {
    if (sub.expires_at === null) {
      hasActive = true; // 不限期的套餐：永远在有效期内，但不存在"快到期"
    } else {
      const ms = Date.parse(sub.expires_at) - now.getTime();
      hasActive = ms > 0;
      daysToExpiry = ms > 0 ? Math.ceil(ms / 86_400_000) : Math.floor(ms / 86_400_000);
    }
  }

  return {
    first_purchase: !paid,
    customer_age_days: ageDays,
    has_active_sub: hasActive,
    days_to_expiry: hasActive ? daysToExpiry : null,
  };
}

/** 该客户绑定的邀请活动（`referrals.promotion_id`）；没有绑定就是 null */
async function referralPromotionId(env: Env, customerId: number | null): Promise<number | null> {
  if (customerId === null) return null;
  const row = await env.DB.prepare(`SELECT promotion_id FROM referrals WHERE customer_id = ?`)
    .bind(customerId)
    .first<{ promotion_id: number | null }>();
  return row?.promotion_id ?? null;
}

function contextFor(
  plan: { id: string; kind: PlanKind },
  now: Date,
  facts: CustomerFacts,
  uses: { total: number; byCustomer: number; lastAt: string | null },
  subtotalMinor: number,
  targeted: boolean,
): PromoContext {
  return {
    plan_id: plan.id,
    plan_kind: plan.kind,
    subtotal_minor: subtotalMinor,
    now,
    first_purchase: facts.first_purchase,
    customer_age_days: facts.customer_age_days,
    has_active_sub: facts.has_active_sub,
    days_to_expiry: facts.days_to_expiry,
    targeted,
    uses_total: uses.total,
    uses_by_customer: uses.byCustomer,
    last_used_at: uses.lastAt,
  };
}

/**
 * 单个活动对某个客户到底能不能用（礼包发放、后台试算都用它）。
 *
 * 与 `resolvePromotion` 的区别：不比较活动之间谁更优 ——
 * 礼包是"点名发给你"的，不存在"选一个更划算的"。
 */
export async function checkForCustomer(
  env: Env,
  promo: Promotion,
  customerId: number | null,
  now: Date = new Date(),
  opts: {
    /**
     * 把客户当成「首单客户」。
     *
     * 只在**注册/首单礼包**里用：那一刻订单刚刚变 paid，
     * 按 `orders` 算出来的 `first_purchase` 已经是 false，
     * 但语义上他确实还是新客 —— 不这样处理，`audience='new'` 的礼包永远发不出去。
     */
    assumeFirstPurchase?: boolean;
  } = {},
): Promise<PromotionCheck> {
  const facts = await customerFacts(env, customerId, now);
  if (opts.assumeFirstPurchase && facts.first_purchase === false) {
    facts.first_purchase = true;
  }
  const sub = customerId === null
    ? null
    : await env.DB.prepare(`SELECT plan_id, kind FROM platform_subscriptions WHERE customer_id = ?`)
      .bind(customerId)
      .first<{ plan_id: string; kind: PlanKind }>();
  const usage = await usageOf(env, [promo.id], customerId);
  const targeted = await targetedOf(env, [promo.id], customerId);
  const ctx = contextFor(
    { id: sub?.plan_id ?? "", kind: sub?.kind ?? "addon" },
    now,
    facts,
    usage.get(promo.id) ?? { total: 0, byCustomer: 0, lastAt: null },
    promo.min_subtotal_minor,
    targeted.has(promo.id),
  );
  return checkPromotion(promo, ctx);
}

/**
 * 解析"这一单能用什么促销"。
 *
 * 候选集只有三类，且**最多生效一个**（不变量 3，取更优）：
 *   1. 自动活动（`code IS NULL` 且 `kind='coupon'`）
 *   2. 用户输入的码（`code` 精确匹配，大小写不敏感）
 *   3. 该客户的邀请活动（`kind='referral'`，靠 `referrals` 关系生效，不需要输码）
 *
 * @param subtotalMinor 折扣前的金额 —— **恒为套餐标价**（残值不参与打折）
 */
export async function resolvePromotion(
  env: Env,
  opts: {
    plan: Plan;
    customerId: number | null;
    code?: string | null;
    subtotalMinor?: number;
    now?: Date;
  },
): Promise<PromoResolution> {
  const now = opts.now ?? new Date();
  const subtotal = opts.subtotalMinor ?? opts.plan.price_minor;
  const code = (opts.code ?? "").trim().toUpperCase();

  const active = await allActivePromotions(env);
  const facts = await customerFacts(env, opts.customerId, now);
  const referralId = await referralPromotionId(env, opts.customerId);

  const auto = active.filter((p) => p.auto_apply && p.kind === "coupon");
  const referral = referralId === null ? [] : active.filter((p) => p.id === referralId);
  // 只有 coupon 能当代码用：referral 活动靠**关系**生效，它的码没法也不应该被
  // 任何人拿去直接抵扣（否则等于一个匿名优惠码 + 不产生归因）
  // 用户输入的码可能是**主码**，也可能是**批次码**（契约 §2.9.7）——
  // lookupCode 会先查主码再看批次表，返回的 promotion 两种情况都一样。
  const hit = code ? await lookupCode(env, code) : null;
  const byCode = hit && hit.promotion.kind === "coupon" ? hit.promotion : null;

  const candidates = [...auto, ...referral];
  if (!code) {
    return {
      applied: await pickBestPerPromotion(
        env, candidates, opts.plan, now, facts, subtotal, opts.customerId,
      ),
      error: null,
      codeId: null,
    };
  }

  if (!byCode) return { applied: null, error: "优惠码不存在", codeId: null };

  // 码本身的限制（一码一人的批次码用完就作废；码也可以有独立的过期时间）
  if (hit?.expiresAt && Date.parse(hit.expiresAt) <= now.getTime()) {
    return { applied: null, error: "这个码已经过期了", codeId: null };
  }
  if (hit && hit.used >= hit.maxUses) {
    return { applied: null, error: "这个码已经被用过了", codeId: null };
  }

  const usage = await usageOf(env, [byCode.id], opts.customerId);
  const targeted = await targetedOf(env, [byCode.id], opts.customerId);
  const ctx = contextFor(
    opts.plan,
    now,
    facts,
    usage.get(byCode.id) ?? { total: 0, byCustomer: 0, lastAt: null },
    subtotal,
    targeted.has(byCode.id),
  );
  const check = checkPromotion(byCode, ctx);
  if (!check.ok) return { applied: null, error: check.reason, codeId: null };

  // 码有效时仍与自动活动/邀请活动比一次：**取更优，不叠加**
  const others = [...auto, ...referral].filter((p) => p.id !== byCode.id);
  const best = await pickBestPerPromotion(env, others, opts.plan, now, facts, subtotal, opts.customerId);
  const codeApplied = appliedOf(byCode, subtotal);
  if (best && best.discount_minor > codeApplied.discount_minor) {
    return { applied: best, error: null, codeId: null };
  }
  return { applied: codeApplied, error: null, codeId: hit?.codeId ?? null };
}

/** 每个活动有自己的核销次数，所以逐活动判断（数量在个位数，够用） */async function pickBestPerPromotion(
  env: Env,
  list: readonly Promotion[],
  plan: Plan,
  now: Date,
  facts: CustomerFacts,
  subtotalMinor: number,
  customerId: number | null,
): Promise<AppliedPromotion | null> {
  if (!list.length) return null;
  const usage = await usageOf(env, list.map((p) => p.id), customerId);
  const targeted = await targetedOf(env, list.map((p) => p.id), customerId);
  let best: AppliedPromotion | null = null;
  for (const p of [...list].sort((a, b) => a.id - b.id)) {
    const ctx = contextFor(
      plan,
      now,
      facts,
      usage.get(p.id) ?? { total: 0, byCustomer: 0, lastAt: null },
      subtotalMinor,
      targeted.has(p.id),
    );
    if (!checkPromotion(p, ctx).ok) continue;
    const applied = appliedOf(p, subtotalMinor);
    if (applied.discount_minor <= 0) continue;
    if (!best || applied.discount_minor > best.discount_minor) best = applied;
  }
  return best;
}

/**
 * 列表页用：一次把所有套餐的"这个人能享受到的促销"算出来。
 *
 * 与 `resolvePromotion` 的区别：不处理用户输入的码（列表页没有输入框），
 * 且只查一次库 —— 套餐有几个都要一份答案，不能每个套餐各扫一遍活动表。
 */
export async function resolveForPlans(
  env: Env,
  opts: { plans: readonly Plan[]; customerId: number | null; now?: Date },
): Promise<Map<string, AppliedPromotion>> {
  const out = new Map<string, AppliedPromotion>();
  if (!opts.plans.length) return out;
  const now = opts.now ?? new Date();

  const active = await allActivePromotions(env);
  const referralId = await referralPromotionId(env, opts.customerId);
  const candidates = active.filter(
    (p) => (p.auto_apply && p.kind === "coupon") || (referralId !== null && p.id === referralId),
  );
  if (!candidates.length) return out;

  const facts = await customerFacts(env, opts.customerId, now);
  const usage = await usageOf(env, candidates.map((p) => p.id), opts.customerId);
  const targeted = await targetedOf(env, candidates.map((p) => p.id), opts.customerId);
  const sorted = [...candidates].sort((a, b) => a.id - b.id);

  for (const plan of opts.plans) {
    let best: AppliedPromotion | null = null;
    for (const p of sorted) {
      const ctx = contextFor(
        plan,
        now,
        facts,
        usage.get(p.id) ?? { total: 0, byCustomer: 0, lastAt: null },
        plan.price_minor,
        targeted.has(p.id),
      );
      if (!checkPromotion(p, ctx).ok) continue;
      const applied = appliedOf(p, plan.price_minor);
      if (applied.discount_minor <= 0) continue;
      if (!best || applied.discount_minor > best.discount_minor) best = applied;
    }
    if (best) out.set(plan.id, best);
  }
  return out;
}

export interface PlanPromo {
  promotion: Promotion;
  /** 满足条件的客户能少付多少 */
  discount_minor: number;
  /** 含人群前缀的完整角标（`限新用户 · 首单 8 折`） */
  badge_label: string;
  /** 活动价；划线价仍是 `plan.price_minor` */
  promo_price_minor: number;
}

/**
 * 匿名访客看到的"该人群最优情形"。
 *
 * 匿名时我们不知道他是不是新客、有没有订阅，所以按**这个活动自己的目标人群**
 * 取最有利的假设算一遍 —— 条件已经写进角标前缀（`限新用户`），所以不是欺骗。
 * 名额、时间窗、套餐范围、门槛这些**与身份无关**的条件仍然按真实值判。
 */
function audienceBestCase(p: Promotion): CustomerFacts {
  const base: CustomerFacts = {
    first_purchase: false,
    customer_age_days: 0,
    has_active_sub: false,
    days_to_expiry: null,
  };
  switch (p.audience) {
    case "new":
      return { ...base, first_purchase: true };
    case "existing":
    case "expiring":
      return { ...base, has_active_sub: true, days_to_expiry: 1 };
    case "expired":
      return base;
    default:
      return base;
  }
}

/**
 * 定价页展示位（契约 §2.9.3，v19）。
 *
 * 与旧 `planBadges` 的根本区别：**不再用"最理想客户"的假画像**。
 *   - 登录用户：按真实上下文判定 —— 与 `/plans.payable_minor`、`/quote` 完全同源，
 *     不可能出现"定价页 8 折、结账原价"
 *   - 匿名访客：按该人群的最优情形判定，并把条件写进角标前缀
 *
 * 名额用完 / 未开始 / 已过期 / 门槛不到 / 套餐不适用 → 一律不出现（角标是承诺）。
 */
export async function planPromos(
  env: Env,
  opts: { plans: readonly Plan[]; customerId: number | null; now?: Date },
): Promise<Map<string, PlanPromo>> {
  const out = new Map<string, PlanPromo>();
  if (!opts.plans.length) return out;
  const now = opts.now ?? new Date();

  // 只有自动生效的券才有展示位：凭码券是站外渠道（模型见 `canAppearInList`）
  const candidates = (await allActivePromotions(env)).filter(canAppearInList);
  if (!candidates.length) return out;

  const facts = opts.customerId === null ? null : await customerFacts(env, opts.customerId, now);
  const usage = await usageOf(env, candidates.map((p) => p.id), opts.customerId);
  const targeted = await targetedOf(env, candidates.map((p) => p.id), opts.customerId);

  for (const plan of opts.plans) {
    let best: PlanPromo | null = null;
    for (const p of candidates) {
      const used = usage.get(p.id) ?? { total: 0, byCustomer: 0, lastAt: null };
      const ctx = contextFor(
        plan,
        now,
        facts ?? audienceBestCase(p),
        // 匿名时不存在"这个人用过几次"：沿用全站次数，个人次数归零
        facts ? used : { total: used.total, byCustomer: 0, lastAt: null },
        plan.price_minor,
        targeted.has(p.id),
      );
      if (!checkPromotion(p, ctx).ok) continue;
      const discount = discountOf(p, plan.price_minor);
      if (discount <= 0) continue;
      if (!best || discount > best.discount_minor) {
        best = {
          promotion: p,
          discount_minor: discount,
          badge_label: promoBadgeText(p),
          promo_price_minor: Math.max(0, plan.price_minor - discount),
        };
      }
    }
    if (best) out.set(plan.id, best);
  }
  return out;
}

/**
 * 核销一笔**已支付**订单上的促销。
 *
 * 幂等靠 `(promotion_id, order_id)` 唯一约束 + `INSERT OR IGNORE`：
 * 回调重放、`provisionOrder` 重试都不会重复占用名额。
 * **调用点只有一个**：`payments/notify.ts` 的 `grant()`（钱到账之后）。
 */
export async function redeemOrderPromotion(
  env: Env,
  order: {
    id: number;
    customer_id: number;
    promotion_id: number | null;
    code_id: number | null;
    discount_minor: number;
  },
  now: Date = new Date(),
): Promise<void> {
  if (!order.promotion_id) return;
  await env.DB.prepare(
    `INSERT OR IGNORE INTO redemptions
       (promotion_id, customer_id, order_id, code_id, discount_minor, granted_json, created_at)
     VALUES (?, ?, ?, ?, ?, NULL, ?)`,
  )
    .bind(
      order.promotion_id,
      order.customer_id,
      order.id,
      order.code_id,
      order.discount_minor,
      now.toISOString(),
    )
    .run();
}
