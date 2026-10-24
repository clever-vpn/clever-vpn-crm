/**
 * 套餐模型 + 换购报价 —— 纯函数单测
 *
 * 这些规则是"销售策略"的全部实现，必须一眼可验证：
 *   残值 = 实付价 × 剩余比例；应付 = 新价 − 残值；应付 < 0 拒绝降档；
 *   不跨 kind 换购；同一时刻只有一个主订阅。
 */

import { describe, it, expect } from "vitest";

import {
  addDaysIso,
  applyAddon,
  applyPlanPatch,
  planToControlParams,
  rowToPlan,
  validatePlan,
} from "../src/plans/model";
import { isSubscriptionOver, quotePurchase, residualMinor } from "../src/plans/quote";

import type { Plan, PlanRow } from "../src/plans/model";
import type { CurrentSubscription } from "../src/plans/quote";

const NOW = new Date("2026-10-23T00:00:00Z");

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
    retired_at: null,
    ...over,
  };
}

/** 生效中 30 天周期订阅，刚买（剩余 30 天） */
function makeCurrent(over: Partial<CurrentSubscription> = {}): CurrentSubscription {
  const base: CurrentSubscription = {
    plan_id: "p_30d_100g_1d",
    kind: "period",
    // 标价 1500 / 实付 1500：促销时两者会分叉，升级判定只看前者
    list_price_minor: 1500,
    paid_minor: 1500,
    term_days: 30,
    traffic_gb: null,
    expires_at: "2026-11-22T00:00:00Z",
    remaining_gb: null,
    unlimited: false,
  };
  return { ...base, ...over } as CurrentSubscription;
}

describe("validatePlan", () => {
  const base = {
    id: "p_30d_100g_1d",
    name: "月付 · 100GB",
    kind: "period",
    price_minor: 1500,
    currency: "cny",
    licence_limit: 1,
    term_days: 30,
    monthly_quota_gb: 100,
    sales_channels: [{ channel: "web_checkout", methods: ["alipay", "wechat"] }],
  };

  it("合法周期套餐 → 归一化币种大写", () => {
    const r = validatePlan(base);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.plan.currency).toBe("CNY");
      expect(r.plan.sales_channels[0]!.methods).toEqual(["alipay", "wechat"]);
      expect(r.plan.status).toBe("draft"); // 新建一律草稿
    }
  });

  it("licence_limit 只能是 1–3", () => {
    const r = validatePlan({ ...base, licence_limit: 5 });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors.join()).toContain("设备数");
  });


  it("流量套餐不能填周期字段", () => {
    const r = validatePlan({
      ...base,
      kind: "traffic",
      traffic_gb: 200,
      term_days: 30,
      monthly_quota_gb: null,
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors.join()).toContain("流量套餐");
  });

  it("加购包不能自带有效期", () => {
    const r = validatePlan({
      ...base,
      kind: "addon",
      traffic_gb: 50,
      term_days: null,
      monthly_quota_gb: null,
      validity_days: 30,
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors.join()).toContain("加购包");
  });

  it("选了商店通道就必须有商品 ID", () => {
    const r = validatePlan({ ...base, sales_channels: [{ channel: "apple_iap" }] });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors.join()).toContain("Apple");
  });

  it("id 必须是小写短横线风格", () => {
    expect(validatePlan({ ...base, id: "Plan A" }).ok).toBe(false);
    expect(validatePlan({ ...base, id: "p-a" }).ok).toBe(true);
  });
});

describe("planToControlParams", () => {
  it("period：到期日 = 今天 + 天数，额度 = traffic_balance，quota 恒 null", () => {
    const c = planToControlParams(makePlan(), NOW);
    expect(c).toEqual({
      expire_date: "2026-11-22",
      traffic_balance: 100,
      quota: null,
      up_mbps: null,
      down_mbps: null,
      licence_limit: 1,
    });
  });

  it("period 不限量：traffic_balance = null（平台视为不计费）", () => {
    const c = planToControlParams(makePlan({ monthly_quota_gb: null }), NOW);
    expect(c.traffic_balance).toBeNull();
    expect(c.quota).toBeNull();
  });

  it("traffic 永久包：expire_date = null", () => {
    const c = planToControlParams(
      makePlan({ kind: "traffic", term_days: null, monthly_quota_gb: null, traffic_gb: 200, validity_days: null }),
      NOW,
    );
    expect(c.expire_date).toBeNull();
    expect(c.traffic_balance).toBe(200);
  });

  it("addon 不能直接落账（不是主订阅）", () => {
    expect(() =>
      planToControlParams(makePlan({ kind: "addon", term_days: null, monthly_quota_gb: null, traffic_gb: 50 })),
    ).toThrow(/addon/);
  });

  it("addDaysIso 跨月正确", () => {
    expect(addDaysIso(new Date("2026-01-31T00:00:00Z"), 30)).toBe("2026-03-02");
  });
});

describe("applyAddon", () => {
  const addon = makePlan({ kind: "addon", term_days: null, monthly_quota_gb: null, traffic_gb: 50 });

  it("余额累加，不动其它", () => {
    expect(applyAddon(37.5, addon)).toBe(87.5);
  });

  it("不限量（null）不能加购", () => {
    expect(() => applyAddon(null, addon)).toThrow(/不限量/);
  });
});

describe("residualMinor", () => {
  it("period 按小时线性折算", () => {
    // 30 天里已用 15 天 → 剩一半
    const current = makeCurrent({ expires_at: "2026-11-07T00:00:00Z" });
    expect(residualMinor(current, NOW)).toBe(750);
  });

  it("period 已过期 → 0", () => {
    expect(residualMinor(makeCurrent({ expires_at: "2026-10-01T00:00:00Z" }), NOW)).toBe(0);
  });
  it("traffic 按剩余 GB 折算", () => {
    const current = makeCurrent({ kind: "traffic", term_days: null, traffic_gb: 200, remaining_gb: 50, expires_at: null });
    expect(residualMinor(current, NOW)).toBe(375); // 1500 × 50/200
  });

  it("实付价而不是目录价（促销买的按促销价折）", () => {
    const current = makeCurrent({ paid_minor: 900, expires_at: "2026-11-07T00:00:00Z" });
    expect(residualMinor(current, NOW)).toBe(450);
  });
});

describe("quotePurchase", () => {
  it("无订阅 → 新购，settlement=new", () => {
    const q = quotePurchase(null, makePlan(), NOW);
    expect(q.allowed).toBe(true);
    expect(q.settlement).toBe("new");
    expect(q.residual_minor).toBe(0);
    expect(q.payable_minor).toBe(1500);
    expect(q.expires_at).toBe("2026-11-22T00:00:00.000Z");
  });

  it("续订（同档）：全款、顺延、不抵扣残值", () => {
    const q = quotePurchase(makeCurrent({ expires_at: "2026-11-07T00:00:00Z" }), makePlan(), NOW);
    expect(q.allowed).toBe(true);
    expect(q.action).toBe("renewal");
    expect(q.settlement).toBe("renewal");
    expect(q.residual_minor).toBe(0);
    expect(q.payable_minor).toBe(1500); // 全款
    // 从原到期日再往后 30 天，不是从今天起算
    expect(q.expires_at).toBe("2026-12-07T00:00:00.000Z");
  });

  it("升档：应付 = 新价 − 残值", () => {
    const target = makePlan({ id: "p_30d_200g_3d", price_minor: 4000, monthly_quota_gb: 200, licence_limit: 3 });
    const q = quotePurchase(makeCurrent({ expires_at: "2026-11-07T00:00:00Z" }), target, NOW);
    expect(q.payable_minor).toBe(3250);
  });

  it("残值刚好抵满新价（应付 = 0）也要拒绝：不给 0 元单开后门", () => {
    const target = makePlan({ id: "p_exact", price_minor: 750 });
    const q = quotePurchase(makeCurrent({ expires_at: "2026-11-15T00:00:00Z" }), target, NOW);
    expect(q.allowed).toBe(false);
    expect(q.action).toBe("blocked");
    expect(q.payable_minor).toBeNull();
  });

  it("降档：应付 < 0 → 拒绝，且给出可展示的原因", () => {
    const target = makePlan({ id: "p_30d_20g", price_minor: 300, monthly_quota_gb: 20 });
    const q = quotePurchase(makeCurrent({ expires_at: "2026-11-15T00:00:00Z" }), target, NOW);
    expect(q.allowed).toBe(false);
    expect(q.reason).toContain("降档");
    expect(q.payable_minor).toBeNull();
  });

  it("周期生效中可以**升级**成流量包（跨 kind 允许，标价更高 + 残值抵扣）", () => {
    const target = makePlan({
      id: "p_traffic_200g",
      kind: "traffic",
      term_days: null,
      monthly_quota_gb: null,
      traffic_gb: 200,
      // 必须**标价更高**才算升级（v11）：当前套餐标价 1500
      price_minor: 5000,
    });
    const q = quotePurchase(makeCurrent({ expires_at: "2026-11-15T00:00:00Z" }), target, NOW);
    expect(q.allowed).toBe(true);
    expect(q.action).toBe("upgrade");
    expect(q.settlement).toBe("residual_trade_in");
    // 还剩 23 天 / 30 天 ⇒ 残值 1150，付差价 3850
    expect(q.residual_minor).toBe(1150);
    expect(q.payable_minor).toBe(3850);
  });

  it("平档换购也算降档：标价不涨就不是升级", () => {
    // 同为 1500 的另一个套餐：金额上“不亏”，但业务上不允许平换
    const target = makePlan({ id: "p_30d_100g_other", price_minor: 1500 });
    const q = quotePurchase(makeCurrent(), target, NOW);
    expect(q.allowed).toBe(false);
    expect(q.reason).toContain("降档");
  });

  it("标价更高时只补差价（残值按实付价算）", () => {
    const target = makePlan({ id: "p_30d_120g", price_minor: 1600 });
    // 刚买、实付 1500、剩余接近 100% ⇒ 残值 1500，应付 100 仍 > 0
    const q = quotePurchase(makeCurrent(), target, NOW);
    expect(q.allowed).toBe(true);
    expect(q.payable_minor).toBe(100);
  });

  it("到期之后可以买流量包（视为新购）", () => {
    const target = makePlan({ kind: "traffic", term_days: null, monthly_quota_gb: null, traffic_gb: 200 });
    const q = quotePurchase(makeCurrent({ expires_at: "2026-10-01T00:00:00Z" }), target, NOW);
    expect(q.allowed).toBe(true);
    expect(q.settlement).toBe("new");
    expect(q.payable_minor).toBe(1500);
  });

  it("流量用尽后可以买周期套餐", () => {
    const current = makeCurrent({ kind: "traffic", term_days: null, traffic_gb: 200, remaining_gb: 0, expires_at: null });
    const q = quotePurchase(current, makePlan(), NOW);
    expect(q.allowed).toBe(true);
    expect(q.settlement).toBe("new");
  });

  it("流量生效中换更大包：残值抵扣", () => {
    const current = makeCurrent({ kind: "traffic", term_days: null, traffic_gb: 200, remaining_gb: 100, expires_at: null });
    const target = makePlan({
      id: "p_traffic_400g",
      kind: "traffic",
      term_days: null,
      monthly_quota_gb: null,
      traffic_gb: 400,
      price_minor: 2500,
    });
    const q = quotePurchase(current, target, NOW);
    expect(q.allowed).toBe(true);
    expect(q.action).toBe("upgrade");
    expect(q.residual_minor).toBe(750);
    expect(q.payable_minor).toBe(1750);
    expect(q.expires_at).toBeNull();
  });

  it("加购：**只要有周期主订阅就能买**，没有额外开关", () => {
    const addon = makePlan({
      id: "pack_50g",
      kind: "addon",
      term_days: null,
      monthly_quota_gb: null,
      traffic_gb: 50,
      price_minor: 500,
    });
    const ok = quotePurchase(makeCurrent(), addon, NOW);
    expect(ok.allowed).toBe(true);
    // 加量包的交易行为恒为“按标价加流量” ⇒ action 就是 buy（不再单设 addon 格）
    expect(ok.action).toBe("buy");
    expect(ok.payable_minor).toBe(500);
    expect(ok.expires_at).toBe("2026-11-22T00:00:00.000Z"); // 不动到期日

    // 本月流量用完之后照样能买（这正是加购的用途）
    const exhausted = quotePurchase(makeCurrent({ remaining_gb: 0 }), addon, NOW);
    expect(exhausted.allowed).toBe(true);

    // 没有主订阅 / 主订阅已结束 ⇒ 无处可挂
    const over = quotePurchase(makeCurrent({ expires_at: "2026-10-01T00:00:00Z" }), addon, NOW);
    expect(over.allowed).toBe(false);
    expect(over.reason).toContain("周期套餐");
  });

  it("不限量套餐不加购（加了对用户也没作用）", () => {
    const addon = makePlan({ id: "pack_50g", kind: "addon", term_days: null, monthly_quota_gb: null, traffic_gb: 50 });
    const q = quotePurchase(makeCurrent({ unlimited: true }), addon, NOW);
    expect(q.allowed).toBe(false);
    expect(q.reason).toContain("不限量");
  });
});

describe("isSubscriptionOver", () => {
  it("永久周期订阅（expires_at=null）不算结束", () => {
    expect(isSubscriptionOver(makeCurrent({ expires_at: null }), NOW)).toBe(false);
  });

  it("流量余额 0 算结束", () => {
    expect(
      isSubscriptionOver(
        makeCurrent({ kind: "traffic", term_days: null, traffic_gb: 10, remaining_gb: 0, expires_at: null }),
        NOW,
      ),
    ).toBe(true);
  });
});

describe("rowToPlan", () => {
  it("JSON 列解析失败时不炸（回到默认值）", () => {
    const row: PlanRow = {
      id: "x_1", name: "x", kind: "period", price_minor: 100, currency: "CNY", licence_limit: 1,
      term_days: 30, monthly_quota_gb: 10, traffic_gb: null, validity_days: null,
      line_ids: "[1,2]", up_mbps: null, down_mbps: null,
      sales_channels: "not-json", store_product_id: "{}", sort_order: 0, status: "active",
      retired_at: null,
    };
    const plan = rowToPlan(row);
    expect(plan.line_ids).toEqual([1, 2]);
    expect(plan.sales_channels).toEqual([]);
  });
});

describe("applyPlanPatch（可变目录的合并规则）", () => {
  it("在售套餐可以直接改价，状态不变", () => {
    const result = applyPlanPatch(makePlan({ status: "active" }), { price_minor: 1800 });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.plan.price_minor).toBe(1800);
    expect(result.plan.status).toBe("active");
    // 没提到的字段原样保留（PATCH 是局部更新）
    expect(result.plan.monthly_quota_gb).toBe(100);
    expect(result.plan.sales_channels).toEqual([{ channel: "web_checkout", methods: ["alipay"] }]);
  });

  it("不能通过 PATCH 把 status 改成 draft（状态机只能走 publish/retire）", () => {
    const result = applyPlanPatch(makePlan({ status: "active" }), { status: "draft" });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.plan.status).toBe("active");
  });

  it("不能通过 PATCH 改 id（订单与订阅都指着它）", () => {
    const result = applyPlanPatch(makePlan(), { id: "hijacked" });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.plan.id).toBe("p_30d_100g_1d");
  });

  it("已下架套餐改内容时保留 retired_at（不会被合并顺手清掉）", () => {
    const retiredAt = "2026-10-01T00:00:00.000Z";
    const result = applyPlanPatch(makePlan({ status: "retired", retired_at: retiredAt }), { name: "改名" });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.plan.status).toBe("retired");
    expect(result.plan.retired_at).toBe(retiredAt);
  });

  it("合并后仍要过完整校验（清空售卖渠道会被拒）", () => {
    const result = applyPlanPatch(makePlan(), { sales_channels: [] });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errors.join()).toContain("至少选一个售卖渠道");
  });
});
