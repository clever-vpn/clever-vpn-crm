/**
 * 集成测试：支付回跳 refresh / 兜底页。
 *
 * 关键点：
 *   - 只有带 token 的请求能查单；无效 token 404；
 *   - 已付不查网关；pending 抢 10 秒冷却后只查一次；
 *   - 客户端 http(s) 回跳走 refresh；自定义 scheme 走 CRM 兜底页按钮；
 *   - cancel 不查单。
 */
import { beforeAll, describe, expect, it } from "vitest";

import { createCharge } from "../../src/payments/checkout";
import { handleReturnPage, handleReturnRefresh } from "../../src/payments/return";
import { makeReturnToken } from "../../src/payments/return-token";
import { encryptSecret } from "../../src/payments/secret";
import { env } from "./apply-migrations";

import type { Plan } from "../../src/plans/model";

const NOW = new Date("2026-11-23T10:00:00Z");
const BASE = "https://crm.test";

function plan(): Plan {
  return {
    id: "__return_test__",
    name: "回跳测试",
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
    sales_channels: [{ channel: "web_checkout", methods: ["stripe"] }],
    store_product_id: {},
    sort_order: 0,
    status: "active",
    visibility: "public",
    retired_at: null,
    trial: false,
  };
}

async function seedStripe(): Promise<number> {
  const secretEnc = await encryptSecret(env, "sk_test_return");
  if (!secretEnc) throw new Error("APP_SECRET 未配置");
  const res = await env.DB.prepare(
    `INSERT INTO payment_gateways (driver, name, endpoint, merchant_id, secret_enc, methods,
       mapping, priority, status, currency, allowed_emails, created_at, updated_at)
     VALUES ('stripe', '回跳测试网关', NULL, NULL, ?, ?, NULL, 100, 'draft', 'USD', NULL, ?, ?)`,
  )
    .bind(secretEnc, JSON.stringify(["stripe"]), NOW.toISOString(), NOW.toISOString())
    .run();
  return Number(res.meta.last_row_id ?? 0);
}

function createFetch(): typeof fetch {
  return (async () =>
    new Response(JSON.stringify({ id: "cs_return_1", url: "https://checkout.stripe.test/cs_return_1" }), {
      status: 200,
      headers: { "content-type": "application/json" },
    })) as typeof fetch;
}

function paidFetch(): typeof fetch {
  return (async () =>
    new Response(
      JSON.stringify({
        id: "cs_return_1",
        status: "complete",
        payment_status: "paid",
        amount_total: 1500,
      }),
      { status: 200, headers: { "content-type": "application/json" } },
    )) as typeof fetch;
}

function pendingFetch(counter: { n: number }): typeof fetch {
  return (async () => {
    counter.n += 1;
    return new Response(
      JSON.stringify({ id: "cs_return_1", status: "open", payment_status: "unpaid", amount_total: 1500 }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
  }) as typeof fetch;
}

async function makeOrder(): Promise<{ gatewayId: number; code: string }> {
  const gatewayId = await seedStripe();
  const created = await createCharge(env, {
    customerId: 0,
    customerEmail: "ops@test.com",
    plan: plan(),
    method: "stripe",
    amountMinor: 1500,
    entry: "admin",
    origin: BASE,
    returnUrl: "https://site.test/_crm/return.html",
    testGatewayId: gatewayId,
    fetch: createFetch(),
    now: NOW,
  });
  if (!created.ok) throw new Error(created.message);
  return { gatewayId, code: created.orderCode };
}

function tokenFor(code: string, to: string | null): Promise<string | null> {
  return makeReturnToken(env, code, to, NOW);
}

beforeAll(() => {
  (env as unknown as Record<string, unknown>).APP_SECRET = "return-page-test-master";
});

describe("回跳 refresh", () => {
  it("有效 token 触发一次查单，paid 落账", async () => {
    const { code } = await makeOrder();
    const token = await tokenFor(code, null);
    const res = await handleReturnRefresh(
      new Request(`${BASE}/api/pay/return/${code}/refresh?t=${encodeURIComponent(token!)}`, {
        method: "POST",
      }),
      env,
      code,
      { fetch: paidFetch(), now: NOW },
    );
    expect(res.status).toBe(200);
    expect(res.headers.get("access-control-allow-origin")).toBe("*");
    expect(await res.json()).toMatchObject({ pay: "paid", order_code: code });

    const row = await env.DB.prepare(`SELECT status FROM orders WHERE code = ?`)
      .bind(code)
      .first<{ status: string }>();
    expect(row?.status).toBe("paid");
  });

  it("pending 的 10 秒冷却只查一次", async () => {
    const { code } = await makeOrder();
    const token = await tokenFor(code, null);
    const counter = { n: 0 };
    const fetch = pendingFetch(counter);
    const req = () =>
      new Request(`${BASE}/api/pay/return/${code}/refresh?t=${encodeURIComponent(token!)}`, {
        method: "POST",
      });

    const first = await handleReturnRefresh(req(), env, code, { fetch, now: NOW });
    const second = await handleReturnRefresh(req(), env, code, { fetch, now: NOW });
    expect(await first.json()).toMatchObject({ pay: "pending" });
    expect(await second.json()).toMatchObject({ pay: "pending" });
    expect(counter.n).toBe(1);
  });

  it("cancel 不查网关，直接 canceled", async () => {
    const { code } = await makeOrder();
    const token = await tokenFor(code, null);
    const counter = { n: 0 };
    const res = await handleReturnRefresh(
      new Request(`${BASE}/api/pay/return/${code}/refresh?t=${encodeURIComponent(token!)}&cancel=1`, {
        method: "POST",
      }),
      env,
      code,
      { fetch: pendingFetch(counter), now: NOW },
    );
    expect(await res.json()).toMatchObject({ pay: "canceled" });
    expect(counter.n).toBe(0);
  });

  it("无效 token 404", async () => {
    const { code } = await makeOrder();
    const res = await handleReturnRefresh(
      new Request(`${BASE}/api/pay/return/${code}/refresh?t=bad`, { method: "POST" }),
      env,
      code,
      { fetch: paidFetch(), now: NOW },
    );
    expect(res.status).toBe(404);
  });
});

describe("CRM 兜底页", () => {
  it("http 最终地址：meta refresh + pay=paid", async () => {
    const { code } = await makeOrder();
    const token = await tokenFor(code, "https://site.test/_crm/return.html");
    const res = await handleReturnPage(
      new Request(`${BASE}/pay/return/${code}?t=${encodeURIComponent(token!)}`),
      env,
      code,
      { fetch: paidFetch(), now: NOW },
    );
    const html = await res.text();
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(html).toContain("支付成功");
    expect(html).toContain('http-equiv="refresh"');
    expect(html).toContain("pay=paid");
  });

  it("自定义 scheme：不自动跳，显示返回 App 按钮", async () => {
    const { code } = await makeOrder();
    const token = await tokenFor(code, "myapp://pay/return");
    const res = await handleReturnPage(
      new Request(`${BASE}/pay/return/${code}?t=${encodeURIComponent(token!)}`),
      env,
      code,
      { fetch: paidFetch(), now: NOW },
    );
    const html = await res.text();
    expect(html).toContain("返回 App");
    expect(html).not.toContain('http-equiv="refresh"');
    expect(html).toContain("myapp://pay/return?order=");
  });

  it("无效 token 404", async () => {
    const { code } = await makeOrder();
    const res = await handleReturnPage(new Request(`${BASE}/pay/return/${code}?t=bad`), env, code);
    expect(res.status).toBe(404);
  });
});
