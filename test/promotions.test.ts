/**
 * 单测：促销纯逻辑（`app-crm.md` §2.9 / `docs/promotion.md` §4 三条不变量）
 *
 * 这里不碰 D1 —— 折扣金额、资格判定、多活动取更优全是纯函数，
 * 用真实边界值钉死，比在集成测试里造数据可靠得多。
 */
import { describe, expect, it } from "vitest";

import {
  appliedOf,
  bestPromotion,
  canAppearInList,
  checkPromotion,
  discountOf,
  promoBadgeText,
  yuan,
} from "../src/promotions/model";

import type { PromoContext, Promotion } from "../src/promotions/model";

const NOW = new Date("2026-10-25T12:00:00.000Z");

function promo(over: Partial<Promotion> = {}): Promotion {
  return {
    id: 1,
    auto_apply: false,
    name: "新人券",
    kind: "coupon",
    benefit_type: "amount",
    benefit_value: 300,
    min_subtotal_minor: 0,
    limit_plan_kinds: [],
    limit_plan_ids: [],
    rewards: { days: 0, gb: 0 },
    audience: "all",
    audience_days: null,
    cooldown_hours: null,
    plan_id: null,
    new_user_within_days: null,
    starts_at: null,
    ends_at: null,
    max_uses: null,
    max_uses_per_customer: 1,
    badge_label: "限时立减 3 元",
    visible: true,
    referrer_reward_type: null,
    referrer_reward_value: null,
    status: "active",
    ...over,
  };
}

function ctx(over: Partial<PromoContext> = {}): PromoContext {
  return {
    plan_id: "p_30d",
    plan_kind: "period",
    subtotal_minor: 1500,
    now: NOW,
    first_purchase: true,
    customer_age_days: 0,
    has_active_sub: false,
    days_to_expiry: null,
    targeted: false,
    uses_total: 0,
    uses_by_customer: 0,
    last_used_at: null,
    ...over,
  };
}

describe("折扣计算", () => {
  it("满减：直接减，且不超过标价", () => {
    expect(discountOf(promo({ benefit_type: "amount", benefit_value: 300 }), 1500)).toBe(300);
    // 标价 100 分减 300 分 ⇒ 只能减到 0，不能倒找钱
    expect(discountOf(promo({ benefit_type: "amount", benefit_value: 300 }), 100)).toBe(100);
  });

  it("百分比：向下取整到分（不能因舍入多减）", () => {
    // 8 折 = 减 20%：1500 × 20% = 300
    expect(discountOf(promo({ benefit_type: "percent", benefit_value: 20 }), 1500)).toBe(300);
    // 999 × 33% = 329.67 ⇒ 329
    expect(discountOf(promo({ benefit_type: "percent", benefit_value: 33 }), 999)).toBe(329);
    // 100% ⇒ 全免，但仍是"最多减到 0"
    expect(discountOf(promo({ benefit_type: "percent", benefit_value: 100 }), 1500)).toBe(1500);
  });

  it("0 元套餐 / 负数不会算出负折扣", () => {
    expect(discountOf(promo(), 0)).toBe(0);
    expect(discountOf(promo(), -100)).toBe(0);
  });

  it("文案：整句给用户看，不让人拼字符串", () => {
    expect(appliedOf(promo(), 1500).label).toBe("新人券 −¥3.00");
    expect(yuan(1200)).toBe("¥12.00");
  });
});

describe("资格判定", () => {
  it("草稿 / 已结束的活动一律不生效", () => {
    expect(checkPromotion(promo({ status: "draft" }), ctx()).ok).toBe(false);
    expect(checkPromotion(promo({ status: "ended" }), ctx()).ok).toBe(false);
  });

  it("时间窗：未开始与已过期都要拒", () => {
    expect(
      checkPromotion(promo({ starts_at: "2026-11-01T00:00:00.000Z" }), ctx()).ok,
    ).toBe(false);
    expect(
      checkPromotion(promo({ ends_at: "2026-10-01T00:00:00.000Z" }), ctx()).ok,
    ).toBe(false);
    // 结束时间正好等于 now ⇒ 已结束（左闭右开）
    expect(
      checkPromotion(promo({ ends_at: NOW.toISOString() }), ctx()).ok,
    ).toBe(false);
  });

  it("套餐范围：kind 与 id 两层过滤", () => {
    expect(
      checkPromotion(promo({ limit_plan_kinds: ["traffic"] }), ctx({ plan_kind: "period" })).ok,
    ).toBe(false);
    expect(
      checkPromotion(promo({ limit_plan_ids: ["other"] }), ctx({ plan_id: "p_30d" })).ok,
    ).toBe(false);
    expect(
      checkPromotion(promo({ limit_plan_kinds: ["period"], limit_plan_ids: ["p_30d"] }), ctx()).ok,
    ).toBe(true);
  });

  it("最低消费：够不着就拒，且理由带金额", () => {
    const check = checkPromotion(promo({ min_subtotal_minor: 2000 }), ctx());
    expect(check.ok).toBe(false);
    expect(check.ok === false && check.reason).toContain("¥20.00");
    expect(checkPromotion(promo({ min_subtotal_minor: 1500 }), ctx()).ok).toBe(true);
  });

  it("次数：总量用完 / 本人用完都拒", () => {
    expect(
      checkPromotion(promo({ max_uses: 10 }), ctx({ uses_total: 10 })).ok,
    ).toBe(false);
    expect(
      checkPromotion(promo({ max_uses_per_customer: 1 }), ctx({ uses_by_customer: 1 })).ok,
    ).toBe(false);
    expect(checkPromotion(promo({ max_uses_per_customer: 0 }), ctx()).ok).toBe(false);
    expect(checkPromotion(promo({ max_uses: null }), ctx({ uses_total: 999 })).ok).toBe(true);
  });

  it("新人限定（audience=new）：老客户不适用；匿名不能假装是新客", () => {
    expect(
      checkPromotion(promo({ audience: "new" }), ctx({ first_purchase: false })).ok,
    ).toBe(false);
    // 匿名（first_purchase = null）也要拒 —— 不能因为"看起来像新人"就打折
    expect(
      checkPromotion(promo({ audience: "new" }), ctx({ first_purchase: null })).ok,
    ).toBe(false);
    expect(checkPromotion(promo({ audience: "new" }), ctx()).ok).toBe(true);
  });

  it("人群：老客续费 / 快到期 / 已过期 / 点名，各有各的门槛", () => {
    // 已有订阅（续费场景）
    expect(checkPromotion(promo({ audience: "existing" }), ctx({ has_active_sub: true })).ok).toBe(true);
    expect(checkPromotion(promo({ audience: "existing" }), ctx({ has_active_sub: false })).ok).toBe(false);
    expect(checkPromotion(promo({ audience: "existing" }), ctx({ has_active_sub: null })).ok).toBe(false);

    // 快到期：只在 N 天内有效（含边界），没订阅 / 已过期都不算
    const expiring = promo({ audience: "expiring", audience_days: 7 });
    expect(checkPromotion(expiring, ctx({ has_active_sub: true, days_to_expiry: 7 })).ok).toBe(true);
    expect(checkPromotion(expiring, ctx({ has_active_sub: true, days_to_expiry: 8 })).ok).toBe(false);
    expect(checkPromotion(expiring, ctx({ has_active_sub: true, days_to_expiry: null })).ok).toBe(false);
    expect(checkPromotion(expiring, ctx({ has_active_sub: true, days_to_expiry: -1 })).ok).toBe(false);

    // 已过期：曾经有、现在没了
    expect(checkPromotion(promo({ audience: "expired" }), ctx({ has_active_sub: false })).ok).toBe(true);
    expect(checkPromotion(promo({ audience: "expired" }), ctx({ has_active_sub: true })).ok).toBe(false);

    // 点名：只认名单，其他人一律拒
    expect(checkPromotion(promo({ audience: "specific" }), ctx({ targeted: true })).ok).toBe(true);
    expect(checkPromotion(promo({ audience: "specific" }), ctx({ targeted: false })).ok).toBe(false);
  });

  it("冷却：上次核销没到间隔就拒，理由里给剩余小时", () => {
    const p = promo({ audience: "all", cooldown_hours: 24 });
    const used = new Date(NOW.getTime() - 3 * 3_600_000).toISOString();
    const check = checkPromotion(p, ctx({ last_used_at: used }));
    expect(check.ok).toBe(false);
    expect(check.ok === false && check.reason).toContain("21 小时");

    // 已经过了 24 小时 ⇒ 放行
    const old = new Date(NOW.getTime() - 25 * 3_600_000).toISOString();
    expect(checkPromotion(p, ctx({ last_used_at: old })).ok).toBe(true);
    // 从未核销 ⇒ 放行
    expect(checkPromotion(p, ctx({ last_used_at: null })).ok).toBe(true);
  });

  it("新客窗口：超过 N 天就拒", () => {
    const p = promo({ new_user_within_days: 7 });
    expect(checkPromotion(p, ctx({ customer_age_days: 7 })).ok).toBe(true);
    expect(checkPromotion(p, ctx({ customer_age_days: 8 })).ok).toBe(false);
    expect(checkPromotion(p, ctx({ customer_age_days: null })).ok).toBe(false);
  });
});

describe("多活动：取更优，不叠加", () => {
  it("两个活动同时可用时只取金额更大的那个", () => {
    const big = promo({ id: 2, name: "中秋券", benefit_value: 500 });
    const small = promo({ id: 1, name: "新人券", benefit_value: 300 });
    const best = bestPromotion([small, big], ctx());
    expect(best?.promotion.id).toBe(2);
    expect(best?.discount_minor).toBe(500);
  });

  it("同额时结果确定（按 id 升序，防止刷新两次金额抖动）", () => {
    const a = promo({ id: 7, name: "A", benefit_value: 300 });
    const b = promo({ id: 3, name: "B", benefit_value: 300 });
    expect(bestPromotion([a, b], ctx())?.promotion.id).toBe(3);
  });

  it("折扣为 0 的活动等于没命中", () => {
    expect(bestPromotion([promo({ benefit_value: 0 })], ctx())).toBeNull();
    expect(bestPromotion([], ctx())).toBeNull();
  });

  it("只有自动生效的券能进定价页（凭码券是站外渠道）", () => {
    const byCode = promo({ id: 1, name: "渠道码", auto_apply: false });
    const hidden = promo({ id: 2, name: "定向券", auto_apply: true, visible: false });
    const targeted = promo({ id: 3, name: "名单内", auto_apply: true, audience: "specific" });
    const gift = promo({ id: 4, name: "礼包", kind: "gift", auto_apply: true });
    const publicOne = promo({ id: 5, name: "公开券", auto_apply: true });
    const shown = [byCode, hidden, targeted, gift, publicOne]
      .filter(canAppearInList)
      .map((p) => p.id);
    expect(shown).toEqual([5]);
  });

  it("角标带系统人群前缀，租户只能填后半句", () => {
    expect(promoBadgeText(promo({ badge_label: "首单 8 折" }))).toBe("首单 8 折");
    expect(promoBadgeText(promo({ audience: "new", badge_label: "首单 8 折" }))).toBe(
      "限新用户 · 首单 8 折",
    );
    expect(promoBadgeText(promo({ audience: "expiring", audience_days: 7, badge_label: "续费 8 折" }))).toBe(
      "限7天内到期 · 续费 8 折",
    );
    // 定向名单永不公开 → 没有角标
    expect(promoBadgeText(promo({ audience: "specific", badge_label: "仅限受邀" }))).toBe("");
  });
});

describe("不变量：折扣只改金额，不改权益", () => {
  it("payable = max(0, promo(price) − residual)，残值不参与打折", () => {
    const price = 3000;
    const discount = discountOf(promo({ benefit_type: "percent", benefit_value: 20 }), price);
    // 8 折后 2400，再减残值 500 ⇒ 1900（而不是先把残值打折）
    expect(Math.max(0, price - discount - 500)).toBe(1900);
    // 折扣 + 残值超过标价 ⇒ 应付 0，不出现负数
    expect(Math.max(0, 1500 - 1500 - 500)).toBe(0);
  });
});

describe("兑换码的纯逻辑", () => {
  it("码归一：去空格 + 大写（用户手输常见这两种）", async () => {
    const { normalizePromoCode } = await import("../src/promotions/redeem");
    expect(normalizePromoCode("  guoqing7 ")).toBe("GUOQING7");
    expect(normalizePromoCode("GuoQing7")).toBe("GUOQING7");
    expect(normalizePromoCode(123)).toBe("");
    expect(normalizePromoCode(undefined)).toBe("");
  });

  it("码长下限 6 位：太短的码等于送（可穷举）", async () => {
    const { MIN_CODE_LENGTH, MAX_FAILED_ATTEMPTS } = await import("../src/promotions/redeem");
    expect(MIN_CODE_LENGTH).toBeGreaterThanOrEqual(6);
    // 与契约 §2.9.7 一致
    expect(MAX_FAILED_ATTEMPTS).toBe(5);
  });
});

describe("礼包能作用到哪些维度（applicableRewards）", () => {
  /** 只挑判断用得上的四个字段 */
  const sub = (over: {
    kind?: "period" | "traffic";
    expires_at?: string | null;
    period_quota_gb?: number | null;
    traffic_total_gb?: number | null;
  }) => ({
    kind: over.kind ?? ("period" as const),
    expires_at: over.expires_at === undefined ? "2026-11-22T00:00:00.000Z" : over.expires_at,
    period_quota_gb: over.period_quota_gb === undefined ? 100 : over.period_quota_gb,
    traffic_total_gb: over.traffic_total_gb ?? null,
  });

  const gift = { days: 7, gb: 5 };

  it("正常周期套餐：两个维度都收", async () => {
    const { applicableRewards } = await import("../src/promotions/gift");
    expect(applicableRewards(sub({}), gift)).toEqual({ days: 7, gb: 5 });
  });

  it("无限期（expires_at = null）⇒ 不收天数，但流量照收", async () => {
    const { applicableRewards } = await import("../src/promotions/gift");
    expect(applicableRewards(sub({ expires_at: null }), gift)).toEqual({ days: 0, gb: 5 });
  });

  it("period 不限量（quota = null）⇒ 不收 GB，但天数照收", async () => {
    const { applicableRewards } = await import("../src/promotions/gift");
    expect(applicableRewards(sub({ period_quota_gb: null }), gift)).toEqual({ days: 7, gb: 0 });
  });

  it("traffic 不限量（total = null）⇒ 不收 GB", async () => {
    const { applicableRewards } = await import("../src/promotions/gift");
    expect(applicableRewards(sub({ kind: "traffic", traffic_total_gb: null }), gift)).toEqual({
      days: 7,
      gb: 0,
    });
  });

  it("两项都不适用 ⇒ 全 0（调用方据此跳过，不发也不建单）", async () => {
    const { applicableRewards } = await import("../src/promotions/gift");
    const { hasRewards } = await import("../src/promotions/model");
    const applied = applicableRewards(
      sub({ expires_at: null, period_quota_gb: null }),
      gift,
    );
    expect(applied).toEqual({ days: 0, gb: 0 });
    expect(hasRewards(applied)).toBe(false);
  });
});
