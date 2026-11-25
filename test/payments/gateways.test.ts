/**
 * 闸门与路由选择 —— 这里错一条就是"免费开通会员"，所以逐条钉死。
 */

import { describe, expect, it } from "vitest";

import { EPAY_V1_MAPPING } from "../../src/payments/builtin/epay";
import {
  gatewayVisibleTo,
  mappingOf,
  parseAllowedEmails,
  pickGateway,
  visibleMethods,
  type GatewayRow,
} from "../../src/payments/gateways";
import { MOCK_MAPPING, buildMockNotifyParams, mockNotifyRequest } from "../../src/payments/mock";
import { parseNotify } from "../../src/payments/mapping";

import type { Env } from "../../src/env";

const SECRET = "test-secret";

function env(over: Partial<Env> = {}): Env {
  return { DB: {} as never, ASSETS: {} as never, APP_SECRET: SECRET, ...over };
}

function gw(over: Partial<GatewayRow> = {}): GatewayRow {
  return {
    id: 1,
    driver: "epay_v1",
    name: "支付宝-主号",
    endpoint: "https://pay.example.com",
    paypal_env: null,
    merchant_id: "M1",
    secret_enc: null,
    webhook_enc: null,
    methods: '["alipay","wechat"]',
    channel_codes: null,
    mapping: null,
    priority: 100,
    status: "live",
    currency: "CNY",
    fx_rate: 1,
    test_amount_minor: 100,
    test_create_ok_at: null,
    test_query_ok_at: null,
    test_callback_ok_at: null,
    tested_config_hash: null,
    test_require_callback: 0,
    allowed_emails: null,
    last_test_order_id: null,
    last_ok_at: null,
    last_error: null,
    ...over,
  };
}

describe("测试网关的第二道闸门：allowed_emails", () => {
  const g = gw({ driver: "mock", allowed_emails: '["a@b.com"]' });

  it("白名单非空 → 名单内可见，名单外不可见", () => {
    const e = env();
    expect(gatewayVisibleTo(g, "a@b.com", e)).toBe(true);
    expect(gatewayVisibleTo(g, "A@B.COM", e)).toBe(true); // 邮箱归一
    expect(gatewayVisibleTo(g, "other@b.com", e)).toBe(false);
  });

  it("白名单为空 → 仍然不可见（否则等于向所有真实用户免费开通）", () => {
    const e = env();
    expect(gatewayVisibleTo(gw({ driver: "mock", allowed_emails: null }), "a@b.com", e)).toBe(false);
    expect(gatewayVisibleTo(gw({ driver: "mock", allowed_emails: "[]" }), "a@b.com", e)).toBe(false);
  });
});

describe("PayPal Sandbox 的白名单", () => {
  const g = gw({ driver: "paypal", methods: '["paypal"]', paypal_env: "sandbox", allowed_emails: '["sandbox@b.com"]' });
  it("Sandbox 只对白名单可见；空名单不路由", () => {
    expect(gatewayVisibleTo(g, "sandbox@b.com", env())).toBe(true);
    expect(gatewayVisibleTo(g, "real@b.com", env())).toBe(false);
    expect(gatewayVisibleTo({ ...g, allowed_emails: null }, "sandbox@b.com", env())).toBe(false);
  });
});

describe("真实网关的白名单（灰度发布）", () => {
  it("为空 = 不限", () => {
    expect(gatewayVisibleTo(gw(), "anyone@b.com", env())).toBe(true);
  });

  it("非空 = 只给名单内的人", () => {
    const g = gw({ allowed_emails: '["vip@b.com"]' });
    expect(gatewayVisibleTo(g, "vip@b.com", env())).toBe(true);
    expect(gatewayVisibleTo(g, "anyone@b.com", env())).toBe(false);
  });

  it("坏 JSON 当空名单处理（不限），不抛错", () => {
    expect(parseAllowedEmails("{oops")).toEqual([]);
    expect(gatewayVisibleTo(gw({ allowed_emails: "{oops" }), "x@b.com", env())).toBe(true);
  });
});

describe("pickGateway 路由", () => {
  const mockOn = env();

  it("按 priority 升序取第一条；draft 不参与", () => {
    const rows = [
      gw({ id: 3, priority: 30 }),
      gw({ id: 2, priority: 20, status: "draft" }),
      gw({ id: 1, priority: 10 }),
    ];
    expect(pickGateway(rows, "alipay", "a@b.com", env())?.gateway.id).toBe(1);
  });

  it("方式不匹配时跳过", () => {
    const rows = [gw({ id: 1, methods: '["wechat"]' }), gw({ id: 2, priority: 200 })];
    const picked = pickGateway(rows, "alipay", "a@b.com", env());
    expect(picked?.gateway.id).toBe(2);
  });

  it("mock 与真实网关同时存在时，优先级低的先试", () => {
    const rows = [
      gw({ id: 1, driver: "mock", priority: 50, allowed_emails: '["a@b.com"]' }),
      gw({ id: 2, driver: "epay_v1", priority: 100 }),
    ];
    expect(pickGateway(rows, "alipay", "a@b.com", mockOn)?.gateway.driver).toBe("mock");
    // 名单外的人拿不到 mock，落到真实网关
    expect(pickGateway(rows, "alipay", "x@b.com", mockOn)?.gateway.driver).toBe("epay_v1");
  });

  it("Stripe / PayPal 走薄 driver 参与路由；manual 不参与", () => {
    const rows = [
      gw({ id: 1, driver: "manual", methods: '["transfer"]', priority: 1 }),
      gw({ id: 2, driver: "stripe", methods: '["stripe"]', priority: 10 }),
      gw({ id: 3, driver: "paypal", methods: '["paypal"]', priority: 20, paypal_env: "live" }),
    ];
    const stripe = pickGateway(rows, "stripe", "a@b.com", env());
    expect(stripe?.gateway.id).toBe(2);
    expect(stripe?.driver).toBe("stripe");
    expect(stripe?.mapping).toBeNull();

    const paypal = pickGateway(rows, "paypal", "a@b.com", env());
    expect(paypal?.gateway.id).toBe(3);
    expect(paypal?.driver).toBe("paypal");

    expect(pickGateway(rows, "transfer", "a@b.com", env())).toBeNull();
  });

  it("visibleMethods 包含 Stripe/PayPal，不包含 manual", () => {
    const stripe = gw({ driver: "stripe", methods: '["stripe"]' });
    const paypal = gw({ driver: "paypal", methods: '["paypal"]', paypal_env: "live" });
    const manual = gw({ driver: "manual", methods: '["transfer"]' });
    expect(visibleMethods(stripe, "a@b.com", env())).toEqual(["stripe"]);
    expect(visibleMethods(paypal, "a@b.com", env())).toEqual(["paypal"]);
    expect(visibleMethods(manual, "a@b.com", env())).toEqual([]);
  });

  it("一条都不满足时返回 null", () => {
    expect(pickGateway([gw({ status: "disabled" })], "alipay", "a@b.com", env())).toBeNull();
    expect(pickGateway([], "alipay", "a@b.com", env())).toBeNull();
  });
});

describe("mappingOf", () => {
  it("epay_v1 / mock 用内置映射", () => {
    expect(mappingOf(gw({ driver: "epay_v1" }))).toBe(EPAY_V1_MAPPING);
    expect(mappingOf(gw({ driver: "mock" }))).toBe(MOCK_MAPPING);
  });

  it("Stripe/PayPal 不是映射类 driver", () => {
    expect(mappingOf(gw({ driver: "stripe" }))).toBeNull();
    expect(mappingOf(gw({ driver: "paypal" }))).toBeNull();
  });

  it("generic_json_v1 解析网关上的 mapping；非法返回 null", () => {
    const good = gw({
      driver: "generic_json_v1",
      mapping: JSON.stringify({
        create: {
          request: {
            path: "/pay",
            fields: [
              { field: "mch", role: "merchant", value: "{merchant}" },
              { field: "no", role: "order_no", value: "{order_no}" },
              { field: "amt", role: "amount", value: "{amount}", unit: "yuan" },
            ],
            sign: { algo: "md5", key_append: "" },
          },
          response: { ok: { path: "code", equals: 1 }, fields: [{ field: "url", role: "pay_url" }] },
        },
        notify: {
          request: {
            fields: [{ field: "no", role: "order_no" }],
            paid_when: { path: "s", equals: 1 },
            sign: { algo: "md5" },
          },
          response: { reply: "success" },
        },
        query: {
          request: {
            path: "/query",
            fields: [{ field: "no", value: "{order_no}" }],
            sign: { algo: "md5" },
          },
          response: { paid_when: { path: "s", equals: 1 }, fields: [] },
        },
      }),
    });
    expect(mappingOf(good)).not.toBeNull();
    expect(mappingOf(gw({ driver: "generic_json_v1", mapping: "{bad" }))).toBeNull();
    expect(mappingOf(gw({ driver: "generic_json_v1", mapping: null }))).toBeNull();
  });
});

describe("mock 回调（走真实解析路径）", () => {
  const input = {
    merchantId: "M1",
    orderNo: "ORD-1",
    amountMinor: 1234,
    currency: "CNY",
    fx_rate: 1,
    test_amount_minor: 100,
    test_create_ok_at: null,
    test_query_ok_at: null,
    test_callback_ok_at: null,
    tested_config_hash: null,
    test_require_callback: 0,
    now: new Date("2026-10-24T04:00:00Z"),
  };

  it("签名被真实验签接受，金额按分解析", () => {
    const params = buildMockNotifyParams(input, SECRET);
    const r = parseNotify(MOCK_MAPPING, params, SECRET);
    expect(r.signOk).toBe(true);
    expect(r.paid).toBe(true);
    expect(r.orderNo).toBe("ORD-1");
    expect(r.amountMinor).toBe(1234);
    expect(r.tradeNo).toMatch(/^MOCK\d+$/);
  });

  it("改金额 → 验签失败（证明不是「随便发个表单就算数」）", () => {
    const params = buildMockNotifyParams(input, SECRET);
    params.amount = "1";
    expect(parseNotify(MOCK_MAPPING, params, SECRET).signOk).toBe(false);
  });

  it("用错密钥也验不过", () => {
    const params = buildMockNotifyParams(input, "other-secret");
    expect(parseNotify(MOCK_MAPPING, params, SECRET).signOk).toBe(false);
  });

  it("status 不是 SUCCESS 时不算已付", () => {
    const params = buildMockNotifyParams({ ...input, status: "FAILED" }, SECRET);
    const r = parseNotify(MOCK_MAPPING, params, SECRET);
    expect(r.signOk).toBe(true);
    expect(r.paid).toBe(false);
  });

  it("构造出的 Request 是 form POST", async () => {
    const params = buildMockNotifyParams(input, SECRET);
    const req = mockNotifyRequest("https://crm.example.com/api/pay/notify/1", params);
    expect(req.method).toBe("POST");
    expect(req.headers.get("Content-Type")).toContain("form-urlencoded");
    const body = new URLSearchParams(await req.text());
    expect(body.get("out_trade_no")).toBe("ORD-1");
    expect(body.get("sign")).toBe(params.sign);
  });
});
