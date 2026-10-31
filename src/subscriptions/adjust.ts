/**
 * **管理员直接调整权益**（特殊补偿通道）
 *
 * 与营销礼包的边界划得很清：
 *
 * | | 礼包（`promotions/gift.ts`） | 直接调整（这里） |
 * |---|---|---|
 * | 是什么 | **营销活动**：有人群、名额、冷却、统计 | **特例处理**：一次一个人 |
 * | 记录 | `redemptions` 一行（+ 活动快照）+ 台账 | `adjustments` 一行 + 台账 |
 * | 必填 | 活动名、奖励项 | **补偿原因**（审计要求） |
 * | 适合 | "首单后送 7 天"、"到期前挽回" | "11-03 线路故障，补 3 天" |
 *
 * 补偿场景不该去建一个活动：那会污染营销统计（发放数、核销率），而且"给张三补 3 天"
 * 这件事也不该出现在促销列表里。所以走这条通道。
 *
 * 加天数 / 加流量的算法与礼包**完全共用**（`entitlement.ts`），不会出现两套口径。
 */
import { freshenTraffic, customerSubscription, logChange, upsertSubscription } from "./store";
import { applicableAdditive, applyAdditive, pushAdditive } from "./entitlement";
import { GIGA } from "../platform/client";

import type { Env } from "../env";
import type { Subscription } from "../plans/subscription";

export interface AdjustInput {
  customerId: number;
  /** 加天数；0 / 不传 = 不改到期日 */
  days?: number;
  /** 加流量 GB；0 / 不传 = 不改流量 */
  gb?: number;
  /** **必填**：为什么调（审计与客服复盘都靠它） */
  reason: string;
  /** 操作人（后台登录邮箱） */
  operator: string;
  now?: Date;
}

/** 一次调整在 `adjustments` 里留下的差分（一天数、一条流量） */
export interface AdjustRecord {
  field: "days" | "gb";
  delta: string;
  before_value: string;
  after_value: string;
}

export interface AdjustResult {
  ok: boolean;
  error?: "invalid" | "no_subscription" | "not_applicable" | "platform_unreadable";
  message?: string;
  before?: Subscription;
  after?: Subscription;
  /** 实际生效的增量（不适用的维度会归 0） */
  applied: { days: number; gb: number };
  records: AdjustRecord[];
  /** 平台是否已写入（没落账的订阅会等 provisioning 全量落账） */
  platform_synced: boolean;
}

const fail = (
  error: NonNullable<AdjustResult["error"]>,
  message: string,
): AdjustResult => ({ ok: false, error, message, applied: { days: 0, gb: 0 }, records: [], platform_synced: false });

/**
 * 给一个客户**直接加**天数 / 流量。
 *
 * 顺序是**先推平台、再写库**（与礼包相反）：礼包由付款触发，本地先记、落账失败有
 * `retryProvisioning` 兜底；而这里没有任何重试机制，宁可整体失败让管理员重试，
 * 也不能出现"本地加了、平台没加、用户用不了"的半截状态。
 */
export async function adjustSubscription(env: Env, input: AdjustInput): Promise<AdjustResult> {
  const days = Number.isFinite(input.days) ? Math.max(0, Number(input.days)) : 0;
  const gb = Number.isFinite(input.gb) ? Math.max(0, Number(input.gb)) : 0;
  const reason = input.reason?.trim() ?? "";
  if (!reason) return fail("invalid", "必须写补偿原因（会记进调整台账）");
  if (days <= 0 && gb <= 0) return fail("invalid", "天数和流量至少要填一项（且必须 > 0）");

  const before = await customerSubscription(env, input.customerId);
  if (!before) return fail("no_subscription", "这个客户还没有订阅，先开通再调整");

  // 无限期不收天数、不限量不收 GB —— 与礼包同一套判断
  const applied = applicableAdditive(before, { days, gb });
  if (applied.days <= 0 && applied.gb <= 0) {
    return fail(
      "not_applicable",
      before.kind === "period"
        ? "这个订阅是无限期的或不限量的，填的维度都加不上"
        : "这个流量包是无限期的或不限量的，填的维度都加不上",
    );
  }

  // 加流量必须落在**平台真实剩余**上（本地只是 15 分钟缓存）
  let platformRemainingGb: number | undefined;
  if (applied.gb > 0 && before.platform_customer_id) {
    const fresh = await freshenTraffic(env, before);
    if (!fresh || fresh.traffic_remaining_gb === null) {
      return fail("platform_unreadable", "读不到平台的剩余流量，稍后再试（这次没有改动任何数据）");
    }
    platformRemainingGb = fresh.traffic_remaining_gb;
  }

  const now = input.now ?? new Date();
  const next = applyAdditive(before, applied, { platformRemainingGb, now });

  // ── ① 先推平台 ──
  try {
    await pushAdditive(env, next, applied, platformRemainingGb, next.expires_at);
  } catch (e) {
    return fail(
      "platform_unreadable",
      `平台写入失败：${e instanceof Error ? e.message : String(e)}（这次没有改动任何数据）`,
    );
  }

  // ── ② 再写本地 ──
  const id = await upsertSubscription(env, next);
  const after = { ...next, id };

  await logChange(env, {
    customer_id: input.customerId,
    subscription_id: id,
    action: "adjust",
    before,
    after,
    detail: {
      source: "admin",
      reason,
      operator: input.operator,
      adjusted: applied,
    },
  });

  // ── ③ 调整台账（一次一项，便于客服复盘"到底改了什么"）──
  const at = now.toISOString();
  const records: AdjustRecord[] = [];
  if (applied.days > 0) {
    records.push({
      field: "days",
      delta: `+${applied.days}`,
      before_value: before.expires_at ?? "",
      after_value: after.expires_at ?? "",
    });
  }
  if (applied.gb > 0) {
    const beforeGb = before.kind === "traffic" ? before.traffic_total_gb : before.period_extra_gb;
    const afterGb = after.kind === "traffic" ? after.traffic_total_gb : after.period_extra_gb;
    records.push({
      field: "gb",
      delta: `+${applied.gb}`,
      before_value: String(beforeGb ?? 0),
      after_value: String(afterGb ?? 0),
    });
  }

  for (const r of records) {
    await env.DB.prepare(
      `INSERT INTO adjustments (customer_id, subscription_id, at, field, delta, before_value,
         after_value, reason, operator, platform_applied_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
      .bind(
        input.customerId,
        id,
        at,
        r.field,
        r.delta,
        r.before_value,
        r.after_value,
        reason,
        input.operator,
        // 上面已经推过平台了；这里记时间即可（失败的情况根本走不到这一步）
        after.platform_customer_id ? at : null,
      )
      .run();
  }

  return {
    ok: true,
    before,
    after,
    applied,
    records,
    platform_synced: Boolean(after.platform_customer_id),
  };
}

/** 平台剩余换算成 GB 用的单位（给调用方/测试复用，避免各自写 1024³） */
export const BYTES_PER_GB = GIGA;
