/**
 * 订阅与月度结算
 *
 * 结算公式（`src/plans/subscription.ts`）：
 *   R = P + B           平台余额 = 本月额度 + 加购包余额
 *   B' = min(B, R)      只有用超 P 的部分才从包里扣
 *   R' = P + B'
 *
 * 这些断言就是"用户问『我这个月到底还剩多少』"的唯一答案来源。
 */

import { describe, it, expect } from "vitest";

import {
  anchorDayOf,
  addAddonBalance,
  bindingBalance,
  bindingExpireDate,
  isOver,
  nextResetAt,
  renewSubscription,
  statusOf,
  upgradeSubscription,
  settle,
  subscriptionFromPlan,
} from "../src/plans/subscription";

import type { Plan } from "../src/plans/model";
import type { Subscription } from "../src/plans/subscription";

const NOW = new Date("2026-10-23T09:00:00Z");

function makePlan(over: Partial<Plan> = {}): Plan {
  return {
    id: "p_30d_100g_1d",
    name: "月付 · 100GB · 1 设备",
    kind: "period",
    price_minor: 1500,
    currency: "CNY",
    licence_limit: 1,
    term_days: 30,
    monthly_quota_gb: 100,
    traffic_gb: null,
    validity_days: null,
    line_ids: [],
    up_mbps: null,
    down_mbps: null,
    sales_channels: [{ channel: "web_checkout", methods: ["alipay"] }],
    store_product_id: {},
    sort_order: 0,
    status: "active",
    visibility: "public",
    trial: false,
    retired_at: null,
    ...over,
  };
}

function makeSub(over: Partial<Subscription> = {}): Subscription {
  return {
    id: 1,
    customer_id: 7,
    order_id: 11,
    plan_id: "p_30d_100g_1d",
    kind: "period",
    hold: "none",
    hold_reason: null,
    hold_at: null,
    paid_minor: 1500,
    currency: "CNY",
    licence_limit: 1,
    period_term_days: 30,
    period_quota_gb: 100,
    traffic_total_gb: null,
    traffic_validity_days: null,
    traffic_remaining_gb: null,
    traffic_synced_at: null,
    line_ids: [],
    started_at: "2026-10-01T00:00:00Z",
    expires_at: "2026-10-31T00:00:00Z",
    period_anchor_day: 1,
    period_extra_gb: 0,
    period_settled_at: "2026-10-01T00:00:00Z",
    platform_customer_id: 42,
    activation_code: "7391048261558203",
    trial: false,
    ...over,
  };
}

describe("anchorDayOf", () => {
  it("29/30/31 一律折算到 28（否则 2 月会跳过一期）", () => {
    expect(anchorDayOf(new Date("2026-01-31T00:00:00Z"))).toBe(28);
    expect(anchorDayOf(new Date("2026-01-15T00:00:00Z"))).toBe(15);
  });
});

describe("nextResetAt", () => {
  it("同月锚点在未来 → 用本月", () => {
    expect(nextResetAt(1, new Date("2026-10-01T00:00:00Z")).toISOString())
      .toBe("2026-11-01T00:00:00.000Z"); // 锚点当天且已过 ⇒ 下个月
  });

  it("锚点已过 → 顺延下个月", () => {
    expect(nextResetAt(5, new Date("2026-10-23T00:00:00Z")).toISOString())
      .toBe("2026-11-05T00:00:00.000Z");
  });

  it("跨年正确", () => {
    expect(nextResetAt(28, new Date("2026-12-29T00:00:00Z")).toISOString())
      .toBe("2027-01-28T00:00:00.000Z");
  });
});

describe("subscriptionFromPlan", () => {
  it("period：到期日 = 今天 + term_days，quota 记在 CRM，锚点 = 购买日", () => {
    const sub = subscriptionFromPlan(makePlan(), { customerId: 7, now: NOW });
    expect(sub.expires_at).toBe("2026-11-22T09:00:00.000Z");
    expect(sub.period_quota_gb).toBe(100);
    expect(sub.period_anchor_day).toBe(23);
    expect(sub.period_extra_gb).toBe(0);
    expect(sub.period_settled_at).toBe(NOW.toISOString());
    // 新快照还没有订单：order_id 由付款落库时写入
    expect(sub.order_id).toBeNull();
    // 还没与平台核对过
    expect(sub.traffic_synced_at).toBeNull();
  });

  it("traffic：永久包 expires_at = null，remaining = 总量", () => {
    const sub = subscriptionFromPlan(
      makePlan({ kind: "traffic", term_days: null, monthly_quota_gb: null, traffic_gb: 200, validity_days: null }),
      { customerId: 7, now: NOW },
    );
    expect(sub.expires_at).toBeNull();
    expect(sub.traffic_total_gb).toBe(200);
    expect(sub.traffic_remaining_gb).toBe(200);
    expect(sub.period_anchor_day).toBeNull();
  });

  it("实付价可以低于目录价（促销），订阅只认实付价", () => {
    const sub = subscriptionFromPlan(makePlan(), { customerId: 7, paidMinor: 990, now: NOW });
    expect(sub.paid_minor).toBe(990);
  });
});

describe("bindingBalance / bindingExpireDate", () => {
  it("period：绑定余额 = P + B", () => {
    expect(bindingBalance(makeSub({ period_extra_gb: 20 }))).toBe(120);
  });

  it("period 不限量 → null（平台不计费）", () => {
    expect(bindingBalance(makeSub({ period_quota_gb: null }))).toBeNull();
  });

  it("traffic：绑定余额 = 总量", () => {
    expect(bindingBalance(makeSub({ kind: "traffic", period_quota_gb: null, traffic_total_gb: 200 }))).toBe(200);
  });

  it("到期日转成 YYYY-MM-DD；永久为 null", () => {
    expect(bindingExpireDate(makeSub())).toBe("2026-10-31");
    expect(bindingExpireDate(makeSub({ expires_at: null }))).toBeNull();
  });
});

describe("settle", () => {
  // 锚点 1 号、上次结算 10-01 ⇒ 下一次重置是 11-01，所以在 11-05 跑才会 due
  const SETTLE_NOW = new Date("2026-11-05T00:00:00Z");
  const base = {
    period_quota_gb: 100,
    period_extra_gb: 0,
    platform_balance_gb: 100,
    period_anchor_day: 1,
    period_settled_at: "2026-10-01T00:00:00Z",
    expires_at: "2026-12-31T00:00:00Z",
  };

  it("没到锚点 → 不动", () => {
    const r = settle(base, new Date("2026-10-20T00:00:00Z"));
    expect(r.due).toBe(false);
    expect(r.platform_balance_gb).toBeNull();
  });

  it("用了 30G（无加购）→ 重置回 100", () => {
    const r = settle({ ...base, platform_balance_gb: 70 }, SETTLE_NOW);
    expect(r.due).toBe(true);
    expect(r.period_extra_gb).toBe(0);
    expect(r.platform_balance_gb).toBe(100);
  });

  it("用了 130G、池子里有 50G → 扣掉超出的 30G，池子剩 20G", () => {
    // R = 100 + 50 - 130 = 20
    const r = settle({ ...base, period_extra_gb: 50, platform_balance_gb: 20 }, SETTLE_NOW);
    expect(r.period_extra_gb).toBe(20);
    expect(r.platform_balance_gb).toBe(120);
  });

  it("用量没超额度 → 池子不动（本月额度不结转，但池子不清零）", () => {
    // R = 100 + 50 - 40 = 110 ⇒ 池子完整保留
    const r = settle({ ...base, period_extra_gb: 50, platform_balance_gb: 110 }, SETTLE_NOW);
    expect(r.period_extra_gb).toBe(50);
    expect(r.platform_balance_gb).toBe(150);
  });

  it("用量把池子也用光了 → 池子归零，余额为负时按 0 算不返额", () => {
    // R = 150 - 200 = -50 ⇒ 用超 150，池子只剩 0
    const r = settle({ ...base, period_extra_gb: 50, platform_balance_gb: -50 }, SETTLE_NOW);
    expect(r.period_extra_gb).toBe(0);
    expect(r.platform_balance_gb).toBe(100);
  });

  it("不限量（quota = null）不结算", () => {
    expect(settle({ ...base, period_quota_gb: null }, SETTLE_NOW).due).toBe(false);
  });

  it("已到期不结算", () => {
    expect(settle({ ...base, expires_at: "2026-10-10T00:00:00Z" }, SETTLE_NOW).due).toBe(false);
  });

  it("定时任务漏跑 3 个月 → 只结算一次，但记下 skipped_periods", () => {
    const r = settle({ ...base, period_settled_at: "2026-07-01T00:00:00Z" }, SETTLE_NOW);
    expect(r.due).toBe(true);
    expect(r.skipped_periods).toBeGreaterThanOrEqual(3);
    expect(r.platform_balance_gb).toBe(100);
  });

  it("同一时刻重复跑 → 第二次不再生效（幂等）", () => {
    const first = settle(base, SETTLE_NOW);
    const second = settle({ ...base, period_settled_at: first.period_settled_at }, SETTLE_NOW);
    expect(second.due).toBe(false);
  });
});

describe("addAddonBalance / isOver", () => {
  it("加购只累加额外池", () => {
    expect(addAddonBalance(makeSub({ period_extra_gb: 12.5 }), 50)).toBe(62.5);
  });

  it("period 到期算结束，永久不算", () => {
    expect(isOver(makeSub({ expires_at: "2026-10-01T00:00:00Z" }), NOW)).toBe(true);
    expect(isOver(makeSub({ expires_at: null }), NOW)).toBe(false);
  });

  it("traffic 余量 0 算结束", () => {
    expect(isOver(makeSub({ kind: "traffic", traffic_remaining_gb: 0 }), NOW)).toBe(true);
  });
});

describe("statusOf：状态算出来，原因单独给", () => {
  it("冻结/作废 → 到期 → 用完 → 可用，按优先级命中", () => {
    // 状态只有 active / inactive；原因才是 expired / exhausted / frozen
    const base = makeSub({ expires_at: "2026-10-01T00:00:00Z", traffic_remaining_gb: 0 });
    expect(statusOf({ ...base, hold: "revoked" }, NOW)).toEqual({
      status: "inactive",
      reason: "frozen",
      status_text: "订阅已被暂停，请联系客服",
    });
    expect(statusOf({ ...base, hold: "frozen", hold_reason: "风控" }, NOW)).toEqual({
      status: "inactive",
      reason: "frozen",
      status_text: "风控",
    });
    expect(statusOf(base, NOW)).toEqual({
      status: "inactive",
      reason: "expired",
      status_text: "已于 2026-10-01 到期",
    });
  });

  it("没到期但流量用完 → inactive/exhausted，文案带重置日", () => {
    const sub = makeSub({ expires_at: "2026-12-01T00:00:00Z", traffic_remaining_gb: 0, period_anchor_day: 23 });
    const state = statusOf(sub, NOW);
    expect(state.status).toBe("inactive");
    expect(state.reason).toBe("exhausted");
    expect(state.status_text).toContain("23");
  });

  it("试用：文案由 CRM 组织（剩余天数 / 已结束 / 已用完）", () => {
    const active = makeSub({ trial: true, expires_at: "2026-10-30T00:00:00Z" });
    expect(statusOf(active, NOW).status_text).toBe("免费试用 · 还剩 7 天");
    expect(statusOf(active, NOW).status).toBe("active");

    const expired = makeSub({ trial: true, expires_at: "2026-10-01T00:00:00Z" });
    expect(statusOf(expired, NOW).status_text).toBe("试用已于 2026-10-01 结束 · 升级后可继续使用");
    expect(statusOf(expired, NOW).reason).toBe("expired");

    const used = makeSub({ trial: true, traffic_remaining_gb: 0 });
    expect(statusOf(used, NOW).status_text).toBe("试用流量已用完 · 升级后可继续使用");
    expect(statusOf(used, NOW).reason).toBe("exhausted");
  });

  it("非试用订阅的文案不变", () => {
    expect(statusOf(makeSub(), NOW).status_text).toBe("生效中");
  });

  it("不限量（remaining = null）永远不会 exhausted", () => {
    const sub = makeSub({ expires_at: "2026-12-01T00:00:00Z", traffic_remaining_gb: null });
    expect(statusOf(sub, NOW)).toEqual({ status: "active", reason: null, status_text: "生效中" });
  });
});

describe("续订：同一套餐再买一份", () => {
  it("周期套餐从原到期日顺延，不是从今天起算", () => {
    const sub = makeSub({ expires_at: "2026-10-31T00:00:00Z", period_term_days: 30 });
    const next = renewSubscription(sub, makePlan({ kind: "period", term_days: 30 }), {
      paidMinor: 1500,
      now: NOW,
    });
    // 10-31 + 30 天；如果错误地从"现在"起算会得到 11-15 左右
    expect(next.expires_at).toBe("2026-11-30T00:00:00.000Z");
    expect(next.paid_minor).toBe(1500);
  });

  it("已过期再续订：从今天起算", () => {
    const sub = makeSub({ expires_at: "2026-09-01T00:00:00Z", period_term_days: 30 });
    const next = renewSubscription(sub, makePlan({ kind: "period", term_days: 30 }), {
      paidMinor: 1500,
      now: NOW,
    });
    expect(Date.parse(next.expires_at ?? "")).toBe(NOW.getTime() + 30 * 24 * 3600 * 1000);
  });

  it("加购包只加池子，不动到期日，也**不改成交价**", () => {
    const sub = makeSub({ period_extra_gb: 10, expires_at: "2026-10-31T00:00:00Z" });
    const next = renewSubscription(sub, makePlan({ kind: "addon", traffic_gb: 50 }), {
      paidMinor: 800,
      now: NOW,
    });
    expect(next.period_extra_gb).toBe(60);
    expect(next.expires_at).toBe(sub.expires_at);
    // 残值基准仍是主订阅的成交价：那笔 800 分记在 orders / subscription_changes
    expect(next.paid_minor).toBe(sub.paid_minor);
  });
});

describe("升级：换成另一份套餐", () => {
  it("跨 kind 也允许，从今天起算，额外池按 GB 原样搬过去", () => {
    const sub = makeSub({ period_extra_gb: 25, expires_at: "2026-12-31T00:00:00Z" });
    const next = upgradeSubscription(sub, makePlan({ kind: "traffic", traffic_gb: 500, validity_days: 365 }), {
      paidMinor: 4200,
      now: NOW,
    });
    expect(next.kind).toBe("traffic");
    // 目标不是 period，池子无处安放 ⇒ 并进流量包（GB 不折钱），不能丢
    expect(next.traffic_total_gb).toBe(525);
    expect(next.traffic_remaining_gb).toBe(525);
    expect(next.period_extra_gb).toBeNull();
    expect(next.paid_minor).toBe(4200);
    expect(next.id).toBe(sub.id); // 同一行
  });

  it("period → period：池子原样带过去", () => {
    const sub = makeSub({ period_extra_gb: 25 });
    const next = upgradeSubscription(sub, makePlan({ kind: "period", price_minor: 3000 }), {
      paidMinor: 2800,
      now: NOW,
    });
    expect(next.period_extra_gb).toBe(25);
    expect(next.period_quota_gb).toBe(100);
  });

  it("冻结状态不会被付款解开", () => {
    const sub = makeSub({ hold: "frozen", hold_reason: "风控" });
    const next = upgradeSubscription(sub, makePlan({ kind: "period" }), { paidMinor: 1500, now: NOW });
    expect(next.hold).toBe("frozen");
  });
});
