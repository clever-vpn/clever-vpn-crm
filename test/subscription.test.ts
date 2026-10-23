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
    allow_addons: true,
    line_ids: [],
    up_mbps: null,
    down_mbps: null,
    channels: [{ channel: "web_checkout", methods: ["alipay"] }],
    store_product_id: {},
    sort_order: 0,
    status: "active",
    supersedes_id: null,
    retired_at: null,
    ...over,
  };
}

function makeSub(over: Partial<Subscription> = {}): Subscription {
  return {
    id: 1,
    customer_id: 7,
    plan_id: "p_30d_100g_1d",
    kind: "period",
    status: "active",
    paid_minor: 1500,
    currency: "CNY",
    licence_limit: 1,
    term_days: 30,
    quota_gb: 100,
    traffic_total_gb: null,
    validity_days: null,
    allow_addons: true,
    line_ids: [],
    started_at: "2026-10-01T00:00:00Z",
    expires_at: "2026-10-31T00:00:00Z",
    anchor_day: 1,
    balance_gb: 0,
    remaining_gb: null,
    last_settled_at: "2026-10-01T00:00:00Z",
    platform_customer_id: 42,
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
    expect(sub.quota_gb).toBe(100);
    expect(sub.anchor_day).toBe(23);
    expect(sub.balance_gb).toBe(0);
    expect(sub.last_settled_at).toBe(NOW.toISOString());
  });

  it("traffic：永久包 expires_at = null，remaining = 总量", () => {
    const sub = subscriptionFromPlan(
      makePlan({ kind: "traffic", term_days: null, monthly_quota_gb: null, traffic_gb: 200, validity_days: null }),
      { customerId: 7, now: NOW },
    );
    expect(sub.expires_at).toBeNull();
    expect(sub.traffic_total_gb).toBe(200);
    expect(sub.remaining_gb).toBe(200);
    expect(sub.anchor_day).toBeNull();
  });

  it("实付价可以低于目录价（促销），订阅只认实付价", () => {
    const sub = subscriptionFromPlan(makePlan(), { customerId: 7, paidMinor: 990, now: NOW });
    expect(sub.paid_minor).toBe(990);
  });
});

describe("bindingBalance / bindingExpireDate", () => {
  it("period：绑定余额 = P + B", () => {
    expect(bindingBalance(makeSub({ balance_gb: 20 }))).toBe(120);
  });

  it("period 不限量 → null（平台不计费）", () => {
    expect(bindingBalance(makeSub({ quota_gb: null }))).toBeNull();
  });

  it("traffic：绑定余额 = 总量", () => {
    expect(bindingBalance(makeSub({ kind: "traffic", quota_gb: null, traffic_total_gb: 200 }))).toBe(200);
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
    quota_gb: 100,
    balance_gb: 0,
    platform_balance_gb: 100,
    anchor_day: 1,
    last_settled_at: "2026-10-01T00:00:00Z",
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
    expect(r.balance_gb).toBe(0);
    expect(r.platform_balance_gb).toBe(100);
  });

  it("用了 130G、包里有 50G → 扣掉超出的 30G，包剩 20G", () => {
    // R = 100 + 50 - 130 = 20
    const r = settle({ ...base, balance_gb: 50, platform_balance_gb: 20 }, SETTLE_NOW);
    expect(r.balance_gb).toBe(20);
    expect(r.platform_balance_gb).toBe(120);
  });

  it("用量没超额度 → 包不动", () => {
    // R = 100 + 50 - 40 = 110 ⇒ 包完整保留
    const r = settle({ ...base, balance_gb: 50, platform_balance_gb: 110 }, SETTLE_NOW);
    expect(r.balance_gb).toBe(50);
    expect(r.platform_balance_gb).toBe(150);
  });

  it("用量把包也用光了 → 包归零，余额为负时按 0 算不返额", () => {
    // R = 150 - 200 = -50 ⇒ 用超 150，包只剩 0
    const r = settle({ ...base, balance_gb: 50, platform_balance_gb: -50 }, SETTLE_NOW);
    expect(r.balance_gb).toBe(0);
    expect(r.platform_balance_gb).toBe(100);
  });

  it("不限量（quota = null）不结算", () => {
    expect(settle({ ...base, quota_gb: null }, SETTLE_NOW).due).toBe(false);
  });

  it("已到期不结算", () => {
    expect(settle({ ...base, expires_at: "2026-10-10T00:00:00Z" }, SETTLE_NOW).due).toBe(false);
  });

  it("定时任务漏跑 3 个月 → 只结算一次，但记下 skipped_periods", () => {
    const r = settle({ ...base, last_settled_at: "2026-07-01T00:00:00Z" }, SETTLE_NOW);
    expect(r.due).toBe(true);
    expect(r.skipped_periods).toBeGreaterThanOrEqual(3);
    expect(r.platform_balance_gb).toBe(100);
  });

  it("同一时刻重复跑 → 第二次不再生效（幂等）", () => {
    const first = settle(base, SETTLE_NOW);
    const second = settle({ ...base, last_settled_at: first.last_settled_at }, SETTLE_NOW);
    expect(second.due).toBe(false);
  });
});

describe("addAddonBalance / isOver", () => {
  it("加购只累加包余额", () => {
    expect(addAddonBalance(makeSub({ balance_gb: 12.5 }), 50)).toBe(62.5);
  });

  it("period 到期算结束，永久不算", () => {
    expect(isOver(makeSub({ expires_at: "2026-10-01T00:00:00Z" }), NOW)).toBe(true);
    expect(isOver(makeSub({ expires_at: null }), NOW)).toBe(false);
  });

  it("traffic 余量 0 算结束", () => {
    expect(isOver(makeSub({ kind: "traffic", remaining_gb: 0 }), NOW)).toBe(true);
  });
});
