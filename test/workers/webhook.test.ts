/**
 * 集成测试：Stripe/PayPal webhook。
 *
 * 验签通过后只触发 `pollOrderOnce`；订单是否 paid 由查单决定，不由事件报文决定。
 */
import { beforeAll, describe, expect, it } from "vitest";

import { createCharge } from "../../src/payments/checkout";
import { handlePayNotify } from "../../src/payments/notify";
import { pollOrderOnce } from "../../src/payments/poll";
import { encryptSecret } from "../../src/payments/secret";
import { verifyStripeSignature } from "../../src/payments/drivers/stripe";
import { env } from "./apply-migrations";

import type { Plan } from "../../src/plans/model";

const NOW = new Date("2026-11-23T10:00:00Z");
const BASE = "https://crm.test";
const STRIPE_WEBHOOK_SECRET = "whsec_webhook_test";
const PAYPAL_WEBHOOK_ID = "WH-webhook-test";

function plan(): Plan {
  return {
    id: "__webhook_test__",
    name: "Webhook 测试",
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

async function seedGateway(driver: "stripe" | "paypal", webhook: string): Promise<number> {
  const secretEnc = await encryptSecret(env, driver === "stripe" ? "sk_test_webhook" : "paypal-secret");
  const webhookEnc = await encryptSecret(env, webhook);
  if (!secretEnc || !webhookEnc) throw new Error("APP_SECRET 未配置");
  const res = await env.DB.prepare(
    `INSERT INTO payment_gateways (driver, name, endpoint, merchant_id, secret_enc, webhook_enc,
       methods, mapping, priority, status, currency, allowed_emails, created_at, updated_at)
     VALUES (?, ?, NULL, ?, ?, ?, ?, NULL, 100, 'draft', 'USD', NULL, ?, ?)`,
  )
    .bind(
      driver,
      `webhook-${driver}`,
      driver === "paypal" ? "paypal-client" : null,
      secretEnc,
      webhookEnc,
      JSON.stringify([driver]),
      NOW.toISOString(),
      NOW.toISOString(),
    )
    .run();
  return Number(res.meta.last_row_id ?? 0);
}

function stripeCreateFetch(): typeof fetch {
  return (async () =>
    new Response(JSON.stringify({ id: "cs_wh_1", url: "https://checkout.stripe.test/cs_wh_1" }), {
      status: 200,
      headers: { "content-type": "application/json" },
    })) as typeof fetch;
}

function stripePaidFetch(): typeof fetch {
  return (async () =>
    new Response(
      JSON.stringify({ id: "cs_wh_1", status: "complete", payment_status: "paid", amount_total: 1500 }),
      { status: 200, headers: { "content-type": "application/json" } },
    )) as typeof fetch;
}

async function makeStripeOrder(): Promise<{ gatewayId: number; code: string }> {
  const gatewayId = await seedGateway("stripe", STRIPE_WEBHOOK_SECRET);
  const created = await createCharge(env, {
    customerId: 0,
    customerEmail: "ops@test.com",
    plan: plan(),
    method: "stripe",
    amountMinor: 1500,
    entry: "admin",
    origin: BASE,
    testGatewayId: gatewayId,
    fetch: stripeCreateFetch(),
    now: NOW,
  });
  if (!created.ok) throw new Error(created.message);
  return { gatewayId, code: created.orderCode };
}

async function stripeSignature(raw: string, secret: string, t: number): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(`${t}.${raw}`));
  const hex = [...new Uint8Array(sig)].map((b) => b.toString(16).padStart(2, "0")).join("");
  return `t=${t},v1=${hex}`;
}

function stripeWebhookRequest(gatewayId: number, code: string, header: string): Request {
  const body = JSON.stringify({
    type: "checkout.session.completed",
    data: { object: { id: "cs_wh_1", client_reference_id: code } },
  });
  return new Request(`${BASE}/api/pay/notify/${gatewayId}`, {
    method: "POST",
    headers: { "stripe-signature": header, "content-type": "application/json" },
    body,
  });
}

function paypalFetch(verifyOk: boolean): typeof fetch {
  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    if (url.endsWith("/v1/oauth2/token")) {
      return new Response(JSON.stringify({ access_token: "tok" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }
    if (url.endsWith("/v1/notify/webhooks/verify-webhook-signature")) {
      return new Response(
        JSON.stringify({ verification_status: verifyOk ? "SUCCESS" : "FAILURE" }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }
    const method = init?.method ?? "GET";
    if (url.endsWith("/v2/checkout/orders") && method === "POST") {
      return new Response(
        JSON.stringify({
          id: "O-WH-1",
          status: "CREATED",
          links: [{ rel: "approve", href: "https://paypal.test/approve/O-WH-1" }],
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }
    return new Response(
      JSON.stringify({
        id: "O-WH-1",
        status: "COMPLETED",
        purchase_units: [{ payments: { captures: [{ id: "CAP-WH-1", amount: { value: "15.00" } }] } }],
      }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
  }) as typeof fetch;
}

async function makePaypalOrder(): Promise<{ gatewayId: number; code: string }> {
  const gatewayId = await seedGateway("paypal", PAYPAL_WEBHOOK_ID);
  const created = await createCharge(env, {
    customerId: 0,
    customerEmail: "ops@test.com",
    plan: plan(),
    method: "paypal",
    amountMinor: 1500,
    entry: "admin",
    origin: BASE,
    testGatewayId: gatewayId,
    fetch: paypalFetch(true),
    now: NOW,
  });
  if (!created.ok) throw new Error(created.message);
  return { gatewayId, code: created.orderCode };
}

beforeAll(() => {
  (env as unknown as Record<string, unknown>).APP_SECRET = "webhook-test-master";
});

describe("Stripe webhook", () => {
  it("验签通过后只触发查单；paid 由查单决定", async () => {
    const { gatewayId, code } = await makeStripeOrder();
    const raw = JSON.stringify({
      type: "checkout.session.completed",
      data: { object: { id: "cs_wh_1", client_reference_id: code } },
    });
    const header = await stripeSignature(raw, STRIPE_WEBHOOK_SECRET, Math.floor(NOW.getTime() / 1000));
    const req = new Request(`${BASE}/api/pay/notify/${gatewayId}`, {
      method: "POST",
      headers: { "stripe-signature": header, "content-type": "application/json" },
      body: raw,
    });
    const res = await handlePayNotify(env, req, String(gatewayId), {
      now: NOW,
      refresh: (c) => pollOrderOnce(env, c, { fetch: stripePaidFetch(), now: NOW }),
    });
    expect(res.status).toBe(200);
    const row = await env.DB.prepare(`SELECT status FROM orders WHERE code = ?`)
      .bind(code)
      .first<{ status: string }>();
    expect(row?.status).toBe("paid");
  });

  it("网关软删除后，在途 webhook 仍能确认", async () => {
    const { gatewayId, code } = await makeStripeOrder();
    await env.DB.prepare(`UPDATE payment_gateways SET status = 'deleted' WHERE id = ?`)
      .bind(gatewayId)
      .run();

    const raw = JSON.stringify({
      type: "checkout.session.completed",
      data: { object: { id: "cs_wh_1", client_reference_id: code } },
    });
    const header = await stripeSignature(raw, STRIPE_WEBHOOK_SECRET, Math.floor(NOW.getTime() / 1000));
    const res = await handlePayNotify(
      env,
      new Request(`${BASE}/api/pay/notify/${gatewayId}`, {
        method: "POST",
        headers: { "stripe-signature": header, "content-type": "application/json" },
        body: raw,
      }),
      String(gatewayId),
      {
        now: NOW,
        refresh: (c) => pollOrderOnce(env, c, { fetch: stripePaidFetch(), now: NOW }),
      },
    );
    expect(res.status).toBe(200);
    const row = await env.DB.prepare(`SELECT status FROM orders WHERE code = ?`)
      .bind(code)
      .first<{ status: string }>();
    expect(row?.status).toBe("paid");
  });

  it("签名错误 400，订单不动", async () => {
    const { gatewayId, code } = await makeStripeOrder();
    const res = await handlePayNotify(
      env,
      stripeWebhookRequest(gatewayId, code, "t=1,v1=00"),
      String(gatewayId),
      {
        now: NOW,
        refresh: (c) => pollOrderOnce(env, c, { fetch: stripePaidFetch(), now: NOW }),
      },
    );
    expect(res.status).toBe(400);
    const row = await env.DB.prepare(`SELECT status FROM orders WHERE code = ?`)
      .bind(code)
      .first<{ status: string }>();
    expect(row?.status).toBe("pending");
  });

  it("verifyStripeSignature 对时间容差生效", async () => {
    const raw = '{"x":1}';
    const t = Math.floor(NOW.getTime() / 1000);
    const header = await stripeSignature(raw, STRIPE_WEBHOOK_SECRET, t);
    expect(await verifyStripeSignature(raw, header, STRIPE_WEBHOOK_SECRET, t)).toBe(true);
    expect(await verifyStripeSignature(raw, header, STRIPE_WEBHOOK_SECRET, t + 301)).toBe(false);
  });
});

describe("PayPal webhook", () => {
  it("verify SUCCESS → 触发查单；capture 完成落账", async () => {
    const { gatewayId, code } = await makePaypalOrder();
    const body = JSON.stringify({
      event_type: "PAYMENT.CAPTURE.COMPLETED",
      resource: {
        id: "CAP-WH-1",
        // capture 事件没有 custom_id，只能靠 related order id 找回下单时的 O-...
        supplementary_data: { related_ids: { order_id: "O-WH-1" } },
      },
    });
    const req = new Request(`${BASE}/api/pay/notify/${gatewayId}`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "paypal-transmission-id": "tid",
        "paypal-transmission-time": NOW.toISOString(),
        "paypal-cert-url": "https://paypal.test/cert",
        "paypal-auth-algo": "SHA256withRSA",
        "paypal-transmission-sig": "sig",
      },
      body,
    });
    const res = await handlePayNotify(env, req, String(gatewayId), {
      now: NOW,
      fetch: paypalFetch(true),
      refresh: (c) => pollOrderOnce(env, c, { fetch: paypalFetch(true), now: NOW }),
    });
    expect(res.status).toBe(200);
    const row = await env.DB.prepare(`SELECT status, provider_trade_no FROM orders WHERE code = ?`)
      .bind(code)
      .first<{ status: string; provider_trade_no: string }>();
    expect(row).toMatchObject({ status: "paid", provider_trade_no: "CAP-WH-1" });
  });

  it("verify FAILURE → 400，订单不动", async () => {
    const { gatewayId, code } = await makePaypalOrder();
    const body = JSON.stringify({
      event_type: "PAYMENT.CAPTURE.COMPLETED",
      resource: { id: "CAP-WH-1", custom_id: code },
    });
    const req = new Request(`${BASE}/api/pay/notify/${gatewayId}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body,
    });
    const res = await handlePayNotify(env, req, String(gatewayId), {
      now: NOW,
      fetch: paypalFetch(false),
      refresh: (c) => pollOrderOnce(env, c, { fetch: paypalFetch(false), now: NOW }),
    });
    expect(res.status).toBe(400);
    const row = await env.DB.prepare(`SELECT status FROM orders WHERE code = ?`)
      .bind(code)
      .first<{ status: string }>();
    expect(row?.status).toBe("pending");
  });
});
