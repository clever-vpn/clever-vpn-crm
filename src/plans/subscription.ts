/**
 * 订阅与结算 —— 把套餐卖出去之后，权益怎么随时间走
 *
 * 两条互不干扰的轨道：
 *   - `period`：按时间到期 + **每月重置额度**。重置由 CRM 自己算（平台的 `quota` 恒为 NULL），
 *     因为平台的月度边界是"记账自然月"，10 号买的用户拿不到完整 30 天。
 *   - `traffic`：没有重置，只有"用掉多少"。
 *
 * 加购包不单独占主订阅位：它记在主订阅那一行的 `balance_gb`（包里还剩多少）。
 * 平台侧只有一个余额 `traffic_balance`，所以绑定时的**不变量**是
 *
 *     R = P + B          （R = 平台余额，P = 本月额度，B = 加购包余额）
 *
 * 结算到点时：
 *
 *     B' = min(B, R)     （用超了 P 的部分才从包里扣）
 *     R' = P + B'
 *
 * 这个写法等价于"按已用量扣包"，但**不需要记录已用量**——R 本身就把用量编码进去了。
 */

import { addDaysIso } from "./model";

import type { Plan } from "./model";

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;

export type SubscriptionKind = "period" | "traffic" | "addon";

/** 手工控制位：**只表达人的意图**，它本身不是状态（`domain.md` §1.3） */
export type Hold = "none" | "frozen" | "revoked";

/**
 * 能不能用（`app-crm.md` §2.3）：**状态只有两个**，原因单独给。
 *
 * 把“到期 / 用完 / 冻结”塞进 status，会让每加一个停用原因就多一个值，
 * App 的放行判断就得跟着改。这里只留“可用 / 不可用”，原因放 `reason`，
 * 文案放 `status_text`（App 不拼文案）。
 */
export type SubscriptionStatus = "active" | "inactive";

/** 不可用的原因：对外只这三种（撤销 / 退款 / 换档中间态都归入 `frozen`） */
export type InactiveReason = "expired" | "exhausted" | "frozen";

export interface SubscriptionState {
  status: SubscriptionStatus;
  /** 只有 `inactive` 时有值 */
  reason: InactiveReason | null;
  /** 用户可见文案的**唯一来源**；`active` 时为“生效中” */
  status_text: string;
}

/**
 * 一行 `platform_subscriptions`（含创建时的规则快照）。
 *
 * 字段名统一带**类型前缀**：`period_*` 只属于 `kind='period'`，`traffic_*` 只属于
 * `kind='traffic'`，无前缀的两种都有意义。看名字就知道该不该在这里赋值。
 */
export interface Subscription {
  id: number;
  customer_id: number;
  /**
   * **最初**让这份权益生效的订单。只在 `action='new'` 时写入，
   * 续费 / 加量 / 升级**不覆盖**（那些在 `orders` + `subscription_changes` 里查）。
   */
  order_id: number | null;
  plan_id: string;
  kind: SubscriptionKind;
  hold: Hold;
  hold_reason: string | null;
  hold_at: string | null;
  /** 这份权益的成交价（续费覆盖；加量包/赠送**不覆盖**） */
  paid_minor: number;
  currency: string;
  licence_limit: number;
  // ── period 专有 ──
  period_term_days: number | null;
  /** null = 不限量 */
  period_quota_gb: number | null;
  /** 1..28：结算锚点日（29/30/31 归到 28，避免二月丢失） */
  period_anchor_day: number | null;
  /** 额外流量池（加量包+赠送+邀请）：不随月度重置清零 */
  period_extra_gb: number | null;
  period_settled_at: string | null;
  // ── traffic 专有 ──
  traffic_total_gb: number | null;
  /** 平台侧剩余（缓存，TTL 15min；null = 从未同步） */
  traffic_remaining_gb: number | null;
  traffic_synced_at: string | null;
  traffic_validity_days: number | null;
  // ── 共用 ──
  /** null = 永不过期 */
  expires_at: string | null;
  started_at: string;
  line_ids: number[];
  platform_customer_id: number | null;
  /**
   * 平台激活码（cf-api `customers.code`）。
   * `null` = 还没落账成功（付款后停在 `provisioning`），或换档后旧码已失效。
   */
  activation_code: string | null;
  /**
   * 快照：这份权益是不是**免费试用**（来自 `plans.trial`）。
   * 只用于给用户看的文案（`statusOf`）；买了正式套餐后自动变 false。
   */
  trial: boolean;
}

// ---- 从套餐创建订阅 ----

/** 结算锚点：日 > 28 一律记 28，否则 2 月会"跳过一个月" */
export function anchorDayOf(when: Date): number {
  return Math.min(when.getUTCDate(), 28);
}

/**
 * 把一张套餐快照成一行订阅（**成交那一刻的规则**，之后改价不影响它）。
 * 自动续费也走这里：新的一行，`paid_minor` = 这次实付。
 */
export function subscriptionFromPlan(
  plan: Plan,
  opts: { customerId: number; paidMinor?: number; now?: Date },
): Omit<Subscription, "id"> {
  const now = opts.now ?? new Date();
  const paid = opts.paidMinor ?? plan.price_minor;
  const expiresAt =
    plan.kind === "period"
      ? new Date(now.getTime() + (plan.term_days ?? 0) * DAY_MS).toISOString()
      : plan.validity_days === null
        ? null
        : new Date(now.getTime() + plan.validity_days * DAY_MS).toISOString();

  return {
    customer_id: opts.customerId,
    // 新快照默认没有开单：真正落库时由 upsertSubscription({ orderId }) 填入
    order_id: null,
    plan_id: plan.id,
    kind: plan.kind,
    hold: "none",
    hold_reason: null,
    hold_at: null,
    paid_minor: paid,
    currency: plan.currency,
    licence_limit: plan.licence_limit,
    period_term_days: plan.kind === "period" ? plan.term_days : null,
    period_quota_gb: plan.kind === "period" ? plan.monthly_quota_gb : null,
    traffic_total_gb: plan.kind === "period" ? null : plan.traffic_gb,
    traffic_validity_days: plan.kind === "traffic" ? plan.validity_days : null,
    line_ids: plan.line_ids,
    started_at: now.toISOString(),
    expires_at: plan.kind === "addon" ? null : expiresAt,
    period_anchor_day: plan.kind === "period" ? anchorDayOf(now) : null,
    period_extra_gb: 0,
    // 新开的 traffic 还没被平台确认：先按“满额”乐观填，`synced_at = null` 表示未经核对
    traffic_remaining_gb: plan.kind === "traffic" ? plan.traffic_gb : null,
    traffic_synced_at: null,
    period_settled_at: plan.kind === "period" ? now.toISOString() : null,
    platform_customer_id: null,
    // 落账成功后才由 provisionOrder 写入；命中该字段前订阅停在 provisioning
    activation_code: null,
    trial: plan.trial,
  };
}

// ---- 状态（算出来的） ----

/**
 * 算出状态，**不存储**。优先级与文案见 `docs/domain.md` §1.3：
 * 冻结/作废 → 到期 → 用完 → 可用。
 *
 * 注意：这里只用于**展示与报价**。“能不能连”的权威判定在 cf-api（心跳读自己的余额）。
 *
 * `trial` 只影响**文案**（试用到期时说"试用已结束 · 升级后可继续使用"，
 * 而不是含糊的"已到期"）。App 不做这个判断 —— 它只显示 `status_text`。
 */
export function statusOf(
  sub: Pick<
    Subscription,
    | "hold"
    | "hold_reason"
    | "expires_at"
    | "traffic_remaining_gb"
    | "kind"
    | "period_anchor_day"
    | "trial"
  >,
  now: Date = new Date(),
): SubscriptionState {
  if (sub.hold === "revoked" || sub.hold === "frozen") {
    return {
      status: "inactive",
      reason: "frozen",
      status_text: sub.hold_reason ?? "订阅已被暂停，请联系客服",
    };
  }
  if (sub.expires_at && Date.parse(sub.expires_at) <= now.getTime()) {
    const day = sub.expires_at.slice(0, 10);
    return {
      status: "inactive",
      reason: "expired",
      status_text: sub.trial ? `试用已于 ${day} 结束 · 升级后可继续使用` : `已于 ${day} 到期`,
    };
  }
  // `traffic_remaining_gb === null` 是“未同步”，不是 0 —— 不能当成已用完
  if (sub.traffic_remaining_gb !== null && sub.traffic_remaining_gb <= 0) {
    if (sub.trial) {
      return {
        status: "inactive",
        reason: "exhausted",
        status_text: "试用流量已用完 · 升级后可继续使用",
      };
    }
    const reset =
      sub.kind === "period" && sub.period_anchor_day ? `，每月 ${sub.period_anchor_day} 日重置` : "";
    return { status: "inactive", reason: "exhausted", status_text: `本月流量已用完${reset}` };
  }
  return {
    status: "active",
    reason: null,
    status_text: sub.trial ? trialRemainingText(sub.expires_at, now) : "生效中",
  };
}

/** 试用剩余时长的整句（CRM 组织，App 直接显示） */
function trialRemainingText(expiresAt: string | null, now: Date): string {
  if (!expiresAt) return "免费试用中";
  const ms = Date.parse(expiresAt) - now.getTime();
  if (!Number.isFinite(ms) || ms <= 0) return "免费试用已结束";
  const days = Math.ceil(ms / 86_400_000);
  if (days >= 1) return `免费试用 · 还剩 ${days} 天`;
  return `免费试用 · 还剩 ${Math.max(1, Math.ceil(ms / 3_600_000))} 小时`;
}

// ---- 两种后续动作（纯函数：算新快照，不碰库） ----

/**
 * 续订：**同一套餐再来一份**。
 *
 * - `period`：到期日 = `max(现在, 原到期日) + period_term_days`（提前续订不丢时间，也不走残值）
 * - `traffic`：整包叠加（`traffic_total_gb` 与 `traffic_remaining_gb` 同步加），到期日取两者更晚
 * - `addon`：只加 `period_extra_gb`，不动到期日，**不动 `paid_minor`**
 *
 * 权益列（额度 / 设备数 / 线路 / 锚点）**沿用当前订阅的快照**，不因套餐改版而变化。
 */
export function renewSubscription(
  sub: Subscription,
  plan: Plan,
  opts: { paidMinor: number; now?: Date },
): Subscription {
  const now = opts.now ?? new Date();
  const base = Math.max(now.getTime(), sub.expires_at ? Date.parse(sub.expires_at) : 0);
  const next = { ...sub };

  if (plan.kind === "addon") {
    // 加量包是一笔**额外**消费，不是主订阅的成交价：
    // 若覆盖 paid_minor，残值会按“主订阅价 + 加量包价”计算 ⇒ 升级时多找钱。
    const gb = plan.traffic_gb ?? 0;
    next.period_extra_gb = (sub.period_extra_gb ?? 0) + gb;
    // 池子变多，本周期可用额度也跟着变（缓存值；调用方负责先回源）
    next.traffic_remaining_gb = sub.traffic_remaining_gb === null ? null : sub.traffic_remaining_gb + gb;
    return next;
  }

  next.paid_minor = opts.paidMinor;
  if (sub.kind === "period") {
    next.expires_at = new Date(base + (sub.period_term_days ?? 0) * DAY_MS).toISOString();
    return next;
  }
  // traffic：整包叠加，到期日取更晚者
  next.traffic_total_gb = (sub.traffic_total_gb ?? 0) + (plan.traffic_gb ?? 0);
  next.traffic_remaining_gb = (sub.traffic_remaining_gb ?? 0) + (plan.traffic_gb ?? 0);
  const added = plan.validity_days === null ? null : new Date(base + plan.validity_days * DAY_MS).toISOString();
  const candidates = [sub.expires_at, added].filter((v): v is string => v !== null);
  next.expires_at = candidates.length ? candidates.sort().at(-1)! : null;
  return next;
}

/**
 * 升级：换成**另一份**套餐（可跨 `kind`）。
 *
 * - 新快照从**今天**起算（旧的剩余时间 / 流量已经折成钱，不叠加）
 * - 额外流量池 `period_extra_gb` **原样带过去**（它是 GB，不折钱）；目标不是 period 时清为 null
 * - `paid_minor` = 本次实付；后续残值用它 × 剩余比例（已封顶到 1，不会亏本）
 */
export function upgradeSubscription(
  sub: Subscription,
  plan: Plan,
  opts: { paidMinor: number; now?: Date },
): Subscription {
  const fresh = subscriptionFromPlan(plan, {
    customerId: sub.customer_id,
    paidMinor: opts.paidMinor,
    now: opts.now,
  });
  // 池子是 GB 不折钱：目标还是 period 就留在池子里；
  // 目标变成 traffic（池子列无意义）就并进流量包，不能把用户买过的流量丢掉
  const extra = sub.period_extra_gb ?? 0;
  if (plan.kind === "traffic" && extra > 0 && fresh.traffic_total_gb !== null) {
    fresh.traffic_total_gb += extra;
    fresh.traffic_remaining_gb = (fresh.traffic_remaining_gb ?? 0) + extra;
  }
  return {
    ...fresh,
    id: sub.id,
    hold: sub.hold,
    hold_reason: sub.hold_reason,
    hold_at: sub.hold_at,
    period_extra_gb: plan.kind === "period" ? extra : null,
  } as Subscription;
}

// ---- 结算（period 每月重置） ----

/** 下一次重置时间：锚点日的 UTC 00:00，若已过则顺延到下一个锚点 */
export function nextResetAt(anchorDay: number, after: Date): Date {
  const candidate = new Date(Date.UTC(after.getUTCFullYear(), after.getUTCMonth(), anchorDay));
  if (candidate.getTime() > after.getTime()) return candidate;
  return new Date(Date.UTC(after.getUTCFullYear(), after.getUTCMonth() + 1, anchorDay));
}

export interface SettleInput {
  /** 本月额度 P；null = 不限量（无需结算） */
  period_quota_gb: number | null;
  /** 额外流量池 B（加量包+赠送+邀请，未用完可留到下月） */
  period_extra_gb: number | null;
  /** 平台侧当前余额 R（**必须刚 freshen 过**，不能拿缓存里的旧值算账） */
  platform_balance_gb: number | null;
  period_anchor_day: number | null;
  period_settled_at: string | null;
  expires_at: string | null;
}

export interface SettleResult {
  due: boolean;
  /** 新的 `period_settled_at`（未到期时原样返回） */
  period_settled_at: string | null;
  /** 新的额外流量池 B' */
  period_extra_gb: number | null;
  /** 要写回平台的新余额 R'（null = 无需写入） */
  platform_balance_gb: number | null;
  /** 跳过了几个结算周期（>1 说明定时任务漏跑过） */
  skipped_periods: number;
}

/**
 * 是否该重置，以及重置成什么。
 *
 * 漏跑处理：如果定时任务停了几个月，**不会重放多次**——直接从"当前余额"算一次，
 * 然后把锚点推到最近一个周期。理由：中间那几期的真实用量已经从 R 里滚过去了，
 * 重放只会凭空造出额度。
 */
export function settle(input: SettleInput, now: Date = new Date()): SettleResult {
  const unchanged: SettleResult = {
    due: false,
    period_settled_at: input.period_settled_at,
    period_extra_gb: input.period_extra_gb,
    platform_balance_gb: null,
    skipped_periods: 0,
  };

  // 不限量 / 已到期 / 没有锚点：都不结算
  if (input.period_quota_gb === null) return unchanged;
  if (!input.period_anchor_day || !input.period_settled_at) return unchanged;
  if (input.expires_at && Date.parse(input.expires_at) <= now.getTime()) return unchanged;

  const since = new Date(input.period_settled_at);
  const next = nextResetAt(input.period_anchor_day, since);
  if (next.getTime() > now.getTime()) return unchanged;

  const extra = input.period_extra_gb ?? 0;
  const platform = input.platform_balance_gb ?? input.period_quota_gb;
  // R 可能为负（用超额）：扣池时视为 0，剩下的欠账由平台继续挡
  const usable = Math.max(0, platform);
  const extraAfter = Math.min(extra, usable);

  return {
    due: true,
    period_settled_at: now.toISOString(),
    period_extra_gb: extraAfter,
    platform_balance_gb: input.period_quota_gb + extraAfter,
    skipped_periods: periodsBetween(next, now, input.period_anchor_day),
  };
}

function periodsBetween(from: Date, to: Date, anchorDay: number): number {
  let count = 0;
  let cursor = from;
  // 上限 24 期，防御异常数据（比如锚点在未来）
  while (count < 24) {
    const following = nextResetAt(anchorDay, cursor);
    if (following.getTime() > to.getTime()) break;
    count += 1;
    cursor = following;
  }
  return count;
}

/** 加购：往额外流量池上累加（不动月度额度、不动到期日） */
export function addAddonBalance(subscription: Subscription, addonGb: number): number {
  return (subscription.period_extra_gb ?? 0) + addonGb;
}

/** 绑定到平台时应该写的余额（period：P + B；traffic：总量） */
export function bindingBalance(subscription: Subscription): number | null {
  if (subscription.kind === "period") {
    if (subscription.period_quota_gb === null) return null; // 不限量
    return subscription.period_quota_gb + (subscription.period_extra_gb ?? 0);
  }
  return subscription.traffic_total_gb;
}

/** 到期日（`YYYY-MM-DD`）——给 cf-api 的 `expire_date`；null = 永久 */
export function bindingExpireDate(subscription: Subscription): string | null {
  if (subscription.expires_at === null) return null;
  return addDaysIso(new Date(subscription.expires_at), 0);
}

/** 主订阅是否已结束（到期 / 流量用尽）。addon 不参与判断。 */
export function isOver(subscription: Subscription, now: Date = new Date()): boolean {
  if (subscription.kind === "period") {
    if (subscription.expires_at === null) return false;
    return Date.parse(subscription.expires_at) <= now.getTime();
  }
  if (subscription.kind === "traffic") {
    return (subscription.traffic_remaining_gb ?? 0) <= 0;
  }
  return false;
}
