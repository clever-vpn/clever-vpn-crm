/**
 * 促销（**规则层**）—— 类型与纯函数
 *
 * 对外承诺：`clever-vpn-docs` `app-crm.md` §2.9
 * 内部依据：`docs/promotion.md`（为什么只做这两层、为什么砍掉兑换码/券包）
 *
 * 这一层只回答四件事，全部是**纯函数**（便于单测，也让后台预览与 App 看到同一结果）：
 *   1. 这个活动现在**能不能用**（时间窗 / 套餐范围 / 门槛 / 次数 / 首单）
 *   2. 用了能**少收多少钱**（`amount` 或 `percent`）
 *   3. 一句**给用户看的话**（`discount_label` / `promo_badge`）
 *   4. 多个活动同时可用时**挑哪一个**（取更优，不叠加 —— 不变量 3）
 *
 * 刻意不做的事：
 *   - 不写"送几天 / 送几 GB"的折扣：折扣改 `paid_minor`，赠送不改（不变量 1）
 *   - 不改变升级阶梯：升级只看 `price_minor`，促销只压 `payable_minor`（不变量 2）
 */
import type { PlanKind } from "../plans/model";

/** 收益形态：只允许"少收钱"，不给权益 */
export type BenefitType = "amount" | "percent";
/** coupon = 结账时用；referral = 注册时建立关系 */
export type PromotionKind = "coupon" | "referral";
export type PromotionStatus = "draft" | "active" | "ended";
/** 推荐人奖励：给权益，不给现金（合规，也避免"佣金提现"那套） */
export type RewardType = "days" | "gb" | "none";

export interface Promotion {
  id: number;
  /** NULL = 自动活动（用户不需要输入任何码） */
  code: string | null;
  name: string;
  kind: PromotionKind;
  benefit_type: BenefitType;
  /** amount = 分；percent = 1–100 的百分比 */
  benefit_value: number;
  min_subtotal_minor: number;
  /** 空数组 = 不限 */
  limit_plan_kinds: PlanKind[];
  /** 空数组 = 不限 */
  limit_plan_ids: string[];
  first_purchase_only: boolean;
  new_user_within_days: number | null;
  starts_at: string | null;
  ends_at: string | null;
  /** NULL = 不限总量 */
  max_uses: number | null;
  max_uses_per_customer: number;
  badge_label: string | null;
  /** 是否允许在列表页公开（定向活动建议关掉） */
  visible: boolean;
  referrer_reward_type: RewardType | null;
  referrer_reward_value: number | null;
  status: PromotionStatus;
}

export interface PromotionRow {
  id: number;
  code: string | null;
  name: string;
  kind: string;
  benefit_type: string;
  benefit_value: number;
  min_subtotal_minor: number;
  limit_plan_kinds: string;
  limit_plan_ids: string;
  first_purchase_only: number;
  new_user_within_days: number | null;
  starts_at: string | null;
  ends_at: string | null;
  max_uses: number | null;
  max_uses_per_customer: number;
  badge_label: string | null;
  visible: number;
  referrer_reward_type: string | null;
  referrer_reward_value: number | null;
  status: string;
}

export const PROMOTION_COLUMNS = `id, code, name, kind, benefit_type, benefit_value,
  min_subtotal_minor, limit_plan_kinds, limit_plan_ids, first_purchase_only,
  new_user_within_days, starts_at, ends_at, max_uses, max_uses_per_customer,
  badge_label, visible, referrer_reward_type, referrer_reward_value, status`;

function parseJsonArray(raw: string): string[] {
  try {
    const parsed = JSON.parse(raw) as unknown;
    return Array.isArray(parsed) ? parsed.filter((v): v is string => typeof v === "string") : [];
  } catch {
    return [];
  }
}

export function rowToPromotion(row: PromotionRow): Promotion {
  return {
    id: row.id,
    code: row.code,
    name: row.name,
    kind: row.kind === "referral" ? "referral" : "coupon",
    benefit_type: row.benefit_type === "percent" ? "percent" : "amount",
    benefit_value: row.benefit_value,
    min_subtotal_minor: row.min_subtotal_minor,
    limit_plan_kinds: parseJsonArray(row.limit_plan_kinds) as PlanKind[],
    limit_plan_ids: parseJsonArray(row.limit_plan_ids),
    first_purchase_only: row.first_purchase_only === 1,
    new_user_within_days: row.new_user_within_days,
    starts_at: row.starts_at,
    ends_at: row.ends_at,
    max_uses: row.max_uses,
    max_uses_per_customer: row.max_uses_per_customer,
    badge_label: row.badge_label,
    visible: row.visible === 1,
    referrer_reward_type: (row.referrer_reward_type as RewardType | null) ?? null,
    referrer_reward_value: row.referrer_reward_value,
    status: row.status === "active" ? "active" : row.status === "ended" ? "ended" : "draft",
  };
}

/** 金额展示：分 → `¥12.00`（只在文案里用，不参与计算） */
export function yuan(minor: number): string {
  return `¥${(minor / 100).toFixed(2)}`;
}

/**
 * 一次报价的上下文。
 *
 * `first_purchase` / `customer_age_days` 为 `null` 表示**没有客户**（匿名浏览）：
 * 任何依赖个人条件的活动都不适用 —— 匿名页不能因为"看起来像新人"就打折。
 */
export interface PromoContext {
  plan_id: string;
  plan_kind: PlanKind;
  /** 折扣前的金额：**恒为套餐标价**（残值不参与打折，否则等于重复抵扣） */
  subtotal_minor: number;
  now: Date;
  first_purchase: boolean | null;
  customer_age_days: number | null;
  /** 该活动全站已核销次数 */
  uses_total: number;
  /** 该活动在这个用户名下已核销次数 */
  uses_by_customer: number;
}

export type PromotionCheck = { ok: true } | { ok: false; reason: string };

/**
 * 能不能用。**所有拒绝理由都是给终端用户看的整句中文**（契约 §2.9.3：
 * 不适用时返回 `allowed:false` + `reason`，绝不抛 5xx）。
 */
export function checkPromotion(p: Promotion, ctx: PromoContext): PromotionCheck {
  if (p.status !== "active") return { ok: false, reason: "这个优惠活动已结束" };

  const now = ctx.now.getTime();
  if (p.starts_at && Date.parse(p.starts_at) > now) return { ok: false, reason: "这个优惠活动还没开始" };
  if (p.ends_at && Date.parse(p.ends_at) <= now) return { ok: false, reason: "这个优惠码已过期" };

  if (p.limit_plan_kinds.length && !p.limit_plan_kinds.includes(ctx.plan_kind)) {
    return { ok: false, reason: "这个优惠码不适用于该套餐" };
  }
  if (p.limit_plan_ids.length && !p.limit_plan_ids.includes(ctx.plan_id)) {
    return { ok: false, reason: "这个优惠码不适用于该套餐" };
  }
  if (ctx.subtotal_minor < p.min_subtotal_minor) {
    return { ok: false, reason: `满 ${yuan(p.min_subtotal_minor)} 才能使用这个优惠码` };
  }

  if (p.max_uses !== null && ctx.uses_total >= p.max_uses) {
    return { ok: false, reason: "这个优惠码已被领完" };
  }
  if (p.max_uses_per_customer <= 0) return { ok: false, reason: "这个优惠码已停用" };
  if (ctx.uses_by_customer >= p.max_uses_per_customer) {
    return { ok: false, reason: "你已经用过这个优惠码了" };
  }

  if (p.first_purchase_only) {
    if (ctx.first_purchase === null) return { ok: false, reason: "登录后才能使用这个优惠码" };
    if (!ctx.first_purchase) return { ok: false, reason: "这个优惠码仅限首次购买使用" };
  }
  if (p.new_user_within_days !== null) {
    if (ctx.customer_age_days === null) return { ok: false, reason: "登录后才能使用这个优惠码" };
    if (ctx.customer_age_days > p.new_user_within_days) {
      return { ok: false, reason: "这个优惠码仅限新用户使用" };
    }
  }

  return { ok: true };
}

/**
 * 能用的话少收多少（**永不小于 0，也永不超过标价**）。
 *
 * 注意：这里只对**标价**打折。换购时残值在报价里另外扣 ——
 * `payable = max(0, promo(price) − residual)`（promotion.md §4）。
 */
export function discountOf(p: Promotion, subtotalMinor: number): number {
  const subtotal = Math.max(0, subtotalMinor);
  if (p.benefit_type === "percent") {
    const pct = Math.min(100, Math.max(0, p.benefit_value));
    return Math.min(subtotal, Math.floor((subtotal * pct) / 100));
  }
  return Math.min(subtotal, Math.max(0, p.benefit_value));
}

export interface AppliedPromotion {
  promotion: Promotion;
  discount_minor: number;
  /** 整句，直接展示（如 `新人券 −¥3.00`） */
  label: string;
}

export function appliedOf(p: Promotion, subtotalMinor: number): AppliedPromotion {
  const discount = discountOf(p, subtotalMinor);
  return { promotion: p, discount_minor: discount, label: `${p.name} −${yuan(discount)}` };
}

/**
 * 多个可用活动里挑**更优的一个**（不变量 3：一次下单最多用一个码）。
 *
 * 同额时按 `id` 升序 —— 结果必须**确定**，否则同一单刷新两次金额会变。
 */
export function bestPromotion(
  list: readonly Promotion[],
  ctx: PromoContext,
): AppliedPromotion | null {
  let best: AppliedPromotion | null = null;
  for (const p of [...list].sort((a, b) => a.id - b.id)) {
    if (!checkPromotion(p, ctx).ok) continue;
    const applied = appliedOf(p, ctx.subtotal_minor);
    if (applied.discount_minor <= 0) continue;
    if (!best || applied.discount_minor > best.discount_minor) best = applied;
  }
  return best;
}

/** 列表页角标：只展示"公开 + 有文案"的活动，算出来的折扣仅供划线价使用 */
export function badgeOf(list: readonly Promotion[], ctx: PromoContext): AppliedPromotion | null {
  const visible = list.filter((p) => p.visible && p.badge_label);
  return bestPromotion(visible, ctx);
}
