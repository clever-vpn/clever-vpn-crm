/**
 * 续订 / 加量包落账时**写哪些字段**（`platform/provision.ts` 的 `patchParams`）。
 *
 * 钉住的是三件会直接让用户"白得流量"或"凭空少流量"的事：
 *   1. period 续订只延到期日，平台余额一个字都不许动（动了 = 把本周期已用的还回去）；
 *   2. 加量包的余额 = **平台真实剩余 + gb**，不是"周期满额 + gb"；
 *   3. traffic 续订的基数是回源后的剩余，不是 15 分钟前的缓存。
 */
import { exports as rawExports } from "cloudflare:workers";
import { beforeAll, describe, expect, it } from "vitest";

import { sha256Hex } from "../../src/admin/crypto";
import { env } from "./apply-migrations";
import { installFakeCfApi, seedPlatformCreds } from "./fake-cf-api";

import type { FakeCfApi } from "./fake-cf-api";

const BASE = "https://crm.test";
const GIGA = 1024 ** 3;

const PERIOD_EMAIL = "renew-period@test.com";
const PERIOD_TOKEN = "token-renew-period";
const TRAFFIC_EMAIL = "renew-traffic@test.com";
const TRAFFIC_TOKEN = "token-renew-traffic";

const worker = rawExports as unknown as {
  default: { fetch(request: Request): Promise<Response> };
};

const now = () => new Date().toISOString();

let cf: FakeCfApi;

interface SubRow {
  id: number;
  platform_customer_id: number | null;
  activation_code: string | null;
  period_extra_gb: number | null;
  traffic_remaining_gb: number | null;
  traffic_total_gb: number | null;
  expires_at: string | null;
}

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
    `INSERT INTO customers (uuid, email, status, created_at)
     VALUES (lower(hex(randomblob(16))), ?, 'active', ?)`,
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

/** 下单 → 模拟支付成功（走 mock 网关的 `/paid`，与真实链路同一条回调） */
async function buy(planId: string, token: string): Promise<{ orderCode: string }> {
  const created = await call("/api/app/v1/orders", {
    method: "POST",
    token,
    body: { plan_id: planId, payment_method: "alipay" },
  });
  expect(created.status).toBe(201);
  const order = (await created.json()) as { order_code: string; pay_url: string };
  const paid = await worker.default.fetch(
    new Request(`${order.pay_url}/paid`, { method: "POST" }),
  );
  expect(paid.status).toBe(200);
  return { orderCode: order.order_code };
}

function readSub(customerId: number) {
  return env.DB.prepare(`SELECT * FROM platform_subscriptions WHERE customer_id = ?`)
    .bind(customerId)
    .first<SubRow>();
}

function lastAction(orderCode: string) {
  return env.DB.prepare(`SELECT provision_action FROM orders WHERE code = ?`)
    .bind(orderCode)
    .first<{ provision_action: string | null }>();
}

beforeAll(async () => {
  const fake = installFakeCfApi();
  cf = fake;
  await seedPlatformCreds(env.DB, fake);

  await env.DB.batch([
    env.DB.prepare(
      `INSERT INTO payment_gateways (driver, name, endpoint, merchant_id, secret_enc, methods,
         mapping, priority, status, currency, allowed_emails, created_at, updated_at)
       VALUES ('mock', '测试网关（演示）', NULL, 'MOCK-M1', NULL, '["alipay"]',
         NULL, 999, 'live', 'CNY', ?, ?, ?)`,
    ).bind(JSON.stringify([PERIOD_EMAIL, TRAFFIC_EMAIL]), now(), now()),
    env.DB.prepare(
      `INSERT INTO plans (id, name, kind, price_minor, currency, licence_limit, term_days,
         monthly_quota_gb, traffic_gb, validity_days, line_ids, sales_channels,
         store_product_id, sort_order, status, visibility, created_at, updated_at)
       VALUES ('p_period_100g', '月付 · 100GB', 'period', 1500, 'CNY', 1, 30, 100, NULL, NULL,
         '[]', '[{"channel":"web_checkout","methods":["alipay"]}]', '{}', 1, 'active', 'public', ?, ?)`,
    ).bind(now(), now()),
    env.DB.prepare(
      `INSERT INTO plans (id, name, kind, price_minor, currency, licence_limit, term_days,
         monthly_quota_gb, traffic_gb, validity_days, line_ids, sales_channels,
         store_product_id, sort_order, status, visibility, created_at, updated_at)
       VALUES ('p_addon_50g', '加量包 · 50GB', 'addon', 500, 'CNY', 1, NULL, NULL, 50, NULL,
         '[]', '[{"channel":"web_checkout","methods":["alipay"]}]', '{}', 2, 'active', 'public', ?, ?)`,
    ).bind(now(), now()),
    env.DB.prepare(
      `INSERT INTO plans (id, name, kind, price_minor, currency, licence_limit, term_days,
         monthly_quota_gb, traffic_gb, validity_days, line_ids, sales_channels,
         store_product_id, sort_order, status, visibility, created_at, updated_at)
       VALUES ('p_traffic_50g', '流量包 · 50GB', 'traffic', 2000, 'CNY', 1, NULL, NULL, 50, 30,
         '[]', '[{"channel":"web_checkout","methods":["alipay"]}]', '{}', 3, 'active', 'public', ?, ?)`,
    ).bind(now(), now()),
  ]);

  await seedCustomer(PERIOD_EMAIL, PERIOD_TOKEN);
  await seedCustomer(TRAFFIC_EMAIL, TRAFFIC_TOKEN);
});

describe("period 续订：只延到期日，平台余额不动", () => {
  it("续订前后平台余额保持「真实剩余」，落账只发 expire_date", async () => {
    const customerId = (await env.DB.prepare(`SELECT id FROM customers WHERE email = ?`)
      .bind(PERIOD_EMAIL)
      .first<{ id: number }>())!.id;

    await buy("p_period_100g", PERIOD_TOKEN);
    const first = (await readSub(customerId))!;
    const platformId = first.platform_customer_id!;
    expect(platformId).toBeGreaterThan(0);
    // 刚开通：平台余额 = 满额 P+B
    expect(cf.customers.get(platformId)!.traffic_balance).toBe(100 * GIGA);

    // 模拟用户用掉 60GB（平台是唯一真相）
    cf.customers.set(platformId, { ...cf.customers.get(platformId)!, traffic_balance: 40 * GIGA });
    const expireBefore = cf.customers.get(platformId)!.expire_date;

    const renewed = await buy("p_period_100g", PERIOD_TOKEN);

    // 余额一个字都不许动 —— 动了就等于把已用的 60GB 还回去
    expect(cf.customers.get(platformId)!.traffic_balance).toBe(40 * GIGA);
    // 到期日顺延（只发这一个字段）
    const patch = cf.patches.at(-1)!;
    expect(patch.id).toBe(platformId);
    expect(patch.body).not.toHaveProperty("traffic_balance");
    expect(patch.body).not.toHaveProperty("quota");
    expect(patch.body.expire_date).toBe(cf.customers.get(platformId)!.expire_date);
    expect(cf.customers.get(platformId)!.expire_date! > expireBefore!).toBe(true);

    // 重试也必须用同一种写法：动作随订单持久化
    expect((await lastAction(renewed.orderCode))?.provision_action).toBe("renewal");
  });

  it("加量包：平台余额 = 回源剩余 + gb（不是满额）", async () => {
    const customerId = (await env.DB.prepare(`SELECT id FROM customers WHERE email = ?`)
      .bind(PERIOD_EMAIL)
      .first<{ id: number }>())!.id;
    const sub = (await readSub(customerId))!;
    const platformId = sub.platform_customer_id!;

    // 平台只剩 40GB，本地缓存也过期（逼加量包强制回源）
    cf.customers.set(platformId, { ...cf.customers.get(platformId)!, traffic_balance: 40 * GIGA });
    await env.DB.prepare(
      `UPDATE platform_subscriptions SET traffic_remaining_gb = NULL, traffic_synced_at = NULL
        WHERE id = ?`,
    )
      .bind(sub.id)
      .run();

    const bought = await buy("p_addon_50g", PERIOD_TOKEN);

    // 40 + 50 = 90；写成 100 + 50 = 150 就是把已用的 60GB 还回去了
    expect(cf.customers.get(platformId)!.traffic_balance).toBe(90 * GIGA);
    // 池子加上去、缓存对齐成刚写的值
    const after = (await readSub(customerId))!;
    expect(after.period_extra_gb).toBe(50);
    expect(after.traffic_remaining_gb).toBe(90);
    expect((await lastAction(bought.orderCode))?.provision_action).toBe("addon");
  });
});

describe("traffic 续订：余额 = 回源剩余 + gb", () => {
  it("基数是平台真实剩余，不是 15 分钟缓存", async () => {
    const customerId = (await env.DB.prepare(`SELECT id FROM customers WHERE email = ?`)
      .bind(TRAFFIC_EMAIL)
      .first<{ id: number }>())!.id;

    await buy("p_traffic_50g", TRAFFIC_TOKEN);
    const first = (await readSub(customerId))!;
    const platformId = first.platform_customer_id!;
    expect(cf.customers.get(platformId)!.traffic_balance).toBe(50 * GIGA);

    // 平台只剩 20GB，但本地缓存还停在 50（>0 所以仍判"续订"而不是"重开"）
    cf.customers.set(platformId, { ...cf.customers.get(platformId)!, traffic_balance: 20 * GIGA });

    const renewed = await buy("p_traffic_50g", TRAFFIC_TOKEN);

    // 20 + 50 = 70：用缓存算会写成 100
    expect(cf.customers.get(platformId)!.traffic_balance).toBe(70 * GIGA);
    const after = (await readSub(customerId))!;
    expect(after.traffic_remaining_gb).toBe(70);
    expect(after.traffic_total_gb).toBe(100);
    expect((await lastAction(renewed.orderCode))?.provision_action).toBe("renewal");
  });
});
