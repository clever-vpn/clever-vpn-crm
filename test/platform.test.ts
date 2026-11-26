/**
 * 落账映射的纯函数测试。
 *
 * 这里钉死两个**会出事故**的点：
 *   1. 流量单位是字节（`1 GiB = 1024³`）—— 写成 100 就是 100 字节
 *   2. `quota` 恒为 NULL —— 一旦写了值，平台会按"记账自然月"重置，10 号买的用户少半个月
 */
import { describe, expect, it } from "vitest";

import {
  GIGA,
  asProvisionAction,
  authIdOf,
  controlParams,
  patchParams,
  trafficBytes,
} from "../src/platform/provision";

import type { Subscription } from "../src/plans/subscription";

function sub(over: Partial<Subscription> = {}): Subscription {
  const base: Subscription = {
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
    expires_at: "2026-10-31T12:34:56Z",
    period_anchor_day: 1,
    period_extra_gb: 0,
    period_settled_at: null,
    platform_customer_id: null,
    activation_code: null,
    trial: false,
  };
  return { ...base, ...over } as Subscription;
}

describe("trafficBytes：单位是字节，不是 GB", () => {
  it("1 GiB = 1024³", () => {
    expect(GIGA).toBe(1073741824);
  });

  it("period：本期额度 + 额外池", () => {
    expect(trafficBytes(sub({ period_quota_gb: 100, period_extra_gb: 20 }))).toBe(120 * GIGA);
  });

  it("period 不限量（quota = null）→ null（cf-api 侧等于不计费）", () => {
    expect(trafficBytes(sub({ period_quota_gb: null, period_extra_gb: 50 }))).toBeNull();
  });

  it("traffic：用剩余量，不是整包容量", () => {
    expect(
      trafficBytes(sub({ kind: "traffic", period_quota_gb: null, traffic_total_gb: 200, traffic_remaining_gb: 50 })),
    ).toBe(50 * GIGA);
  });

  it("traffic 余量未同步（null）→ 退化为整包，宁可多给不可误杀", () => {
    expect(
      trafficBytes(sub({ kind: "traffic", period_quota_gb: null, traffic_total_gb: 200, traffic_remaining_gb: null })),
    ).toBe(200 * GIGA);
  });

  it("traffic 不限量（无整包容量）→ null", () => {
    expect(
      trafficBytes(sub({ kind: "traffic", period_quota_gb: null, traffic_total_gb: null, traffic_remaining_gb: null })),
    ).toBeNull();
  });

  it("余量为负也不下发负数", () => {
    expect(
      trafficBytes(sub({ kind: "traffic", period_quota_gb: null, traffic_total_gb: 200, traffic_remaining_gb: -5 })),
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

  it("线路权益：空 = 全部（null）；有值原样投影（cf-api 负责归一/校验）", () => {
    expect(controlParams(sub())).toMatchObject({ line_ids: null });
    expect(controlParams(sub({ line_ids: [1, 3] }))).toMatchObject({ line_ids: [1, 3] });
  });
});

describe("authIdOf：幂等键跨换档不变", () => {
  it("只由 customer_id 决定", () => {
    expect(authIdOf(7)).toBe("crm:7");
    expect(authIdOf(7)).toBe(authIdOf(7));
  });
});

describe("patchParams：已存在的客户只写这次真变了的字段", () => {
  it("period 续订：只发 expire_date（碰了余额就是把已用的还回去）", () => {
    const patch = patchParams(sub(), "renewal");
    expect(Object.keys(patch)).toEqual(["expire_date"]);
    expect(patch.expire_date).toBe("2026-10-31");
  });

  it("traffic 续订：到期日 + 余额（remaining 已由调用方回源并 +gb）", () => {
    const patch = patchParams(
      sub({ kind: "traffic", period_quota_gb: null, traffic_total_gb: 200, traffic_remaining_gb: 70 }),
      "renewal",
    );
    expect(patch).toMatchObject({ traffic_balance: 70 * GIGA });
    expect(patch).toHaveProperty("expire_date");
  });

  it("加量包：只发余额，不动到期日", () => {
    const patch = patchParams(sub({ period_extra_gb: 50, traffic_remaining_gb: 90 }), "addon");
    expect(patch).toEqual({ traffic_balance: 90 * GIGA });
  });

  it("新购 / 升级：全量（新周期的满额是对的）", () => {
    expect(patchParams(sub(), "new")).toEqual(controlParams(sub()));
    expect(patchParams(sub(), "upgrade")).toEqual(controlParams(sub()));
  });

  it("重试时必须能认出动作；未知值退回 new", () => {
    expect(asProvisionAction("renewal")).toBe("renewal");
    expect(asProvisionAction("addon")).toBe("addon");
    expect(asProvisionAction(null)).toBe("new");
    expect(asProvisionAction("")).toBe("new");
    expect(asProvisionAction("whatever")).toBe("new");
  });
});
