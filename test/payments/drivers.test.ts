/**
 * Stripe / PayPal 薄 driver 的单测：只发 fake fetch，不碰真渠道。
 *
 * 重点不是"能发请求"，而是：
 *   - Stripe 的金额/收银台/paid 判定；
 *   - PayPal 的两阶段：APPROVED 必须 capture，COMPLETED 才算 paid，capture id 为交易号；
 *   - sandbox / live 的 base；
 *   - 错误路径不会把"未确认"误判成 paid。
 */

import { describe, expect, it } from "vitest";

import { createPaypalCharge, queryPaypalCharge } from "../../src/payments/drivers/paypal";
import { createStripeCharge, queryStripeCharge } from "../../src/payments/drivers/stripe";
import type { ChargeInput, QueryInput } from "../../src/payments/drivers/types";

import type { Env } from "../../src/env";
import type { GatewayRow } from "../../src/payments/gateways";

const ENV = { ENVIRONMENT: "development" } as unknown as Env;

function gateway(driver: string, merchantId: string | null = null): GatewayRow {
  return {
    id: 1,
    driver,
    name: driver,
    endpoint: null,
    paypal_env: null,
    merchant_id: merchantId,
    secret_enc: null,
    webhook_enc: null,
    methods: JSON.stringify([driver]),
    channel_codes: null,
    mapping: null,
    priority: 100,
    status: "live",
    currency: "USD",
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
  };
}

interface Call {
  url: string;
  init?: RequestInit;
}

function fakeFetch(handler: (url: string, init?: RequestInit) => Response | Promise<Response>): {
  fetch: typeof fetch;
  calls: Call[];
} {
  const calls: Call[] = [];
  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    calls.push({ url, init });
    return handler(url, init);
  }) as typeof fetch;
  return { fetch: fetchImpl, calls };
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function chargeInput(driver: string, fetchImpl: typeof fetch, over: Partial<ChargeInput> = {}): ChargeInput {
  return {
    gateway: gateway(driver, driver === "paypal" ? "client-id" : null),
    secret: "secret-key",
    merchantId: driver === "paypal" ? "client-id" : null,
    orderNo: "ORD-1",
    amountMinor: 1500,
    currency: "USD",
    subject: "月付 · 100GB",
    successUrl: "https://crm.test/return?order=ORD-1",
    cancelUrl: "https://crm.test/return?order=ORD-1",
    customerEmail: "buyer@test.com",
    env: ENV,
    fetch: fetchImpl,
    ...over,
  };
}

function queryInput(driver: string, fetchImpl: typeof fetch, over: Partial<QueryInput> = {}): QueryInput {
  return {
    gateway: gateway(driver, driver === "paypal" ? "client-id" : null),
    secret: "secret-key",
    merchantId: driver === "paypal" ? "client-id" : null,
    providerTradeNo: driver === "paypal" ? "O-1" : "cs_1",
    amountMinor: 1500,
    currency: "USD",
    env: ENV,
    fetch: fetchImpl,
    ...over,
  };
}

describe("Stripe driver", () => {
  it("创建 Checkout Session：金额按最小单位、收银台 URL、tradeNo=session id", async () => {
    const { fetch: fetchImpl, calls } = fakeFetch(() =>
      json({ id: "cs_1", url: "https://checkout.stripe.test/cs_1" }),
    );
    const result = await createStripeCharge(chargeInput("stripe", fetchImpl));

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.payUrl).toBe("https://checkout.stripe.test/cs_1");
    expect(result.tradeNo).toBe("cs_1");
    expect(calls).toHaveLength(1);
    const call = calls[0]!;
    expect(call.url).toBe("https://api.stripe.com/v1/checkout/sessions");
    expect((call.init?.headers as Record<string, string>).Authorization).toBe("Bearer secret-key");
    const body = call.init?.body as URLSearchParams;
    expect(body.get("mode")).toBe("payment");
    expect(body.get("line_items[0][price_data][unit_amount]")).toBe("1500");
    expect(body.get("line_items[0][price_data][currency]")).toBe("usd");
    expect(body.get("success_url")).toBe("https://crm.test/return?order=ORD-1");
    expect(body.get("client_reference_id")).toBe("ORD-1");
  });

  it("查单：payment_status=paid 才算 paid，金额取 amount_total", async () => {
    const { fetch: fetchImpl } = fakeFetch(() =>
      json({ id: "cs_1", status: "complete", payment_status: "paid", amount_total: 1500 }),
    );
    const result = await queryStripeCharge(queryInput("stripe", fetchImpl));
    expect(result.status).toBe("paid");
    if (result.status === "error") return;
    expect(result.amountMinor).toBe(1500);
    expect(result.tradeNo).toBe("cs_1");
  });

  it("查单：expired 是终态；其它是 unpaid", async () => {
    const expired = fakeFetch(() =>
      json({ id: "cs_1", status: "expired", payment_status: "unpaid" }),
    );
    const a = await queryStripeCharge(queryInput("stripe", expired.fetch));
    expect(a.status).toBe("terminal");

    const open = fakeFetch(() => json({ id: "cs_1", status: "open", payment_status: "unpaid" }));
    const b = await queryStripeCharge(queryInput("stripe", open.fetch));
    expect(b.status).toBe("unpaid");
  });

  it("创建失败返回可展示的错误，不返回假的 payUrl", async () => {
    const { fetch: fetchImpl } = fakeFetch(() => new Response("bad key", { status: 401 }));
    const result = await createStripeCharge(chargeInput("stripe", fetchImpl));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe("gateway_rejected");
    expect(result.message).toContain("401");
  });
});

describe("PayPal driver", () => {
  it("创建：OAuth2 换 token → 建 order，返回 approve 链接、tradeNo=order id", async () => {
    const { fetch: fetchImpl, calls } = fakeFetch((url) => {
      if (url.endsWith("/v1/oauth2/token")) return json({ access_token: "tok" });
      if (url.endsWith("/v2/checkout/orders")) {
        return json({
          id: "O-1",
          status: "CREATED",
          links: [
            { rel: "self", href: "https://api.paypal.test/orders/O-1" },
            { rel: "approve", href: "https://paypal.test/approve/O-1" },
          ],
        });
      }
      return new Response("not found", { status: 404 });
    });

    const result = await createPaypalCharge(chargeInput("paypal", fetchImpl));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.payUrl).toBe("https://paypal.test/approve/O-1");
    expect(result.tradeNo).toBe("O-1");
    const tokenCall = calls[0]!;
    expect(tokenCall.url).toBe("https://api-m.sandbox.paypal.com/v1/oauth2/token");
    expect((tokenCall.init?.headers as Record<string, string>).Authorization).toMatch(/^Basic /);
    const body = JSON.parse(String(calls[1]!.init?.body)) as {
      intent: string;
      purchase_units: Array<{ amount: { currency_code: string; value: string } }>;
    };
    expect(body.intent).toBe("CAPTURE");
    expect(body.purchase_units[0]!.amount).toEqual({ currency_code: "USD", value: "15.00" });
  });

  it("查单：APPROVED 必须 capture；COMPLETED 才算 paid，capture id 为 tradeNo", async () => {
    const { fetch: fetchImpl, calls } = fakeFetch((url) => {
      if (url.endsWith("/v1/oauth2/token")) return json({ access_token: "tok" });
      if (url.endsWith("/v2/checkout/orders/O-1")) return json({ id: "O-1", status: "APPROVED" });
      if (url.endsWith("/v2/checkout/orders/O-1/capture")) {
        return json({
          id: "O-1",
          status: "COMPLETED",
          purchase_units: [
            { payments: { captures: [{ id: "CAP-1", amount: { value: "15.00" } }] } },
          ],
        });
      }
      return new Response("not found", { status: 404 });
    });

    const result = await queryPaypalCharge(queryInput("paypal", fetchImpl));
    expect(result.status).toBe("paid");
    if (result.status === "error") return;
    expect(result.tradeNo).toBe("CAP-1");
    expect(result.amountMinor).toBe(1500);
    expect(calls.map((c) => c.url)).toContain(
      "https://api-m.sandbox.paypal.com/v2/checkout/orders/O-1/capture",
    );
  });

  it("查单：VOIDED 是终态；ALREADY_CAPTURED 回查后算 paid", async () => {
    const voided = fakeFetch((url) => {
      if (url.endsWith("/v1/oauth2/token")) return json({ access_token: "tok" });
      return json({ id: "O-1", status: "VOIDED" });
    });
    const a = await queryPaypalCharge(queryInput("paypal", voided.fetch));
    expect(a.status).toBe("terminal");

    let orderCalls = 0;
    const already = fakeFetch((url) => {
      if (url.endsWith("/v1/oauth2/token")) return json({ access_token: "tok" });
      if (url.endsWith("/capture")) return new Response("ALREADY_CAPTURED", { status: 422 });
      orderCalls += 1;
      return json({
        id: "O-1",
        // 第一次 APPROVED → 触发 capture；ALREADY_CAPTURED 回查时才是 COMPLETED
        status: orderCalls === 1 ? "APPROVED" : "COMPLETED",
        purchase_units:
          orderCalls === 1
            ? [{ amount: { value: "15.00" } }]
            : [{ payments: { captures: [{ id: "CAP-1", amount: { value: "15.00" } }] } }],
      });
    });
    const b = await queryPaypalCharge(queryInput("paypal", already.fetch));
    expect(b.status).toBe("paid");
    if (b.status === "error") return;
    expect(b.tradeNo).toBe("CAP-1");
    expect(orderCalls).toBeGreaterThanOrEqual(2);
  });

  it("capture 网络失败不误判 paid，留给下一轮", async () => {
    const { fetch: fetchImpl } = fakeFetch((url) => {
      if (url.endsWith("/v1/oauth2/token")) return json({ access_token: "tok" });
      if (url.endsWith("/capture")) return new Response("server down", { status: 500 });
      return json({
        id: "O-1",
        status: "APPROVED",
        purchase_units: [{ amount: { value: "15.00" } }],
      });
    });
    const result = await queryPaypalCharge(queryInput("paypal", fetchImpl));
    expect(result.status).toBe("unpaid");
    if (result.status === "error") return;
    expect(result.amountMinor).toBe(1500);
  });

  it("网关级 PayPal 环境优先于部署 ENVIRONMENT", async () => {
    const sandbox = gateway("paypal", "client-id");
    sandbox.paypal_env = "sandbox";
    const sandboxCalls = fakeFetch((url) => {
      if (url.endsWith("/v1/oauth2/token")) return json({ access_token: "tok" });
      return json({ id: "O-1", status: "CREATED", links: [{ rel: "approve", href: "https://paypal.test/x" }] });
    });
    await createPaypalCharge(
      chargeInput("paypal", sandboxCalls.fetch, {
        gateway: sandbox,
        env: { ENVIRONMENT: "production" } as unknown as Env,
      }),
    );
    expect(sandboxCalls.calls[0]!.url).toBe("https://api-m.sandbox.paypal.com/v1/oauth2/token");

    const live = gateway("paypal", "client-id");
    live.paypal_env = "live";
    const liveCalls = fakeFetch((url) => {
      if (url.endsWith("/v1/oauth2/token")) return json({ access_token: "tok" });
      return json({ id: "O-1", status: "CREATED", links: [{ rel: "approve", href: "https://paypal.test/x" }] });
    });
    await createPaypalCharge(
      chargeInput("paypal", liveCalls.fetch, {
        gateway: live,
        env: { ENVIRONMENT: "development" } as unknown as Env,
      }),
    );
    expect(liveCalls.calls[0]!.url).toBe("https://api-m.paypal.com/v1/oauth2/token");
  });

  it("生产环境用 live base", async () => {
    const { fetch: fetchImpl, calls } = fakeFetch((url) => {
      if (url.endsWith("/v1/oauth2/token")) return json({ access_token: "tok" });
      return json({ id: "O-1", status: "CREATED", links: [{ rel: "approve", href: "https://paypal.test/x" }] });
    });
    await createPaypalCharge(
      chargeInput("paypal", fetchImpl, { env: { ENVIRONMENT: "production" } as unknown as Env }),
    );
    expect(calls[0]!.url).toBe("https://api-m.paypal.com/v1/oauth2/token");
  });
});
