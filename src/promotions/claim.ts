/**
 * 待领取礼包（`promotions.delivery = 'claim'`）—— **纯函数层**
 *
 * 一句话分工：**「已经发给你了」和「你已经拿到了」是两件事**。
 * 这张券记前者，`redemptions` 记后者。所以名额、财务报表仍然只看 `redemptions` ——
 * 券发了但没人领，不该占掉名额，更不该出现在"已发放权益"的账上。
 *
 * 为什么要有这种形态（这是它存在的唯一理由）：
 * 直接改账（`delivery = 'auto'`）用户**感知不到**。到期日悄悄从 3 个月变 3 个月零 10 天，
 * 用户只会在他某天发现"居然还能用"时才隐约感觉到 —— 这不是营销，是没人知道的善意。
 * 「必须自己点一下领取」才让福利变成用户看得见、记得住的东西。
 *
 * 这里只做**展示材料**（纯函数，便于单测，也让 App 与官网看到同一句话）：
 * App 拿到 `status_text` / `rewards_text` / `action` 直接渲染，不判断任何业务规则。
 */
import type { GiftRewards, Promotion } from "./model";

/** 待领取的状态：过期不是状态，是 `expires_at <= now` 的推断（省掉一个定时任务） */
export type GiftClaimStatus = "pending" | "claimed" | "expired";

/** 券在库里的真实取值（`claiming` 是领取途中的短暂占位，防双击） */
export type GiftClaimRowStatus = "pending" | "claiming" | "claimed";

/** 领取后没走完的占位超过这个时长，就当那次失败，券回到可领 */
export const CLAIM_LOCK_MS = 5 * 60 * 1000;

/** 默认有效期（天）：活动没填时用；够用户"下次打开 App"看到的窗口 */
export const DEFAULT_CLAIM_DAYS = 7;

/** 有效期（天）：只对 `delivery='claim'` 有意义，1–90 */
export function claimValidDays(promo: Pick<Promotion, "claim_valid_days">): number {
  const n = promo.claim_valid_days;
  return typeof n === "number" && n >= 1 && n <= 90 ? n : DEFAULT_CLAIM_DAYS;
}

/** 领券截止时间 = 送达时刻 + 有效期 */
export function claimDeadline(
  promo: Pick<Promotion, "claim_valid_days">,
  now: Date,
): Date {
  return new Date(now.getTime() + claimValidDays(promo) * 86_400_000);
}

/** `+7 天 +5 GB`；两项都 0 时给空串（正常不该出现，礼包必须有内容） */
export function rewardsText(r: GiftRewards): string {
  const parts: string[] = [];
  if (r.days > 0) parts.push(`+${r.days} 天`);
  if (r.gb > 0) parts.push(`+${r.gb} GB`);
  return parts.join(" · ");
}

/**
 * 卡片的标题。
 *
 * 刻意**不用** `promotions.name` —— 那是后台备注（"双十一 A 渠道"），不该给用户看。
 * 有角标就用角标，否则一句中性的「免费礼包」。
 */
export function claimTitle(promo: Pick<Promotion, "badge_label">): string {
  const badge = promo.badge_label?.trim();
  return badge ? badge : "免费礼包";
}

export function claimStatusOf(
  claim: { status: string; expires_at: string; claimed_at?: string | null },
  now: Date,
): GiftClaimStatus {
  if (claim.status === "claimed") return "claimed";
  const exp = Date.parse(claim.expires_at);
  if (Number.isFinite(exp) && exp <= now.getTime()) return "expired";
  return "pending";
}

/** 用户侧的一句话状态；App 直接显示，不拼文案（I-APP：客户端不持有业务口径） */
export function claimStatusText(
  claim: { status: string; expires_at: string },
  now: Date,
): string {
  const status = claimStatusOf(claim, now);
  if (status === "claimed") return "已领取 · 权益已到账";
  if (status === "expired") return "已过期 · 这张券作废了";
  const left = Math.max(1, Math.ceil((Date.parse(claim.expires_at) - now.getTime()) / 86_400_000));
  return `待领取 · ${left} 天后作废`;
}

/**
 * 一件待领取礼包会变成 App 上的什么。
 *
 * `action` 是**唯一的按钮开关**：`claim` = 可以点「领取」，`null` = 只展示。
 * 客户端不做任何判断 —— 它只知道"有按钮就画按钮"。
 */
export interface GiftClaimView {
  id: number;
  promotion_id: number;
  title: string;
  rewards_text: string;
  /** 送达理由：注册礼 / 到期回馈 / 客服赠送 */
  source_text: string;
  status: GiftClaimStatus;
  status_text: string;
  expires_at: string;
  action: "claim" | null;
}

const SOURCE_TEXT: Record<string, string> = {
  signup: "新客礼",
  expiring: "到期回馈",
  manual: "专属赠送",
};

export function claimView(
  claim: {
    id: number;
    promotion_id: number;
    status: string;
    source: string;
    expires_at: string;
  },
  promo: Pick<Promotion, "badge_label" | "rewards">,
  now: Date,
): GiftClaimView {
  const status = claimStatusOf(claim, now);
  return {
    id: claim.id,
    promotion_id: claim.promotion_id,
    title: claimTitle(promo),
    rewards_text: rewardsText(promo.rewards),
    source_text: SOURCE_TEXT[claim.source] ?? "赠送",
    status,
    status_text: claimStatusText(claim, now),
    expires_at: claim.expires_at,
    action: status === "pending" ? "claim" : null,
  };
}
