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
/** coupon = 结账时用；gift = 送权益；referral = 注册时建立关系 */
export type PromotionKind = "coupon" | "gift" | "referral";
export type PromotionStatus = "draft" | "active" | "ended";
/** 推荐人奖励：给权益，不给现金（合规，也避免"佣金提现"那套） */
export type RewardType = "days" | "gb" | "none";

/**
 * 人群（契约 §2.9.6）。取代早期的 boolean `first_purchase_only` ——
 * 布尔表达不了「老客」「快到期」这两种真实场景。
 */
export type Audience = "all" | "new" | "existing" | "expiring" | "expired" | "specific";

export const AUDIENCES: readonly Audience[] = ["all", "new", "existing", "expiring", "expired", "specific"];

/**
 * 礼包的奖励项（`kind = gift`）。**只改权益，不改金额** —— 所以它与
 * `benefit_*` 是两套账，残值计算完全不受影响。
 *
 * 两个维度**完全独立**：`days` 只动到期日，`gb` 只动流量，谁也不推谁。
 * 也不提供“重置本月已用”：那会把用户已经用掉的流量变成新的额度，
 * 属于改账，不是送礼（真需要就给 GB，它落在额外流量池里）。
 *
 * 刻意没有 `device`：cf-api 的 `licence_limit` 建客户时固定、1–3、不可改，
 * 加设备等于删旧建新并换激活码（契约 §2.7）。也刻意没有 `balance`：我们没有钱包。
 */
export interface GiftRewards {
  /** 延长有效期（天）；订阅是「无限期」（`expires_at = null`）时忽略 */
  days: number;
  /** 增加流量（GB）；订阅是「不限量」时忽略 */
  gb: number;
}

export const EMPTY_REWARDS: GiftRewards = { days: 0, gb: 0 };

/** 礼包是否真的给了什么（全 0 = 空礼包，不允许上线） */
export function hasRewards(r: GiftRewards): boolean {
  return r.days > 0 || r.gb > 0;
}

export interface Promotion {
  id: number;
  /** 优惠券是否「不用码就生效」（礼包 / 邀请恒为 false） */
  auto_apply: boolean;
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
  /** 礼包奖励项（kind=gift 才有意义） */
  rewards: GiftRewards;
  /**
   * 礼包的送达方式：`auto` = 触发即到账；`claim` = 触发只生成「待领取」，用户自己领。
   * 用不到用户感知的（悄悄补一点期限）走 auto；要做营销的走 claim。
   */
  /** 是否给用户发通知邮件（默认 true；关掉 = 静默发放，用户不会有任何感知） */
  notify: boolean;
  /** 人群（取代旧的 first_purchase_only） */
  audience: Audience;
  /** audience=expiring 时必填 */
  audience_days: number | null;
  /** 同一客户两次核销的最小间隔（小时）；null = 不限 */
  cooldown_hours: number | null;
  /** 载体套餐（仅 kind=gift 且客户无订阅时生效）：用它 0 元开户 */
  plan_id: string | null;
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
  auto_apply: number;
  name: string;
  kind: string;
  benefit_type: string;
  benefit_value: number;
  min_subtotal_minor: number;
  limit_plan_kinds: string;
  limit_plan_ids: string;
  rewards_json: string;
  notify: number;
  audience: string;
  audience_days: number | null;
  cooldown_hours: number | null;
  plan_id: string | null;
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

export const PROMOTION_COLUMNS = `id, auto_apply, name, kind, benefit_type, benefit_value, rewards_json,
  notify,
  min_subtotal_minor, limit_plan_kinds, limit_plan_ids, audience, audience_days,
  cooldown_hours, plan_id, new_user_within_days, starts_at, ends_at, max_uses, max_uses_per_customer,
  badge_label, visible, referrer_reward_type, referrer_reward_value, status`;

function parseJsonArray(raw: string): string[] {
  try {
    const parsed = JSON.parse(raw) as unknown;
    return Array.isArray(parsed) ? parsed.filter((v): v is string => typeof v === "string") : [];
  } catch {
    return [];
  }
}

/** 礼包奖励项入库前一律归一：负数归 0、小数取 1 位（未知键直接丢弃） */
export function normalizeRewards(raw: unknown): GiftRewards {
  const o = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
  const num = (v: unknown): number => {
    const n = typeof v === "number" && Number.isFinite(v) ? v : 0;
    return n > 0 ? Math.round(n * 10) / 10 : 0;
  };
  return { days: num(o.days), gb: num(o.gb) };
}

function parseRewards(raw: string): GiftRewards {
  try {
    return normalizeRewards(JSON.parse(raw));
  } catch {
    return { ...EMPTY_REWARDS };
  }
}

export function rowToPromotion(row: PromotionRow): Promotion {
  return {
    id: row.id,
    auto_apply: row.auto_apply === 1,
    name: row.name,
    kind: row.kind === "referral" ? "referral" : row.kind === "gift" ? "gift" : "coupon",
    benefit_type: row.benefit_type === "percent" ? "percent" : "amount",
    benefit_value: row.benefit_value,
    min_subtotal_minor: row.min_subtotal_minor,
    limit_plan_kinds: parseJsonArray(row.limit_plan_kinds) as PlanKind[],
    limit_plan_ids: parseJsonArray(row.limit_plan_ids),
    rewards: parseRewards(row.rewards_json),
    notify: row.notify !== 0,
    audience: (AUDIENCES as readonly string[]).includes(row.audience)
      ? (row.audience as Audience)
      : "all",
    audience_days: row.audience_days,
    cooldown_hours: row.cooldown_hours,
    plan_id: row.plan_id,
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
  /** 当前是否有生效中的订阅（null = 匿名） */
  has_active_sub: boolean | null;
  /** 离到期还有几天（无订阅 / 永久 / 匿名 = null） */
  days_to_expiry: number | null;
  /** 该活动是否点名了这个客户（audience=specific 用） */
  targeted: boolean;
  /** 该活动全站已核销次数 */
  uses_total: number;
  /** 该活动在这个用户名下已核销次数 */
  uses_by_customer: number;
  /** 该活动在这个用户名下的**上次核销时间**（冷却用） */
  last_used_at: string | null;
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
  if (p.ends_at && Date.parse(p.ends_at) <= now) return { ok: false, reason: "这个码已经过期了" };

  if (p.limit_plan_kinds.length && !p.limit_plan_kinds.includes(ctx.plan_kind)) {
    return { ok: false, reason: "这个码不适用于该套餐" };
  }
  if (p.limit_plan_ids.length && !p.limit_plan_ids.includes(ctx.plan_id)) {
    return { ok: false, reason: "这个码不适用于该套餐" };
  }
  if (ctx.subtotal_minor < p.min_subtotal_minor && p.kind !== "gift") {
    return { ok: false, reason: `满 ${yuan(p.min_subtotal_minor)} 才能使用这个码` };
  }

  if (p.max_uses !== null && ctx.uses_total >= p.max_uses) {
    return { ok: false, reason: "这个码已经被领完了" };
  }
  if (p.max_uses_per_customer <= 0) return { ok: false, reason: "这个码已停用" };
  if (ctx.uses_by_customer >= p.max_uses_per_customer) {
    return { ok: false, reason: "你已经用过这个码了" };
  }

  if (p.cooldown_hours !== null && ctx.last_used_at) {
    const readyAt = Date.parse(ctx.last_used_at) + p.cooldown_hours * 3_600_000;
    if (now < readyAt) {
      return { ok: false, reason: `这个活动还在冷却中，${Math.ceil((readyAt - now) / 3_600_000)} 小时后再试` };
    }
  }

  const audience = checkAudience(p, ctx);
  if (!audience.ok) return audience;

  if (p.new_user_within_days !== null) {
    if (ctx.customer_age_days === null) return { ok: false, reason: "登录后才能使用这个码" };
    if (ctx.customer_age_days > p.new_user_within_days) {
      return { ok: false, reason: "这个码仅限新用户使用" };
    }
  }

  return { ok: true };
}

/**
 * 人群判定（契约 §2.9.6 的六种取值）。
 * 匿名（`first_purchase === null`）时，**任何个人条件都一律不适用** ——
 * 不能因为“看起来像新人”就给他打折。
 */
export function checkAudience(p: Promotion, ctx: PromoContext): PromotionCheck {
  if (p.audience === "all") return { ok: true };
  if (ctx.first_purchase === null) return { ok: false, reason: "登录后才能使用这个优惠" };

  switch (p.audience) {
    case "new":
      return ctx.first_purchase
        ? { ok: true }
        : { ok: false, reason: "这个优惠仅限首次购买使用" };
    case "existing":
      return ctx.has_active_sub
        ? { ok: true }
        : { ok: false, reason: "这个优惠仅限已有订阅的用户（续费用）" };
    case "expiring": {
      const days = p.audience_days ?? 7;
      if (ctx.days_to_expiry === null) return { ok: false, reason: "当前没有即将到期的订阅" };
      if (ctx.days_to_expiry < 0 || ctx.days_to_expiry > days) {
        return { ok: false, reason: `这个优惠仅限 ${days} 天内到期的用户` };
      }
      return { ok: true };
    }
    case "expired":
      return ctx.has_active_sub === false
        ? { ok: true }
        : { ok: false, reason: "这个优惠仅限订阅已结束的用户" };
    case "specific":
      return ctx.targeted ? { ok: true } : { ok: false, reason: "这个优惠仅限指定用户使用" };
  }
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

/**
 * 人群前缀 —— **系统生成，租户改不掉**。
 *
 * 定价页的角标 = `人群前缀 · 租户文案`。"限新用户"必须写在折数前面：游客看到
 * 「限新用户 · 首单 8 折」就不会以为人人 8 折，登录后发现原价也不算被骗；
 * 反过来只写「首单 8 折」而不写人群，就是角标在说谎。
 */
export function audiencePrefix(p: Promotion): string {
  switch (p.audience) {
    case "all":
      return "";
    case "new":
      return "限新用户";
    case "existing":
      return "限续费用户";
    case "expiring":
      return `限${p.audience_days ?? 7}天内到期`;
    case "expired":
      return "限订阅已结束";
    case "specific":
      // 定向名单永不公开，前缀也就没有意义
      return "";
  }
}

/** 角标的完整文案（前缀 + 租户文案）；`specific` 永不公开 → 空串 */
export function promoBadgeText(p: Promotion): string {
  if (p.audience === "specific") return "";
  const body = (p.badge_label ?? "").trim();
  const prefix = audiencePrefix(p);
  if (!prefix) return body;
  return body ? `${prefix} · ${body}` : prefix;
}

/**
 * 能不能出现在定价页（契约 §2.9.3，v19）。
 *
 * 三个条件缺一不可：
 *   1. **自动生效**的优惠券 —— 凭码券是站外渠道（博主 / 实体卡 / 群），摆到定价页
 *      等于把"渠道专属"变成"人人都有"，渠道方第一个不满意
 *   2. 租户勾了「站内展示」（`visible`）
 *   3. `audience !== specific` —— 定向名单写"仅限受邀用户"既不吸引人也看不懂
 */
export function canAppearInList(p: Promotion): boolean {
  return p.kind === "coupon" && p.auto_apply && p.visible && p.audience !== "specific";
}
