/**
 * 订单的**用户视角视图**（纯函数）
 *
 * 为什么要有这一层：`/orders` 原来只回裸字段（`plan_id` / `amount_minor` / `status`），
 * App 得自己拼"月付 · 15 元 · 已支付" —— 那就等于把业务口径塞进了客户端。
 * 这里一次性把**能渲染的句子**算好，App 只画。
 *
 * 一个关键约定（配合"用户查询不打网关"）：`pending` 时要告诉前端**多久之后再问**，
 * 因为真正确认收款的是 cron（最长一个 tick ≈ 2 分钟），不是这次请求。
 */
import type { Plan } from "../plans/model";

/** pending 时建议的轮询间隔 */
const POLL_SOON_MS = 3_000;
const POLL_SLOW_MS = 10_000;

export interface OrderListView {
  order_code: string;
  /** 买了什么（套餐名 / 礼包名） */
  title: string;
  /** 应付（`¥15.00`；0 元单说明来源） */
  amount_text: string;
  status: string;
  /** 用户可读的状态句 */
  status_text: string;
  /** 前端小标签 */
  tag: string;
  tag_tone: "info" | "success" | "muted" | "warn";
  /** 建议多久后再轮询（`null` = 不用再问） */
  next_poll_after_ms: number | null;
  created_at: string;
  paid_at: string | null;
}

function yuan(minor: number): string {
  return `¥${(minor / 100).toFixed(2)}`;
}

function planTitle(snapshot: string): string {
  try {
    const plan = JSON.parse(snapshot) as Partial<Plan> & { gift?: string };
    if (plan.gift) return `礼包「${plan.gift}」`;
    if (plan.name) return plan.name;
  } catch {
    /* 坏快照：回落到通用文案，不能让列表整页挂掉 */
  }
  return "订阅套餐";
}

export function orderStatusView(
  status: string,
  opts: { ageMinutes: number },
): { status_text: string; tag: string; tag_tone: OrderListView["tag_tone"]; next_poll_after_ms: number | null } {
  switch (status) {
    case "pending":
      // 两分钟以内还说"通常几秒"；超过就别骗人 —— 真正确认靠 cron
      return opts.ageMinutes < 2
        ? {
            status_text: "正在确认收款，通常几秒内完成",
            tag: "确认收款",
            tag_tone: "info",
            next_poll_after_ms: POLL_SOON_MS,
          }
        : {
            status_text: "收款确认中。可以关掉页面 —— 开通后会通知你",
            tag: "确认收款",
            tag_tone: "info",
            next_poll_after_ms: POLL_SLOW_MS,
          };
    case "paid":
    case "provisioning":
      return {
        status_text: "已支付，正在开通",
        tag: "开通中",
        tag_tone: "info",
        next_poll_after_ms: POLL_SOON_MS,
      };
    case "active":
      return {
        status_text: "已生效",
        tag: "已完成",
        tag_tone: "success",
        next_poll_after_ms: null,
      };
    case "expired":
      return {
        status_text: "订单已过期（未收到款项）",
        tag: "已过期",
        tag_tone: "muted",
        next_poll_after_ms: null,
      };
    case "closed":
      return {
        status_text: "订单已关闭",
        tag: "已关闭",
        tag_tone: "muted",
        next_poll_after_ms: null,
      };
    case "refunded":
      return {
        status_text: "已退款",
        tag: "已退款",
        tag_tone: "warn",
        next_poll_after_ms: null,
      };
    default:
      return {
        status_text: status,
        tag: status,
        tag_tone: "muted",
        next_poll_after_ms: null,
      };
  }
}

export function orderListView(
  row: {
    code: string;
    plan_snapshot: string;
    amount_minor: number;
    status: string;
    created_at: string;
    paid_at: string | null;
  },
  now: Date = new Date(),
): OrderListView {
  const ageMinutes = Math.max(0, (now.getTime() - Date.parse(row.created_at)) / 60_000);
  const state = orderStatusView(row.status, { ageMinutes });
  return {
    order_code: row.code,
    title: planTitle(row.plan_snapshot),
    amount_text: row.amount_minor > 0 ? yuan(row.amount_minor) : "0 元（赠送）",
    status: row.status,
    status_text: state.status_text,
    tag: state.tag,
    tag_tone: state.tag_tone,
    next_poll_after_ms: state.next_poll_after_ms,
    created_at: row.created_at,
    paid_at: row.paid_at,
  };
}
