/**
 * 集成测试：测试网关（mock）的完整链路
 *
 * 真 D1、真路由、真签名：
 *   下单 → 演示页 → 点「模拟支付成功」 → 回调（验签+金额核对） → 订单 active + 订阅生效
 *
 * 这条链路的价值：后面接真实网关时，**除了驱动之外的所有环节都已经验证过**。
 */
import { exports as rawExports } from "cloudflare:workers";
import { beforeAll, describe, expect, it } from "vitest";

import { sha256Hex } from "../../src/admin/crypto";
import { env } from "./apply-migrations";

const BASE = "https://crm.test";
const PAYER = "payer@test.com";
const OTHER = "stranger@test.com";
const TOKEN = "test-session-token-payer";

const worker = rawExports as unknown as {
  default: { fetch(request: Request): Promise<Response> };
};

const now = () => new Date().toISOString();

function call(path: string, init: { method?: string; body?: unknown; token?: string } = {}) {
  const headers: Record<string, string> = {};
  if (init.body !== undefined) headers["content-type"] = "application/json";
  if (init.token) headers.authorization = `Bearer ${init.token}`;
  return worker.default.fetch(
    new Request(`${BASE}${path}`, {
      method: init.method ?? "GET",
      headers,
      body: init.body === undefined ? undefined : JSON.stringify(init.body),
    }),
  );
}

async function seedCustomer(email: string, token: string): Promise<number> {
  const res = await env.DB.prepare(
    `INSERT INTO customers (email, status, created_at) VALUES (?, 'active', ?)`,
  )
    .bind(email, now())
    .run();
  const id = Number(res.meta.last_row_id ?? 0);
  await env.DB.prepare(
    `INSERT INTO app_sessions (id, customer_id, created_at, last_used_at) VALUES (?, ?, ?, ?)`,
  )
    .bind(await sha256Hex(token), id, now(), now())
    .run();
  return id;
}

beforeAll(async () => {
  // 第一道闸门：打开 mock
  (env as unknown as Record<string, unknown>).ALLOW_MOCK_PAYMENTS = "true";

  await env.DB.batch([
    env.DB.prepare(
      `INSERT INTO payment_gateways (driver, name, endpoint, merchant_id, secret_enc, methods,
         mapping, priority, status, currency, allowed_emails, created_at, updated_at)
       VALUES ('mock', '测试网关（演示）', NULL, 'MOCK-M1', NULL, '["alipay","wechat"]',
         NULL, 999, 'live', 'CNY', ?, ?, ?)`,
    ).bind(JSON.stringify([PAYER]), now(), now()),
    env.DB.prepare(
      `INSERT INTO plans (id, name, kind, price_minor, currency, licence_limit, term_days,
         monthly_quota_gb, traffic_gb, validity_days, allow_addons, line_ids, sales_channels,
         store_product_id, sort_order, status, visibility, created_at, updated_at)
       VALUES ('pay_plan_30d', '月付 · 测试', 'period', 1500, 'CNY', 1, 30, 100, NULL, NULL, 0,
         '[]', '[{"channel":"web_checkout","methods":["alipay"]}]', '{}', 1, 'active', 'public', ?, ?)`,
    ).bind(now(), now()),
  ]);

  await seedCustomer(PAYER, TOKEN);
  await seedCustomer(OTHER, "test-session-token-other");
});

describe("支付方式列表受白名单约束", () => {
  it("白名单内的客户能看到 alipay/wechat", async () => {
    const res = await call("/api/app/v1/payment-methods", { token: TOKEN });
    expect(res.status).toBe(200);
    const items = (await res.json()) as { method: string; label: string }[];
    expect(items.map((i) => i.method).sort()).toEqual(["alipay", "wechat"]);
    expect(items.find((i) => i.method === "alipay")?.label).toBe("支付宝");
  });

  it("白名单外的客户看不到（否则等于免费开通）", async () => {
    const res = await call("/api/app/v1/payment-methods", { token: "test-session-token-other" });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual([]);
  });

  it("未登录也看不到", async () => {
    const res = await call("/api/app/v1/payment-methods");
    expect(await res.json()).toEqual([]);
  });
});

describe("mock 支付全链路", () => {
  it("下单 → 演示页 → 模拟支付 → 订阅生效", async () => {
    // 1. 下单
    const created = await call("/api/app/v1/orders", {
      method: "POST",
      token: TOKEN,
      body: { plan_id: "pay_plan_30d", payment_method: "alipay" },
    });
    expect(created.status).toBe(201);
    const order = (await created.json()) as {
      order_code: string;
      pay_url: string;
      amount_minor: number;
      reused: boolean;
    };
    expect(order.amount_minor).toBe(1500);
    expect(order.reused).toBe(false);
    expect(order.pay_url).toContain("/pay/mock/");

    // 2. 演示页
    const page = await worker.default.fetch(new Request(order.pay_url));
    expect(page.status).toBe(200);
    const html = await page.text();
    expect(html).toContain("演示模式");
    expect(html).toContain("支付宝");

    // 3. 模拟支付成功（服务端自己构造带签名的回调）
    const paid = await worker.default.fetch(
      new Request(`${order.pay_url}/paid`, { method: "POST" }),
    );
    expect(paid.status).toBe(200);
    expect(await paid.text()).toContain("已模拟支付成功");

    // 4. 订单与订阅
    const row = await env.DB.prepare(`SELECT status, subscription_id, paid_at FROM orders WHERE code = ?`)
      .bind(order.order_code)
      .first<{ status: string; subscription_id: number | null; paid_at: string | null }>();
    expect(row?.status).toBe("active");
    expect(row?.paid_at).toBeTruthy();
    expect(row?.subscription_id).toBeGreaterThan(0);

    const sub = await env.DB.prepare(
      `SELECT plan_id, status, paid_minor FROM platform_subscriptions WHERE id = ?`,
    )
      .bind(row?.subscription_id ?? 0)
      .first<{ plan_id: string; status: string; paid_minor: number }>();
    expect(sub).toMatchObject({ plan_id: "pay_plan_30d", status: "active", paid_minor: 1500 });
  });

  it("重复点「模拟支付」不会重复发货", async () => {
    const created = await call("/api/app/v1/orders", {
      method: "POST",
      token: TOKEN,
      body: { plan_id: "pay_plan_30d", payment_method: "wechat" },
    });
    const order = (await created.json()) as { order_code: string; pay_url: string };

    const before = await env.DB.prepare(
      `SELECT COUNT(*) AS n FROM platform_subscriptions WHERE plan_id = 'pay_plan_30d'`,
    ).first<{ n: number }>();

    await worker.default.fetch(new Request(`${order.pay_url}/paid`, { method: "POST" }));
    const second = await worker.default.fetch(new Request(`${order.pay_url}/paid`, { method: "POST" }));
    expect(second.status).toBe(200); // 已处理过，页面只是提示

    const after = await env.DB.prepare(
      `SELECT COUNT(*) AS n FROM platform_subscriptions WHERE plan_id = 'pay_plan_30d'`,
    ).first<{ n: number }>();
    expect(after?.n).toBe((before?.n ?? 0) + 1); // 只多一条
  });

  it("60 秒内重复下单复用同一张单（防双击）", async () => {
    const a = await call("/api/app/v1/orders", {
      method: "POST",
      token: TOKEN,
      body: { plan_id: "pay_plan_30d", payment_method: "alipay" },
    });
    const b = await call("/api/app/v1/orders", {
      method: "POST",
      token: TOKEN,
      body: { plan_id: "pay_plan_30d", payment_method: "alipay" },
    });
    const oa = (await a.json()) as { order_code: string };
    const ob = (await b.json()) as { order_code: string; reused: boolean };
    expect(ob.reused).toBe(true);
    expect(ob.order_code).toBe(oa.order_code);
  });

  it("白名单外的客户下单被拒（路由闸门）", async () => {
    const res = await call("/api/app/v1/orders", {
      method: "POST",
      token: "test-session-token-other",
      body: { plan_id: "pay_plan_30d", payment_method: "alipay" },
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("payment_method_unavailable");
  });

  it("回调签名被改 → 403，且订单不变", async () => {
    const created = await call("/api/app/v1/orders", {
      method: "POST",
      token: TOKEN,
      body: { plan_id: "pay_plan_30d", payment_method: "alipay" },
    });
    const order = (await created.json()) as { order_code: string };

    const gw = await env.DB.prepare(`SELECT id FROM payment_gateways WHERE driver = 'mock'`)
      .first<{ id: number }>();
    const forged = new URLSearchParams({
      mch: "MOCK-M1",
      out_trade_no: order.order_code,
      amount: "1",
      status: "SUCCESS",
      sign: "deadbeef",
    });
    const res = await worker.default.fetch(
      new Request(`${BASE}/api/pay/notify/${gw?.id}`, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: forged.toString(),
      }),
    );
    expect(res.status).toBe(403);

    const row = await env.DB.prepare(`SELECT status FROM orders WHERE code = ?`)
      .bind(order.order_code)
      .first<{ status: string }>();
    expect(row?.status).toBe("pending");
  });
});
