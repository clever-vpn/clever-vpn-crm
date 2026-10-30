/**
 * 核销占位（`redemptions`）—— **幂等地基**
 *
 * 要钉住的只有一件事：**同一份礼包，不管被触发多少次、并发多少次、中途崩过几次，
 * 用户只拿到一份，台账只有一行，0 元订单只有一张。**
 *
 * 为什么这不是洁癖：批量发放（上万人）的调度是"分页 + 重入"的，**重跑是常态**；
 * 而"改订阅"和"写台账"之间只要崩一次，没有占位就会静默双发 —— 那是真金白银。
 *
 * 顺带回归：优惠券路径（支付成功才核销）的台账一行也不受影响。
 */
import { exports as rawExports } from "cloudflare:workers";
import { beforeAll, describe, expect, it } from "vitest";

import { env } from "./apply-migrations";
import { installFakeCfApi } from "./fake-cf-api";

import type { FakeCfApi } from "./fake-cf-api";

const BASE = "https://crm.test";
const CSRF = { "x-crm-request:": "1" };
const DEV_PASSWORD_HASH =
  "pbkdf2$sha256$50000$Y2xldmVydnBuLWRldi1zYQ$pNN_GLa4DQySXqMVpf9UB8ETxhsV6Z64uKaqiB190Mo";

const SERIAL = "idem-serial@test.com";
const RACER = "idem-race@test.com";
const CRASHED = "idem-crash@test.com";
const BUSY = "idem-busy@test.com";
const REUSABLE = "idem-reusable@test.com";
const COUPON = "idem-coupon@test.com";

const worker = rawExports as unknown as {
  default: { fetch(request: Request): Promise<Response> };
};

let adminCookie = "";

function fetchJson(
  path: string,
  init: { method?: string; body?: unknown; headers?: Record<string, string> } = {},
) {
  const headers: Record<string, string> = { ...init.headers };
  if (init.body !== undefined) headers["content-type"] = "application/json";
  return worker.default.fetch(
    new Request(`${BASE}${path}`, {
      method: init.method ?? "GET",
      headers,
      body: init.body === undefined ? undefined : JSON.stringify(init.body),
    }),
  );
}

const appCall = (path: string, token: string, init: { method?: string; body?: unknown } = {}) =>
  fetchJson(path, { ...init, headers: { authorization: `Bearer ${token}` } });

async function login(email: string): Promise<string> {
  const sent = await fetchJson("/api/app/v1/auth/send-code", { method: "POST", body: { email } });
  const { code } = (await sent.json()) as { code?: string };
  expect(code).toBeTruthy();
  const verified = await fetchJson("/api/app/v1/auth/verify", {
    method: "POST",
    body: { email, code },
  });
  expect(verified.status).toBe(200);
  return ((await verified.json()) as { session_token: string }).session_token;
}

async function customerIdOf(email: string): Promise<number> {
  const row = await env.DB.prepare(`SELECT id FROM customers WHERE email = ?`)
    .bind(email)
    .first<{ id: number }>();
  expect(row, `客户应存在：${email}`).toBeTruthy();
  return row!.id;
}

/** 买一张月付，把订阅造出来（礼包要有地方放） */
async function payMonthly(token: string): Promise<void> {
  const quote = await appCall("/api/app/v1/quote", token, {
    method: "POST",
    body: { plan_id: "idem_30d" },
  });
  const q = (await quote.json()) as { allowed: boolean; payable_minor: number | null };
  expect(q.allowed).toBe(true);
  const created = await appCall("/api/app/v1/orders", token, {
    method: "POST",
    body: {
      plan_id: "idem_30d",
      payment_method: "alipay",
      expected_payable_minor: q.payable_minor,
      origin: "web",
    },
  });
  expect(created.status).toBe(201);
  const order = (await created.json()) as { pay_url: string };
  const paid = await worker.default.fetch(new Request(`${order.pay_url}/paid`, { method: "POST" }));
  expect(paid.status).toBe(200);
}

/** 直接插一个活动（绕过后台表单，测试只关心发放语义） */
async function makePromotion(opts: {
  name: string;
  rewards: { days?: number; gb?: number };
  delivery?: "auto" | "claim";
}): Promise<number> {
  const now = new Date().toISOString();
  const res = await env.DB.prepare(
    `INSERT INTO promotions
       (auto_apply, name, kind, benefit_type, benefit_value, rewards_json, delivery,
        audience, max_uses_per_customer, status, created_at, updated_at)
     VALUES (0, ?, 'gift', 'amount', 0, ?, ?, 'all', 1, 'active', ?, ?)`,
  )
    .bind(
      opts.name,
      JSON.stringify({ days: 0, gb: 0, ...opts.rewards }),
      opts.delivery ?? "auto",
      now,
      now,
    )
    .run();
  return Number(res.meta.last_row_id);
}

async function expiresAt(customerId: number): Promise<string> {
  const row = await env.DB.prepare(
    `SELECT expires_at FROM platform_subscriptions WHERE customer_id = ?`,
  )
    .bind(customerId)
    .first<{ expires_at: string }>();
  return row!.expires_at;
}

async function counts(promotionId: number, customerId: number) {
  const redemptions = await env.DB.prepare(
    `SELECT COUNT(*) AS n, SUM(CASE WHEN order_id IS NULL THEN 1 ELSE 0 END) AS placeholders
       FROM redemptions WHERE promotion_id = ? AND customer_id = ?`,
  )
    .bind(promotionId, customerId)
    .first<{ n: number; placeholders: number | null }>();
  const orders = await env.DB.prepare(
    `SELECT COUNT(*) AS n FROM orders WHERE customer_id = ? AND source = 'gift'`,
  )
    .bind(customerId)
    .first<{ n: number }>();
  return {
    redemptions: Number(redemptions?.n ?? 0),
    placeholders: Number(redemptions?.placeholders ?? 0),
    giftOrders: Number(orders?.n ?? 0),
  };
}

const deliver = async (promotionId: number, customerId: number, source = "manual" as const) => {
  const { deliverGift } = await import("../../src/promotions/gift");
  return deliverGift(env, { promotionId, customerId, source });
};

beforeAll(async () => {
  (env as unknown as Record<string, unknown>).ALLOW_MOCK_PAYMENTS = "true";
  const cfApi: FakeCfApi = installFakeCfApi();
  (env as unknown as Record<string, unknown>).CF_API_BASE = cfApi.base;
  (env as unknown as Record<string, unknown>).CF_API_TOKEN = cfApi.token;
  const now = new Date().toISOString();

  await env.DB.batch([
    env.DB.prepare(
      `INSERT INTO admin_users (email, password_hash, totp_enabled, created_at, updated_at)
       VALUES ('ops@example.com', ?, 0, ?, ?)`,
    ).bind(DEV_PASSWORD_HASH, now, now),
    env.DB.prepare(
      `INSERT INTO payment_gateways (driver, name, endpoint, merchant_id, secret_enc, methods,
         mapping, priority, status, currency, allowed_emails, created_at, updated_at)
       VALUES ('mock', '测试网关（演示）', NULL, 'MOCK-IDEM', NULL, '["alipay"]',
         NULL, 999, 'live', 'CNY', ?, ?, ?)`,
    ).bind(
      JSON.stringify([SERIAL, RACER, CRASHED, BUSY, REUSABLE, COUPON]),
      now,
      now,
    ),
    env.DB.prepare(
      `INSERT INTO plans (id, name, kind, price_minor, currency, licence_limit, term_days,
         monthly_quota_gb, traffic_gb, validity_days, line_ids, sales_channels,
         store_product_id, sort_order, status, visibility, created_at, updated_at)
       VALUES ('idem_30d', '月付 · 10 元', 'period', 1000, 'CNY', 1, 30, 100,
         NULL, NULL, '[]', '[{"channel":"web_checkout","methods":["alipay"]}]',
         '{}', 1, 'active', 'public', ?, ?)`,
    ).bind(now, now),
  ]);

  void CSRF;
  const loginRes = await fetchJson("/api/admin/login", {
    method: "POST",
    headers: { "x-crm-request": "1" },
    body: { email: "ops@example.com", password: "crm-admin-2026" },
  });
  expect(loginRes.status).toBe(200);
  adminCookie = (loginRes.headers.get("set-cookie") ?? "").split(";")[0] ?? "";
});

describe("占位 = 一次核销的唯一凭证", () => {
  it("连发 3 次 ⇒ 权益只加一次、0 元订单一张、台账一行", async () => {
    const promoId = await makePromotion({ name: "幂等礼包", rewards: { days: 7 } });
    const token = await login(SERIAL);
    await payMonthly(token);
    const customerId = await customerIdOf(SERIAL);
    const before = await expiresAt(customerId);

    const results = [];
    for (let i = 0; i < 3; i += 1) results.push(await deliver(promoId, customerId));

    expect(results.filter((r) => r?.granted)).toHaveLength(1);
    // 第 2、3 次都被挡下，而且给出的是人话
    expect(results[1]?.skipped ?? results[1]?.granted).toBeTruthy();
    expect(results[2]?.granted).toBeFalsy();

    const added = Math.round(
      (Date.parse(await expiresAt(customerId)) - Date.parse(before)) / 86_400_000,
    );
    expect(added).toBe(7); // 只加了一次 7 天

    const c = await counts(promoId, customerId);
    expect(c).toEqual({ redemptions: 1, placeholders: 0, giftOrders: 1 });
  });

  it("并发两次 ⇒ 只有一次成功（唯一索引兜底，不会静默双发）", async () => {
    const promoId = await makePromotion({ name: "并发礼包", rewards: { gb: 5 } });
    const token = await login(RACER);
    await payMonthly(token);
    const customerId = await customerIdOf(RACER);

    const [a, b] = await Promise.all([
      deliver(promoId, customerId),
      deliver(promoId, customerId),
    ]);

    const granted = [a, b].filter((r) => r?.granted).length;
    expect(granted).toBe(1);

    const c = await counts(promoId, customerId);
    expect(c).toEqual({ redemptions: 1, placeholders: 0, giftOrders: 1 });
  });

  it("占位超过 5 分钟（上次崩在中间）⇒ 后来者接管，仍然只发一份", async () => {
    const promoId = await makePromotion({ name: "崩溃礼包", rewards: { days: 3 } });
    const token = await login(CRASHED);
    await payMonthly(token);
    const customerId = await customerIdOf(CRASHED);
    const before = await expiresAt(customerId);

    // 模拟"上次占位完就崩了"：一行 order_id IS NULL、时间戳在 6 分钟前
    await env.DB.prepare(
      `INSERT INTO redemptions (promotion_id, customer_id, order_id, code_id, discount_minor,
         granted_json, created_at)
       VALUES (?, ?, NULL, NULL, 0, '{}', ?)`,
    )
      .bind(promoId, customerId, new Date(Date.now() - 6 * 60_000).toISOString())
      .run();

    const result = await deliver(promoId, customerId);
    expect(result?.granted).toBe(true);

    const added = Math.round(
      (Date.parse(await expiresAt(customerId)) - Date.parse(before)) / 86_400_000,
    );
    expect(added).toBe(3);

    const c = await counts(promoId, customerId);
    expect(c).toEqual({ redemptions: 1, placeholders: 0, giftOrders: 1 });
  });

  it("占位刚写下（真的有人在发）⇒ 第二次拿不到，权益一点没动", async () => {
    const promoId = await makePromotion({ name: "发放中礼包", rewards: { days: 5 } });
    const token = await login(BUSY);
    await payMonthly(token);
    const customerId = await customerIdOf(BUSY);
    const before = await expiresAt(customerId);

    await env.DB.prepare(
      `INSERT INTO redemptions (promotion_id, customer_id, order_id, code_id, discount_minor,
         granted_json, created_at)
       VALUES (?, ?, NULL, NULL, 0, '{}', ?)`,
    )
      .bind(promoId, customerId, new Date().toISOString())
      .run();

    const result = await deliver(promoId, customerId);
    expect(result?.granted).toBe(false);
    expect(result?.skipped).toContain("正在发放中");
    expect(await expiresAt(customerId)).toBe(before);
  });

  it("发放失败会把占位还回去（否则这个人永远领不到）", async () => {
    const { reserveRedemption, releaseRedemption } = await import(
      "../../src/promotions/redemption"
    );
    const promoId = await makePromotion({ name: "释放礼包", rewards: { days: 1 } });
    const token = await login(REUSABLE);
    await payMonthly(token);
    const customerId = await customerIdOf(REUSABLE);

    const first = await reserveRedemption(env, {
      promotionId: promoId,
      customerId,
      codeId: null,
      now: new Date(),
    });
    expect(first.ok).toBe(true);

    // 还没到 5 分钟 ⇒ 抢不到（有人在发）
    const blocked = await reserveRedemption(env, {
      promotionId: promoId,
      customerId,
      codeId: null,
      now: new Date(),
    });
    expect(blocked.ok).toBe(false);

    // 失败释放后 ⇒ 立刻可以再占
    if (first.ok) await releaseRedemption(env, first.id);
    const again = await reserveRedemption(env, {
      promotionId: promoId,
      customerId,
      codeId: null,
      now: new Date(),
    });
    expect(again.ok).toBe(true);
    if (again.ok) await releaseRedemption(env, again.id);
  });
});

describe("优惠券路径（支付成功才核销）不受影响", () => {
  it("付一单 ⇒ 台账一行、order_id 有值、没有占位残留", async () => {
    const now = new Date().toISOString();
    const promoId = Number(
      (
        await env.DB.prepare(
          `INSERT INTO promotions (auto_apply, name, kind, benefit_type, benefit_value,
             rewards_json, audience, max_uses_per_customer, badge_label, visible, status,
             created_at, updated_at)
           VALUES (1, '核销回归券', 'coupon', 'amount', 300, '{}', 'all', 1, '立减 3 元', 0,
             'active', ?, ?)`,
        )
          .bind(now, now)
          .run()
      ).meta.last_row_id,
    );

    const token = await login(COUPON);
    const quote = await appCall("/api/app/v1/quote", token, {
      method: "POST",
      body: { plan_id: "idem_30d" },
    });
    const q = (await quote.json()) as { allowed: boolean; payable_minor: number | null };
    expect(q.allowed).toBe(true);
    expect(q.payable_minor).toBe(700); // 1000 - 300

    const created = await appCall("/api/app/v1/orders", token, {
      method: "POST",
      body: {
        plan_id: "idem_30d",
        payment_method: "alipay",
        expected_payable_minor: q.payable_minor,
        origin: "web",
      },
    });
    expect(created.status).toBe(201);
    const order = (await created.json()) as { pay_url: string };
    const paid = await worker.default.fetch(
      new Request(`${order.pay_url}/paid`, { method: "POST" }),
    );
    expect(paid.status).toBe(200);

    const customerId = await customerIdOf(COUPON);
    const row = await env.DB.prepare(
      `SELECT order_id, discount_minor FROM redemptions
        WHERE promotion_id = ? AND customer_id = ?`,
    )
      .bind(promoId, customerId)
      .first<{ order_id: number | null; discount_minor: number }>();
    expect(row).toBeTruthy();
    expect(row!.order_id).toBeGreaterThan(0);
    expect(row!.discount_minor).toBe(300);
  });
});

void adminCookie;
