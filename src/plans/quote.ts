/**
 * 换购报价 —— **唯一的升级规则**（`app-crm.md` §2.4.8）
 *
 *   残值 = 实付价 × 剩余比例
 *   应付 = 新套餐价 − 残值
 *
 * 三条硬规则，全部在这里表达，App 里不许出现：
 *   1. 同时只有一个主订阅；不跨 `kind` 换购（周期 ⇄ 流量要等当前结束）；
 *   2. 不支持降档：应付 < 0 一律拒绝（否则等于给用户返现）；
 *   3. 残值按**实付价**算（促销价买的不按目录价折），period 按小时、traffic 按 GB。
 *
 * 为什么把时间放在这里而不是 cf-api：平台只认"到期日 + 余额"这两个数，
 * 怎么从"还剩多少价值"推导出新订单，是纯粹的商业逻辑，属于 CRM。
 */

import type { Plan } from "./model";

const HOUR_MS = 60 * 60 * 1000;

/** 当前生效的主订阅（CRM 侧的订阅快照） */
export interface CurrentSubscription {
  plan_id: string;
  kind: "period" | "traffic";
  /** 该笔订单实际支付金额（最小货币单位） */
  paid_minor: number;
  /** period 才有 */
  term_days: number | null;
  /** traffic 才有 */
  traffic_gb: number | null;
  /** ISO 时间；null = 永不过期 */
  expires_at: string | null;
  /** traffic 才有：平台侧当前余额（GB） */
  remaining_gb: number | null;
  /** 不限量（平台 `traffic_balance = NULL`）：周期不限量 或 流量不限量 */
  unlimited: boolean;
  allow_addons: boolean;
}

export type Settlement = "new" | "residual_trade_in" | "store_proration";

export interface Quote {
  allowed: boolean;
  /** `allowed === false` 时必填：直接给终端用户看的整句中文 */
  reason: string | null;
  settlement: Settlement;
  residual_minor: number | null;
  payable_minor: number | null;
  /** 换购成功后的新到期日（`YYYY-MM-DD`）；traffic 永久为 null */
  expires_at: string | null;
  /** 供后台/日志核对，不下发给 App */
  remaining_hours?: number;
  remaining_gb?: number;
}

const DAY_MS = 24 * 60 * 60 * 1000;

function reject(reason: string): Quote {
  return {
    allowed: false,
    reason,
    settlement: "new",
    residual_minor: null,
    payable_minor: null,
    expires_at: null,
  };
}

/** 订阅是否已经结束（到期 或 流量用尽） */
export function isSubscriptionOver(current: CurrentSubscription, now: Date): boolean {
  if (current.unlimited) return current.expires_at === null ? false : Date.parse(current.expires_at) <= now.getTime();
  if (current.kind === "traffic") {
    return (current.remaining_gb ?? 0) <= 0;
  }
  if (current.expires_at === null) return false; // 永久
  return Date.parse(current.expires_at) <= now.getTime();
}

/**
 * 剩余比例对应的残值（向下取整到分）。
 * period 用**小时**精度，traffic 用 GB —— 越粗的精度越容易被套利，也越容易被用户质疑。
 */
export function residualMinor(current: CurrentSubscription, now: Date): number {
  if (!current.paid_minor) return 0;

  if (current.kind === "period") {
    if (current.expires_at === null || !current.term_days) return 0;
    const totalHours = current.term_days * 24;
    const remainingHours = Math.max(0, (Date.parse(current.expires_at) - now.getTime()) / HOUR_MS);
    if (remainingHours <= 0) return 0;
    const ratio = Math.min(1, remainingHours / totalHours);
    return Math.floor(current.paid_minor * ratio);
  }

  if (current.traffic_gb === null || current.traffic_gb <= 0) return 0;
  if (current.unlimited) return 0; // 不限量没有"剩余比例"可言
  const remaining = Math.max(0, current.remaining_gb ?? 0);
  const ratio = Math.min(1, remaining / current.traffic_gb);
  return Math.floor(current.paid_minor * ratio);
}

/**
 * 计算一次购买/换购的报价。
 *
 * @param current 当前生效的主订阅；`null` = 没有主订阅
 * @param target  要买的套餐
 */
export function quotePurchase(current: CurrentSubscription | null, target: Plan, now: Date = new Date()): Quote {
  // ── 没有任何有效主订阅：等价于新购 ──
  const over = current === null || isSubscriptionOver(current, now);
  if (over) {
    if (target.kind === "addon") return reject("加购包只能叠加在生效中的周期套餐上");
    return {
      allowed: true,
      reason: null,
      settlement: "new",
      residual_minor: 0,
      payable_minor: target.price_minor,
      expires_at: target.kind === "period"
        ? new Date(now.getTime() + (target.term_days ?? 0) * DAY_MS).toISOString()
        : target.validity_days === null
          ? null
          : new Date(now.getTime() + target.validity_days * DAY_MS).toISOString(),
    };
  }

  // ── 加购包 ──
  if (target.kind === "addon") {
    if (current.kind !== "period") return reject("加购包只能叠加在周期套餐上");
    if (current.unlimited) return reject("不限量套餐不需要加购");
    if (!current.allow_addons) return reject("当前套餐不支持加购");
    return {
      allowed: true,
      reason: null,
      settlement: "new",
      residual_minor: 0,
      payable_minor: target.price_minor,
      // 加购不动到期日
      expires_at: current.expires_at === null ? null : new Date(current.expires_at).toISOString(),
    };
  }

  // ── 主订阅换购 ──
  if (target.kind !== current.kind) {
    return reject(
      current.kind === "period"
        ? "周期套餐到期前不能换成流量套餐"
        : "流量套餐用尽前不能换成周期套餐",
    );
  }

  const residual = residualMinor(current, now);
  const payable = target.price_minor - residual;
  if (payable < 0) {
    return reject(`不支持降档：当前订阅残值 ${(residual / 100).toFixed(2)} 已超过新套餐价格`);
  }

  return {
    allowed: true,
    reason: null,
    settlement: "residual_trade_in",
    residual_minor: residual,
    payable_minor: payable,
    expires_at: target.kind === "period"
      ? new Date(now.getTime() + (target.term_days ?? 0) * DAY_MS).toISOString()
      : target.validity_days === null
        ? null
        : new Date(now.getTime() + target.validity_days * DAY_MS).toISOString(),
    remaining_hours: current.kind === "period" && current.expires_at
      ? Math.max(0, Math.round((Date.parse(current.expires_at) - now.getTime()) / HOUR_MS))
      : undefined,
    remaining_gb: current.kind === "traffic" ? current.remaining_gb ?? undefined : undefined,
  };
}
