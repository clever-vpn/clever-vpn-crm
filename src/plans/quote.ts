/**
 * 报价 —— **用户能看到的所有结论都从这里出**（`docs/plans.md` §2 / §3）
 *
 * 四个可购买动作，App 不判断，只按 `action` 渲染按钮：
 *
 *   buy     按标价全额买下这个 SKU：新开主订阅 / 过期重开 / **买加量包**
 *   renewal 同一个套餐再来一份 → **目录价全款**，到期日顺延（不走残值）
 *   upgrade 换成**标价更高**的套餐（含跨 kind）→ 新价 − 残值，**必须 > 0**
 *
 * 加量包可买时就是 `buy`：它的交易行为恒为“按标价加流量”，不需要单独一格
 * `action`（`kind === "addon"` 已经说明了它是什么）。
 *
 * 三条硬规则：
 *   1. 升级 = 目标**标价** > 当前套餐**标价**，且应付 > 0。
 *      只看残值会出现“便宜的套餐也叫升级”，只看标价会出现“升级还倒找钱”。
 *   2. `price_minor` 只用于比贵，`paid_minor` 只用于算残值；促销时两者分叉是正常的。
 *   3. 残值按**实付价**算（促销价不按目录价折），period 按小时、traffic 按 GB。
 *
 * “降级”不是动作，是 upgrade 被拒的一个分支。
 * 为什么把时间放在这里而不是 cf-api：平台只认“到期日 + 余额”，
 * 怎么从“还剩多少价值”推导出新订单，是纯粹的商业逻辑，属于 CRM。
 */

import type { Plan } from "./model";

const HOUR_MS = 60 * 60 * 1000;

/** 当前生效的主订阅（CRM 侧的订阅快照） */
export interface CurrentSubscription {
  plan_id: string;
  kind: "period" | "traffic";
  /**
   * 当前套餐的**目录标价**（不是实付！）。只用于“谁的标价更高”，
   * 与算残值的 `paid_minor` 严格分开。套餐下架（retired）后仍要从 `plans` 表读得到。
   */
  list_price_minor: number;
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
}

export type Settlement = "new" | "renewal" | "residual_trade_in" | "store_proration";

/** 给 App 直接照着渲染的动作；`blocked` = 不能买，`reason` 说明为什么 */
export type QuoteAction = "buy" | "renewal" | "upgrade" | "blocked";

export interface Quote {
  allowed: boolean;
  /** `allowed === false` 时必填：直接给终端用户看的整句中文 */
  reason: string | null;
  action: QuoteAction;
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
    action: "blocked",
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
    if (target.kind === "addon") return reject("需要先有一个生效中的周期套餐");
    return {
      allowed: true,
      reason: null,
      action: "buy",
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

  // ── 加量包：交易行为恒为“按标价加流量”，所以是 buy（不是新订阅）──
  if (target.kind === "addon") {
    if (current.kind !== "period") return reject("加量包只能叠加在周期套餐上");
    if (current.unlimited) return reject("不限量套餐不需要加购");
    return {
      allowed: true,
      reason: null,
      action: "buy",
      settlement: "new",
      residual_minor: 0,
      payable_minor: target.price_minor,
      // 加购不动到期日
      expires_at: current.expires_at === null ? null : new Date(current.expires_at).toISOString(),
    };
  }

  // ── 续订：同一个套餐再来一份（**全款**，不走残值，到期日顺延）──
  if (target.id === current.plan_id && target.kind === current.kind) {
    const base = Math.max(now.getTime(), current.expires_at ? Date.parse(current.expires_at) : 0);
    const expires =
      target.kind === "period"
        ? new Date(base + (target.term_days ?? 0) * DAY_MS).toISOString()
        : target.validity_days === null
          ? current.expires_at === null
            ? null
            : new Date(base).toISOString()
          : new Date(base + target.validity_days * DAY_MS).toISOString();
    return {
      allowed: true,
      reason: null,
      action: "renewal",
      settlement: "renewal",
      residual_minor: 0,
      payable_minor: target.price_minor,
      expires_at: expires,
      remaining_hours: current.kind === "period" && current.expires_at
        ? Math.max(0, Math.round((Date.parse(current.expires_at) - now.getTime()) / HOUR_MS))
        : undefined,
    };
  }

  // ── 换购：只认**标价**更高（可以跨 kind）。标价不涨就不是升级，直接拒。──
  if (target.price_minor <= current.list_price_minor) {
    return reject("不支持降档：请选择标价更高的套餐，或等当前订阅结束");
  }

  // 标价更高也可能“倒找钱”（旧套餐实付高、剩余比例大），所以应付仍需 > 0
  const residual = residualMinor(current, now);
  const payable = target.price_minor - residual;
  if (payable <= 0) {
    return reject(
      `当前订阅残值 ${(residual / 100).toFixed(2)} 已抵满新套餐，请等到期后再换购`,
    );
  }

  return {
    allowed: true,
    reason: null,
    action: "upgrade",
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
