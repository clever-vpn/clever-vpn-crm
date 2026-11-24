import { describe, expect, it } from "vitest";

import {
  makeReturnPageUrl,
  makeReturnToken,
  normalizeReturnUrl,
  verifyReturnToken,
} from "../../src/payments/return-token";

import type { Env } from "../../src/env";

const env = { APP_SECRET: "return-token-test-secret" } as Env;
const NOW = new Date("2026-11-23T10:00:00Z");

describe("支付回跳 token", () => {
  it("签发后可验证，且绑定订单号/最终地址", async () => {
    const token = await makeReturnToken(env, "ORD-1", "https://site.test/_crm/return.html?order=ORD-1", NOW);
    expect(token).toBeTruthy();
    const claims = await verifyReturnToken(env, token!, "ORD-1", NOW);
    expect(claims).toMatchObject({
      c: "ORD-1",
      to: "https://site.test/_crm/return.html?order=ORD-1",
    });
  });

  it("篡改、错误订单号、过期都拒绝", async () => {
    const token = await makeReturnToken(env, "ORD-1", null, NOW);
    expect(await verifyReturnToken(env, `${token}x`, "ORD-1", NOW)).toBeNull();
    expect(await verifyReturnToken(env, token!, "ORD-2", NOW)).toBeNull();
    const later = new Date(NOW.getTime() + 25 * 3600 * 1000);
    expect(await verifyReturnToken(env, token!, "ORD-1", later)).toBeNull();
  });

  it("没有 APP_SECRET 不签", async () => {
    const empty = { APP_SECRET: "" } as Env;
    expect(await makeReturnToken(empty, "ORD-1", null, NOW)).toBeNull();
    expect(await makeReturnPageUrl(empty, "https://crm.test", "ORD-1", null, NOW)).toBeNull();
  });

  it("normalizeReturnUrl 追加 order，拒绝危险 scheme", () => {
    expect(normalizeReturnUrl("https://site.test/_crm/return.html", "ORD-1")).toBe(
      "https://site.test/_crm/return.html?order=ORD-1",
    );
    expect(normalizeReturnUrl("https://site.test/_crm/return.html?a=1", "ORD-1")).toBe(
      "https://site.test/_crm/return.html?a=1&order=ORD-1",
    );
    expect(normalizeReturnUrl("myapp://pay/return", "ORD-1")).toBe("myapp://pay/return?order=ORD-1");
    expect(normalizeReturnUrl("javascript:alert(1)", "ORD-1")).toBeNull();
    expect(normalizeReturnUrl("data:text/html,x", "ORD-1")).toBeNull();
    expect(normalizeReturnUrl("", "ORD-1")).toBeNull();
    expect(normalizeReturnUrl("not a url", "ORD-1")).toBeNull();
  });

  it("兜底页 URL 带 token", async () => {
    const url = await makeReturnPageUrl(env, "https://crm.test", "ORD-1", null, NOW);
    expect(url).toMatch(/^https:\/\/crm\.test\/pay\/return\/ORD-1\?t=/);
  });
});
