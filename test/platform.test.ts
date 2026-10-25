/**
 * 落账映射的纯函数测试。
 *
 * 这里钉死两个**会出事故**的点：
 *   1. 流量单位是字节（`1 GiB = 1024³`）—— 写成 100 就是 100 字节
 *   2. `quota` 恒为 NULL —— 一旦写了值，平台会按"记账自然月"重置，10 号买的用户少半个月
 */
import { describe, expect, it } from "vitest";

import { GIGA, authIdOf, controlParams, trafficBytes } from "../src/platform/provision";

import type { Subscription } from "../src/plans/subscription";

function sub(over: Partial<Subscription> = {}): Subscription {
  const base: Subscription = {
    id: 1,
    customer_id: 7,
    plan_id: "p_30d_100g_1d",
    kind: "period",
    hold: "none",
    hold_reason: null,
    hold_at: null,
    paid_minor: 1500,
    currency: "CNY",
    licence_limit: 1,
    term_days: 30,
    quota_gb: 100,
    traffic_total_gb: null,
    validity_days: null,
    line_ids: [],
    started_at: "2026-10-01T00:00:00Z",
    expires_at: "2026-10-31T12:34:56Z",
    anchor_day: 1,
    balance_gb: 0,
    remaining_gb: null,
    last_settled_at: null,
    platform_customer_id: null,
    code: null,
  };
  return { ...base, ...over } as Subscription;
}

describe("trafficBytes：单位是字节，不是 GB", () => {
  it("1 GiB = 1024³", () => {
    expect(GIGA).toBe(1073741824);
  });

  it("period：本期额度 + 加购包余额", () => {
    expect(trafficBytes(sub({ quota_gb: 100, balance_gb: 20 }))).toBe(120 * GIGA);
  });

  it("period 不限量（quota_gb = null）→ null（cf-api 侧等于不计费）", () => {
    expect(trafficBytes(sub({ quota_gb: null, balance_gb: 50 }))).toBeNull();
  });

  it("traffic：用剩余量，不是整包容量", () => {
    expect(
      trafficBytes(sub({ kind: "traffic", quota_gb: null, traffic_total_gb: 200, remaining_gb: 50 })),
    ).toBe(50 * GIGA);
  });

  it("traffic 余量未同步（null）→ 退化为整包，宁可多给不可误杀", () => {
    expect(
      trafficBytes(sub({ kind: "traffic", quota_gb: null, traffic_total_gb: 200, remaining_gb: null })),
    ).toBe(200 * GIGA);
  });

  it("traffic 不限量（无整包容量）→ null", () => {
    expect(
      trafficBytes(sub({ kind: "traffic", quota_gb: null, traffic_total_gb: null, remaining_gb: null })),
    ).toBeNull();
  });

  it("余量为负也不下发负数", () => {
    expect(
      trafficBytes(sub({ kind: "traffic", quota_gb: null, traffic_total_gb: 200, remaining_gb: -5 })),
    ).toBe(0);
  });
});

describe("controlParams：控制参数只写平台认识的那几个", () => {
  it("quota 恒为 NULL —— 月度重置归 CRM（按购买锚点）", () => {
    expect(controlParams(sub()).quota).toBeNull();
  });

  it("expire_date 只给日期（平台按天判定）", () => {
    expect(controlParams(sub()).expire_date).toBe("2026-10-31");
  });

  it("永不过期 → expire_date = null", () => {
    expect(controlParams(sub({ expires_at: null })).expire_date).toBeNull();
  });

  it("冻结 / 作废必须同步到平台，否则用户照样能连", () => {
    expect(controlParams(sub({ hold: "none" })).frozen).toBe(0);
    expect(controlParams(sub({ hold: "frozen" })).frozen).toBe(1);
    expect(controlParams(sub({ hold: "revoked" })).frozen).toBe(1);
  });

  it("不含 licence_limit（创建后不可改，变了要删旧建新）", () => {
    expect(controlParams(sub())).not.toHaveProperty("licence_limit");
  });
});

describe("authIdOf：幂等键跨换档不变", () => {
  it("只由 customer_id 决定", () => {
    expect(authIdOf(7)).toBe("crm:7");
    expect(authIdOf(7)).toBe(authIdOf(7));
  });
});
