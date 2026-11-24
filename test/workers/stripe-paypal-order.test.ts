/**
 * 集成测试：Stripe / PayPal 的 createCharge 分支。
 *
 * 不碰真渠道：driver 的 fetch 可注入，这里只验证
 *   路由选中 → 调 driver → 落 orders（pay_url / provider_trade_no / raw_create）。
 */

import { beforeAll, describe, expect, it } from "vitest";

import { createCharge } from "../../src/payments/checkout";
import { pollOrderOnce } from "../../src/payments/poll";
import { encryptSecret } from "../../src/payments/secret";
import { env } from "./apply-migrations";

import type { Plan } from "../../src/plans/model";

const NOW = new Date("2026-11-23T10:00:00Z");

function plan(): Plan {
  return {
    id: "__stripe_paypal_test__",
    name: "测试套餐",
    kind: "period",
    price_minor: 1500,
    currency: "USD",
    licence_limit: 1,
    term_days: 30,
    monthly_quota_gb: 100,
    traffic_gb: null,
    validity_days: null,
    line_ids: [],
    up_mbps: null,
    down_mbps: null,
    sales_channels: [{ channel: "web_checkout", methods: ["stripe", "paypal"] }],
    store_product_id: {},
    sort_order: 0,
    status: "active",
    visibility: "public",
    retired_at: null,
    trial: false,
  };
}

async function seedGateway(driver: "stripe" | "paypal"): Promise<number> {
  const secretEnc = await encryptSecret(env, driver === "stripe" ? "sk_test_123" : "paypal-secret");
  if (!secretEnc) throw new Error("APP_SECRET 未配置，无法 seed 测试网关");
  const res = await env.DB.prepare(
    `INSERT INTO payment_gateways (driver, name, endpoint, merchant_id, secret_enc, methods,
       mapping, priority, status, currency, allowed_emails, created_at, updated_at)
     VALUES (?, ?, NULL, ?, ?, ?, NULL, 100, 'draft', 'USD', NULL, ?, ?)`,
  )
    .bind(
      driver,
      `测试-${driver}`,
      driver === "paypal" ? "client-id" : null,
      secretEnc,
      JSON.stringify([driver]),
      NOW.toISOString(),
      NOW.toISOString(),
    )
    .run();
  return Number(res.meta.last_row_id ?? 0);
}

let lastStripeBody = "";

function fakeStripe(): typeof fetch {
  return (async (_input: RequestInfo | URL, init?: RequestInit) => {
    lastStripeBody = String(init?.body ?? "");
    return new Response(
      JSON.stringify({ id: "cs_test_1", url: "https://checkout.stripe.test/cs_test_1" }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
  }) as typeof fetch;
}

function fakePaypal(): typeof fetch {
  return (async (input: RequestInfo | URL) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    if (url.endsWith("/v1/oauth2/token")) {
      return new Response(JSON.stringify({ access_token: "tok" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }
    return new Response(
      JSON.stringify({
        id: "O-TEST-1",
        status: "CREATED",
        links: [{ rel: "approve", href: "https://paypal.test/approve/O-TEST-1" }],
      }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
  }) as typeof fetch;
}

beforeAll(() => {
  (env as unknown as Record<string, unknown>).APP_SECRET = "stripe-paypal-test-master";
});

describe("createCharge：Stripe / PayPal", () => {
  it("Stripe：返回 pay_url，订单落 session id", async () => {
    const gatewayId = await seedGateway("stripe");
    const res = await createCharge(env, {
      customerId: 0,
      customerEmail: "ops@test.com",
      plan: plan(),
      method: "stripe",
      amountMinor: 1500,
      entry: "admin",
      origin: "https://crm.test",
      testGatewayId: gatewayId,
      fetch: fakeStripe(),
      now: NOW,
    });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.payUrl).toBe("https://checkout.stripe.test/cs_test_1");
    const successUrl = new URLSearchParams(lastStripeBody).get("success_url") ?? "";
    expect(successUrl).toContain("https://crm.test/pay/return/");
    expect(successUrl).toContain("t=");

    const row = await env.DB.prepare(
      `SELECT provider_trade_no, raw_create, payment_method, source FROM orders WHERE code = ?`,
    )
      .bind(res.orderCode)
      .first<{ provider_trade_no: string; raw_create: string; payment_method: string; source: string }>();
    expect(row).toMatchObject({
      provider_trade_no: "cs_test_1",
      payment_method: "stripe",
      source: "test",
    });
    expect(row?.raw_create).toContain("cs_test_1");
  });

  it("客户端给了 http(s) return_url：success_url 直接回客户端并带 crm_pay_token", async () => {
    const gatewayId = await seedGateway("stripe");
    const res = await createCharge(env, {
      customerId: 0,
      customerEmail: "ops@test.com",
      plan: plan(),
      method: "stripe",
      amountMinor: 1500,
      entry: "admin",
      origin: "https://crm.test",
      returnUrl: "https://site.test/_crm/return.html",
      testGatewayId: gatewayId,
      fetch: fakeStripe(),
      now: NOW,
    });
    expect(res.ok).toBe(true);
    const successUrl = new URLSearchParams(lastStripeBody).get("success_url") ?? "";
    expect(successUrl).toContain("https://site.test/_crm/return.html");
    expect(successUrl).toContain("crm_pay_token=");
    const cancelUrl = new URLSearchParams(lastStripeBody).get("cancel_url") ?? "";
    expect(cancelUrl).toContain("crm_pay_cancel=1");
  });

  it("自定义 scheme：provider 回 CRM 兜底页，不把 myapp:// 当 success_url", async () => {
    const gatewayId = await seedGateway("stripe");
    const res = await createCharge(env, {
      customerId: 0,
      customerEmail: "ops@test.com",
      plan: plan(),
      method: "stripe",
      amountMinor: 1500,
      entry: "admin",
      origin: "https://crm.test",
      returnUrl: "myapp://pay/return",
      testGatewayId: gatewayId,
      fetch: fakeStripe(),
      now: NOW,
    });
    expect(res.ok).toBe(true);
    const successUrl = new URLSearchParams(lastStripeBody).get("success_url") ?? "";
    expect(successUrl).toContain("https://crm.test/pay/return/");
    expect(successUrl).not.toContain("myapp");
  });

  it("Stripe 查单：paid 落账（测试单只记钱、不发权益）", async () => {
    const gatewayId = await seedGateway("stripe");
    const created = await createCharge(env, {
      customerId: 0,
      customerEmail: "ops@test.com",
      plan: plan(),
      method: "stripe",
      amountMinor: 1500,
      entry: "admin",
      origin: "https://crm.test",
      testGatewayId: gatewayId,
      fetch: fakeStripe(),
      now: NOW,
    });
    if (!created.ok) throw new Error(created.message);

    const queryFetch = (async () =>
      new Response(
        JSON.stringify({ id: "cs_test_1", status: "complete", payment_status: "paid", amount_total: 1500 }),
        { status: 200, headers: { "content-type": "application/json" } },
      )) as typeof fetch;
    const out = await pollOrderOnce(env, created.orderCode, { fetch: queryFetch, now: NOW });
    expect(out).toEqual({ status: "paid", verdict: "paid" });

    const row = await env.DB.prepare(`SELECT status, provider_trade_no FROM orders WHERE code = ?`)
      .bind(created.orderCode)
      .first<{ status: string; provider_trade_no: string }>();
    expect(row).toMatchObject({ status: "paid", provider_trade_no: "cs_test_1" });
  });

  it("Stripe 查单：金额不符不认账", async () => {
    const gatewayId = await seedGateway("stripe");
    const created = await createCharge(env, {
      customerId: 0,
      customerEmail: "ops@test.com",
      plan: plan(),
      method: "stripe",
      amountMinor: 1500,
      entry: "admin",
      origin: "https://crm.test",
      testGatewayId: gatewayId,
      fetch: fakeStripe(),
      now: NOW,
    });
    if (!created.ok) throw new Error(created.message);

    const queryFetch = (async () =>
      new Response(
        JSON.stringify({ id: "cs_test_1", status: "complete", payment_status: "paid", amount_total: 999 }),
        { status: 200, headers: { "content-type": "application/json" } },
      )) as typeof fetch;
    const out = await pollOrderOnce(env, created.orderCode, { fetch: queryFetch, now: NOW });
    expect(out?.verdict).toBe("error");

    const row = await env.DB.prepare(`SELECT status FROM orders WHERE code = ?`)
      .bind(created.orderCode)
      .first<{ status: string }>();
    expect(row?.status).toBe("pending");
  });

  it("PayPal：返回 approve 链接，订单落 order id", async () => {
    const gatewayId = await seedGateway("paypal");
    const res = await createCharge(env, {
      customerId: 0,
      customerEmail: "ops@test.com",
      plan: plan(),
      method: "paypal",
      amountMinor: 1500,
      entry: "admin",
      origin: "https://crm.test",
      testGatewayId: gatewayId,
      fetch: fakePaypal(),
      now: NOW,
    });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.payUrl).toBe("https://paypal.test/approve/O-TEST-1");

    const row = await env.DB.prepare(
      `SELECT provider_trade_no, raw_create, payment_method FROM orders WHERE code = ?`,
    )
      .bind(res.orderCode)
      .first<{ provider_trade_no: string; raw_create: string; payment_method: string }>();
    expect(row).toMatchObject({ provider_trade_no: "O-TEST-1", payment_method: "paypal" });
    expect(row?.raw_create).toContain("O-TEST-1");
  });

  it("PayPal 查单：APPROVED → capture → paid，交易号换成 capture id", async () => {
    const gatewayId = await seedGateway("paypal");
    const created = await createCharge(env, {
      customerId: 0,
      customerEmail: "ops@test.com",
      plan: plan(),
      method: "paypal",
      amountMinor: 1500,
      entry: "admin",
      origin: "https://crm.test",
      testGatewayId: gatewayId,
      fetch: fakePaypal(),
      now: NOW,
    });
    if (!created.ok) throw new Error(created.message);

    const queryFetch = (async (input: RequestInfo | URL) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      if (url.endsWith("/v1/oauth2/token")) {
        return new Response(JSON.stringify({ access_token: "tok" }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      if (url.endsWith("/capture")) {
        return new Response(
          JSON.stringify({
            id: "O-TEST-1",
            status: "COMPLETED",
            purchase_units: [{ payments: { captures: [{ id: "CAP-TEST-1", amount: { value: "15.00" } }] } }],
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }
      return new Response(
        JSON.stringify({ id: "O-TEST-1", status: "APPROVED", purchase_units: [{ amount: { value: "15.00" } }] }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }) as typeof fetch;

    const out = await pollOrderOnce(env, created.orderCode, { fetch: queryFetch, now: NOW });
    expect(out).toEqual({ status: "paid", verdict: "paid" });

    const row = await env.DB.prepare(`SELECT status, provider_trade_no FROM orders WHERE code = ?`)
      .bind(created.orderCode)
      .first<{ status: string; provider_trade_no: string }>();
    expect(row).toMatchObject({ status: "paid", provider_trade_no: "CAP-TEST-1" });
  });
});
