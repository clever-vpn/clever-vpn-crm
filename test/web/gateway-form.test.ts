/**
 * 新建网关表单的 driver 规则。
 *
 * 这里只测纯逻辑：哪些 driver 可创建、哪些固定方式、历史行如何加回。
 * DOM 行为由本地 E2E 覆盖。
 */

import { describe, expect, it } from "vitest";

import {
  defaultMethods,
  driverFields,
  secretFieldLabel,
  showMethodPicker,
  visibleDrivers,
} from "../../web/src/gateway-form";

const DRIVERS = [
  { driver: "epay_v1", methods: ["alipay", "wechat"] },
  { driver: "generic_json_v1", methods: ["alipay", "wechat"] },
  { driver: "stripe", methods: ["stripe"] },
  { driver: "paypal", methods: ["paypal"] },
  { driver: "manual", methods: ["transfer"] },
  { driver: "mock", methods: ["alipay", "wechat"] },
];

describe("visibleDrivers", () => {
  it("新建：列出有实现的 driver，排除 manual；mock 始终可用", () => {
    const out = visibleDrivers(DRIVERS, {});
    expect(out.map((d) => d.driver)).toEqual([
      "epay_v1",
      "generic_json_v1",
      "stripe",
      "paypal",
      "mock",
    ]);
  });

  it("编辑历史 manual：把当前 driver 加回，且不改输入", () => {
    const snapshot = JSON.stringify(DRIVERS);
    const out = visibleDrivers(DRIVERS, { current: "manual" });
    expect(out[0]!.driver).toBe("manual");
    expect(JSON.stringify(DRIVERS)).toBe(snapshot);
  });

  it("编辑历史 mock：仍加回当前行", () => {
    const out = visibleDrivers(DRIVERS, { current: "mock" });
    expect(out.some((d) => d.driver === "mock")).toBe(true);
  });
});

describe("固定支付方式", () => {
  it("Stripe / PayPal / manual 不显示方式选择器", () => {
    expect(showMethodPicker("stripe")).toBe(false);
    expect(showMethodPicker("paypal")).toBe(false);
    expect(showMethodPicker("manual")).toBe(false);
    expect(showMethodPicker("epay_v1")).toBe(true);
    expect(showMethodPicker("generic_json_v1")).toBe(true);
    expect(showMethodPicker("mock")).toBe(true);
  });

  it("固定 driver 用固定方式；聚合 driver 取第一个允许项", () => {
    expect(defaultMethods("stripe", ["stripe"])).toEqual(["stripe"]);
    expect(defaultMethods("paypal", ["paypal"])).toEqual(["paypal"]);
    expect(defaultMethods("manual", ["transfer"])).toEqual(["transfer"]);
    expect(defaultMethods("epay_v1", ["alipay", "wechat"])).toEqual(["alipay"]);
  });
});

describe("driverFields", () => {
  it("Stripe：只要 Secret Key，无网关地址/商户号/方式", () => {
    expect(driverFields("stripe")).toMatchObject({
      endpoint: false,
      merchant: false,
      secret: true,
      webhook: true,
      methods: false,
      mapping: null,
      secretLabel: "Secret Key",
      webhookLabel: "Webhook Secret",
    });
  });

  it("PayPal：Client ID + Client Secret，无网关地址/方式", () => {
    expect(driverFields("paypal")).toMatchObject({
      endpoint: false,
      merchant: true,
      merchantLabel: "Client ID",
      secret: true,
      webhook: true,
      secretLabel: "Client Secret",
      webhookLabel: "Webhook ID",
      methods: false,
      mapping: null,
    });
  });

  it("易支付/自定义支付接口：地址 + 商户号 + 方式 + 映射", () => {
    expect(driverFields("epay_v1").mapping).toBe("epay");
    expect(driverFields("epay_v1").endpoint).toBe(true);
    expect(driverFields("generic_json_v1").mapping).toBe("generic");
    expect(driverFields("generic_json_v1").merchantLabel).toBe("商户号");
  });

  it("manual / mock：不显示不相关字段", () => {
    expect(driverFields("manual")).toMatchObject({
      endpoint: false,
      merchant: false,
      secret: false,
      webhook: false,
      methods: false,
    });
    expect(driverFields("mock")).toMatchObject({
      endpoint: false,
      merchant: false,
      secret: false,
      webhook: false,
      methods: true,
    });
  });

  it("密钥标签不带「留空不改」", () => {
    expect(secretFieldLabel("stripe")).toBe("Secret Key");
    expect(secretFieldLabel("paypal")).toBe("Client Secret");
    expect(secretFieldLabel("epay_v1")).toBe("密钥");
  });
});
