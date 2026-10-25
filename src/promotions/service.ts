/**
 * 促销取数层：把 `promotions` / `redemptions` 读成纯函数要的上下文
 *
 * 纯判断在 `./model.ts`，这里只做「查库 + 拼上下文 + 记一次核销」。
 * 拆开的好处：所有"能不能用 / 便宜多少"的规则都能脱离 D1 单测。
 */
import { PROMOTION_COLUMNS, badgeOf, checkPromotion, appliedOf, rowToPromotion } from "./model";

import type { AppliedPromotion, PromoContext, Promotion, PromotionRow } from "./model";
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
}

async function allActivePromotions(env: Env): Promise<Promotion[]> {
  const rows = await env.DB.prepare(
    `SELECT ${PROMOTION_COLUMNS} FROM promotions WHERE status = 'active' ORDER BY id`,
  ).all<PromotionRow>();
  return (rows.results ?? []).map(rowToPromotion);
}

/** 活动 → 已核销次数（总量 / 该用户） */
export async function usageOf(
  env: Env,
  promotionIds: readonly number[],
  customerId: number | null,
): Promise<Map<number, { total: number; byCustomer: number }>> {
  const out = new Map<number, { total: number; byCustomer: number }>();
  if (!promotionIds.length) return out;
  const marks = promotionIds.map(() => "?").join(",");

  const totals = await env.DB.prepare(
    `SELECT promotion_id, COUNT(*) AS n FROM redemptions
      WHERE promotion_id IN (${marks}) GROUP BY promotion_id`,
  )
    .bind(...promotionIds)
    .all<{ promotion_id: number; n: number }>();
  for (const row of totals.results ?? []) out.set(row.promotion_id, { total: row.n, byCustomer: 0 });

  if (customerId !== null) {
    const mine = await env.DB.prepare(
      `SELECT promotion_id, COUNT(*) AS n FROM redemptions
        WHERE promotion_id IN (${marks}) AND customer_id = ? GROUP BY promotion_id`,
    )
      .bind(...promotionIds, customerId)
      .all<{ promotion_id: number; n: number }>();
    for (const row of mine.results ?? []) {
      const cur = out.get(row.promotion_id) ?? { total: 0, byCustomer: 0 };
      out.set(row.promotion_id, { ...cur, byCustomer: row.n });
    }
  }
  return out;
}

/** 客户侧的两个事实：是不是首单、注册几天了（匿名时都是 null） */
async function customerFacts(
  env: Env,
  customerId: number | null,
  now: Date,
): Promise<{ first_purchase: boolean | null; customer_age_days: number | null }> {
  if (customerId === null) return { first_purchase: null, customer_age_days: null };

  const row = await env.DB.prepare(`SELECT created_at FROM customers WHERE id = ?`)
    .bind(customerId)
    .first<{ created_at: string }>();
  const ageDays = row
    ? Math.max(0, Math.floor((now.getTime() - Date.parse(row.created_at)) / 86_400_000))
    : null;

  // "付过钱"的口径：只要产生过一笔成功的收款，就不再是新客
  const paid = await env.DB.prepare(
    `SELECT 1 AS x FROM orders
      WHERE customer_id = ? AND status IN ('paid', 'provisioning', 'active', 'refunded') LIMIT 1`,
  )
    .bind(customerId)
    .first<{ x: number }>();

  return { first_purchase: !paid, customer_age_days: ageDays };
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
  plan: Plan,
  now: Date,
  facts: { first_purchase: boolean | null; customer_age_days: number | null },
  uses: { total: number; byCustomer: number },
  subtotalMinor: number,
): PromoContext {
  return {
    plan_id: plan.id,
    plan_kind: plan.kind,
    subtotal_minor: subtotalMinor,
    now,
    first_purchase: facts.first_purchase,
    customer_age_days: facts.customer_age_days,
    uses_total: uses.total,
    uses_by_customer: uses.byCustomer,
  };
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

  const auto = active.filter((p) => p.code === null && p.kind === "coupon");
  const referral = referralId === null ? [] : active.filter((p) => p.id === referralId);
  // 只有 coupon 能当代码用：referral 活动靠**关系**生效，它的码没法也不应该被
  // 任何人拿去直接抵扣（否则等于一个匿名优惠码 + 不产生归因）
  const byCode = code
    ? active.find((p) => p.kind === "coupon" && (p.code ?? "").toUpperCase() === code) ?? null
    : null;

  const candidates = [...auto, ...referral];
  if (!code) {
    return {
      applied: await pickBestPerPromotion(
        env, candidates, opts.plan, now, facts, subtotal, opts.customerId,
      ),
      error: null,
    };
  }

  if (!byCode) return { applied: null, error: "优惠码不存在" };

  const usage = await usageOf(env, [byCode.id], opts.customerId);
  const ctx = contextFor(
    opts.plan,
    now,
    facts,
    usage.get(byCode.id) ?? { total: 0, byCustomer: 0 },
    subtotal,
  );
  const check = checkPromotion(byCode, ctx);
  if (!check.ok) return { applied: null, error: check.reason };

  // 码有效时仍与自动活动/邀请活动比一次：**取更优，不叠加**
  const others = [...auto, ...referral].filter((p) => p.id !== byCode.id);
  const best = await pickBestPerPromotion(env, others, opts.plan, now, facts, subtotal, opts.customerId);
  const codeApplied = appliedOf(byCode, subtotal);
  if (best && best.discount_minor > codeApplied.discount_minor) return { applied: best, error: null };
  return { applied: codeApplied, error: null };
}

/** 每个活动有自己的核销次数，所以逐活动判断（数量在个位数，够用） */async function pickBestPerPromotion(
  env: Env,
  list: readonly Promotion[],
  plan: Plan,
  now: Date,
  facts: { first_purchase: boolean | null; customer_age_days: number | null },
  subtotalMinor: number,
  customerId: number | null,
): Promise<AppliedPromotion | null> {
  if (!list.length) return null;
  const usage = await usageOf(env, list.map((p) => p.id), customerId);
  let best: AppliedPromotion | null = null;
  for (const p of [...list].sort((a, b) => a.id - b.id)) {
    const ctx = contextFor(plan, now, facts, usage.get(p.id) ?? { total: 0, byCustomer: 0 }, subtotalMinor);
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
    (p) => (p.code === null && p.kind === "coupon") || (referralId !== null && p.id === referralId),
  );
  if (!candidates.length) return out;

  const facts = await customerFacts(env, opts.customerId, now);
  const usage = await usageOf(env, candidates.map((p) => p.id), opts.customerId);
  const sorted = [...candidates].sort((a, b) => a.id - b.id);

  for (const plan of opts.plans) {
    let best: AppliedPromotion | null = null;
    for (const p of sorted) {
      const ctx = contextFor(plan, now, facts, usage.get(p.id) ?? { total: 0, byCustomer: 0 }, plan.price_minor);
      if (!checkPromotion(p, ctx).ok) continue;
      const applied = appliedOf(p, plan.price_minor);
      if (applied.discount_minor <= 0) continue;
      if (!best || applied.discount_minor > best.discount_minor) best = applied;
    }
    if (best) out.set(plan.id, best);
  }
  return out;
}

export interface PlanBadge {
  badge_label: string;
  original_price_minor: number;
  payable_minor: number;
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
  order: { id: number; customer_id: number; promotion_id: number | null; discount_minor: number },
  now: Date = new Date(),
): Promise<void> {
  if (!order.promotion_id) return;
  await env.DB.prepare(
    `INSERT OR IGNORE INTO redemptions
       (promotion_id, customer_id, order_id, discount_minor, granted_json, created_at)
     VALUES (?, ?, ?, ?, NULL, ?)`,
  )
    .bind(order.promotion_id, order.customer_id, order.id, order.discount_minor, now.toISOString())
    .run();
}/**
 * 列表页角标（**公开信息**，与"这个人能不能用"无关）。
 *
 * 用"最理想客户"的上下文算：新客、零次数 —— 这样"新人首单 8 折"也能公开显示。
 * 真正能否享受由 `/quote` 按本人上下文判定。
 */
export async function planBadges(
  env: Env,
  plans: readonly Plan[],
  now: Date = new Date(),
): Promise<Map<string, PlanBadge>> {
  const out = new Map<string, PlanBadge>();
  if (!plans.length) return out;

  const active = (await allActivePromotions(env)).filter((p) => p.visible && p.badge_label);
  if (!active.length) return out;

  // 角标不做次数判断：这里只是文案，不是承诺
  const facts = { first_purchase: true, customer_age_days: 0 };
  const zero = { total: 0, byCustomer: 0 };

  for (const plan of plans) {
    const best = badgeOf(active, contextFor(plan, now, facts, zero, plan.price_minor));
    if (!best) continue;
    out.set(plan.id, {
      badge_label: best.promotion.badge_label ?? best.label,
      original_price_minor: plan.price_minor,
      payable_minor: Math.max(0, plan.price_minor - best.discount_minor),
    });
  }
  return out;
}
