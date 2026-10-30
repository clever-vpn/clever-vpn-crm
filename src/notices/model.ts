/**
 * 通知的**文案层**（纯函数）
 *
 * 一条通知 = 一句话标题 + 一段正文 + 可选动作。文案在**创建时**就定稿（落库），
 * 这样"当时的承诺"不会因为后来改模板而变形，也让 App 与邮件看到同一份东西。
 *
 * 两种礼包通知是**两种文体**，不是同一段话改几个字：
 *
 *   gift_claim（有券待领）  = **行动号召**：送什么 · 还剩几天作废 · 去领取
 *   gift_auto（已到账）     = **收据**   ：已为你加了什么 · 新的到期日是哪天
 *
 * 为什么 auto 也一定要发：悄悄延长 10 天，用户只有到期满那天才发现 —— 那不是营销，
 * 是没人知道的善意。收据把"我给了你什么"变成用户记得住的事实。
 */
import type { GiftRewards } from "../promotions/model";

/** 目前只有两种礼包通知；以后加（订单成功 / 补偿通知）往这里加 */
export type NoticeKind = "gift_claim" | "gift_auto";

/** 营销类通知：可退订（验证码 / 订单结果不在此列，那是交易必需） */
export const MARKETING_KINDS: readonly NoticeKind[] = ["gift_claim", "gift_auto"];

export function isMarketingNotice(kind: string): boolean {
  return (MARKETING_KINDS as readonly string[]).includes(kind);
}

/** 一条待建的通知 */
export interface NoticeDraft {
  customerId: number;
  kind: NoticeKind;
  /** 幂等锚点：同一次发放只通知一次 */
  refId: string;
  title: string;
  body: string;
  actionUrl?: string | null;
  actionText?: string | null;
}

/** `+7 天 · +5 GB`（与礼包卡片用同一套措辞，用户不会看到两种说法） */
export function rewardsText(r: GiftRewards): string {
  const parts: string[] = [];
  if (r.days > 0) parts.push(`+${r.days} 天`);
  if (r.gb > 0) parts.push(`+${r.gb} GB`);
  return parts.join(" · ");
}

/** 日期只到天：`2026-11-16`（邮件里不写时分秒，用户不需要） */
function dayOf(iso: string): string {
  return iso.slice(0, 10);
}

export interface GiftNoticeInput {
  customerId: number;
  /**
   * 幂等锚点：`gift_auto` 用 0 元订单 id；`gift_claim` 用 `"{券id}:{截止时间}"`
   * —— 券过期后重新发一张是**一次新的提醒**，不该被旧的唯一键吞掉。
   */
  refId: string | number;
  /** 活动角标（用户可见的标题来源）；为空时用中性标题 */
  badgeLabel: string | null;
  rewards: GiftRewards;
  /** claim：领取截止时间；auto：新的订阅到期时间（可空 = 无限期） */
  expiresAt: string | null;
  /** claim 模式还剩几天 */
  daysLeft?: number;
  /** 官网账户页地址（没配 SITE_URL 时为空） */
  siteUrl: string;
}

function titleOf(badgeLabel: string | null): string {
  const badge = (badgeLabel ?? "").trim();
  return badge || "免费礼包";
}

/**
 * 待领取：**必须让他现在就知道**（券会过期）。
 */
export function claimNotice(input: GiftNoticeInput): NoticeDraft {
  const rewards = rewardsText(input.rewards);
  const left = input.daysLeft && input.daysLeft > 0 ? input.daysLeft : null;
  const deadline = input.expiresAt ? dayOf(input.expiresAt) : null;
  return {
    customerId: input.customerId,
    kind: "gift_claim",
    refId: String(input.refId),
    title: `你有一份礼物待领取：${titleOf(input.badgeLabel)}`,
    body: [
      `送给你的 ${rewards} 还在等你领取。`,
      deadline
        ? left
          ? `请在 ${deadline} 前领取，逾期自动作废（还剩约 ${left} 天）。`
          : `请在 ${deadline} 前领取，逾期自动作废。`
        : "逾期未领取会自动作废。",
      "领取后权益立即生效，可以在「我的礼包」里看到。",
    ].join("\n"),
    actionUrl: input.siteUrl ? `${input.siteUrl.replace(/\/$/, "")}/account/gifts` : null,
    actionText: "去领取",
  };
}

/**
 * 已到账：**收据**。必须写清"新到期日 / 加了多少"，否则用户读不出你给了什么。
 */
export function grantedNotice(input: GiftNoticeInput): NoticeDraft {
  const rewards = rewardsText(input.rewards);
  const until = input.expiresAt ? dayOf(input.expiresAt) : null;
  return {
    customerId: input.customerId,
    kind: "gift_auto",
    refId: String(input.refId),
    title: `已为你送上：${titleOf(input.badgeLabel)}`,
    body: [
      `我们为你的订阅增加了 ${rewards}，已经生效，不需要任何操作。`,
      until ? `新的有效期至 ${until}。` : "你的订阅没有到期日，这次增加不会改变这一点。",
      "如果这不是你预期的，请联系我们。",
    ].join("\n"),
    actionUrl: input.siteUrl ? `${input.siteUrl.replace(/\/$/, "")}/account` : null,
    actionText: "查看我的订阅",
  };
}

/**
 * 邮件正文：**纯文本 + HTML 双版本**。
 *
 * 纯文本不是可选项 —— 有些客户端只显示 text，而且带 text 的邮件更不容易被判垃圾。
 */
export function renderNoticeEmail(
  notice: {
    title: string;
    body: string;
    action_url: string | null;
    action_text: string | null;
  },
  opts: { unsubscribeUrl: string | null },
): { subject: string; text: string; html: string } {
  const lines = notice.body.split("\n").filter(Boolean);
  const text = [
    notice.title,
    "",
    ...lines,
    "",
    ...(notice.action_url && notice.action_text
      ? [`${notice.action_text}：${notice.action_url}`, ""]
      : []),
    ...(opts.unsubscribeUrl
      ? ["——", "不想再接这类通知？退订：", opts.unsubscribeUrl]
      : []),
  ].join("\n");

  const esc = (s: string) =>
    s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  const html = `
    <div style="font-family:-apple-system,Segoe UI,sans-serif;max-width:520px;margin:0 auto">
      <h2 style="color:#16191d;font-size:18px">${esc(notice.title)}</h2>
      ${lines.map((l) => `<p style="color:#3a424c;font-size:14px;line-height:1.7;margin:6px 0">${esc(l)}</p>`).join("")}
      ${
        notice.action_url && notice.action_text
          ? `<p style="margin:20px 0"><a href="${esc(notice.action_url)}" style="background:#2563eb;color:#fff;padding:10px 18px;border-radius:6px;text-decoration:none;font-size:14px">${esc(notice.action_text)}</a></p>`
          : ""
      }
      ${
        opts.unsubscribeUrl
          ? `<hr style="border:none;border-top:1px solid #eee;margin:24px 0" />
             <p style="color:#9aa3ad;font-size:12px">不想再接这类通知？<a href="${esc(opts.unsubscribeUrl)}" style="color:#9aa3ad">退订</a></p>`
          : ""
      }
    </div>`;
  return { subject: notice.title, text, html };
}
