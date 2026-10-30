/**
 * 用户视角的三个视图：`/me/timeline`、`/orders`（列表）、`/me/gifts`
 *
 * 共同原则：**CRM 出文案，App 只画**。所以这里断言的重点不是字段名，而是
 * "这句话说得对不对、该不该出现"：
 *
 *   1. `new / gift` 出现在时间线里，`settle / hold` **不出现**（噪音 / 内部口径）；
 *   2. 礼包那行必须带**实际生效的变化量**（+7 天 · +5 GB），不是"礼包已到账"了事；
 *   3. 订单列表给的是可直接渲染的 `title / amount_text / status_text`，
 *      并且 `pending` 要告诉前端**多久之后再问**（真正确认靠 cron）；
 *   4. 没礼包时给 `empty_text`，前端不拼空态文案。
 */
import { exports as rawExports } from "cloudflare:workers";
import { beforeAll, describe, expect, it } from "vitest";

import { env } from "./apply-migrations";
import { installFakeCfApi } from "./fake-cf-api";

import type { FakeCfApi } from "./fake-cf-api";

const BASE = "https://crm.test";
const DEV_PASSWORD_HASH =
  "pbkdf2$sha256$50000$Y2xldmVydnBuLWRldi1zYQ$pNN_GLa4DQySXqMVpf9UB8ETxhsV6Z64uKaqiB190Mo";

const USER = "views-user@test.com";
const EMPTY_USER = "views-empty@test.com";

const worker = rawExports as unknown as {
  default: { fetch(request: Request): Promise<Response> };
};

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
  return row!.id;
}

async function payMonthly(token: string): Promise<string> {
  const quote = await appCall("/api/app/v1/quote", token, {
    method: "POST",
    body: { plan_id: "views_30d" },
  });
  const q = (await quote.json()) as { allowed: boolean; payable_minor: number | null };
  expect(q.allowed).toBe(true);
  const created = await appCall("/api/app/v1/orders", token, {
    method: "POST",
    body: {
      plan_id: "views_30d",
      payment_method: "alipay",
      expected_payable_minor: q.payable_minor,
      origin: "web",
    },
  });
  expect(created.status).toBe(201);
  const order = (await created.json()) as { pay_url: string; order_code: string };
  const paid = await worker.default.fetch(new Request(`${order.pay_url}/paid`, { method: "POST" }));
  expect(paid.status).toBe(200);
  return order.order_code;
}

async function makeGift(days: number, gb: number): Promise<number> {
  const iso = new Date().toISOString();
  const res = await env.DB.prepare(
    `INSERT INTO promotions
       (auto_apply, name, kind, benefit_type, benefit_value, rewards_json, delivery,
        notify, audience, max_uses_per_customer, status, created_at, updated_at)
     VALUES (0, '视图礼包', 'gift', 'amount', 0, ?, 'auto', 0, 'all', 1, 'active', ?, ?)`,
  )
    .bind(JSON.stringify({ days, gb }), iso, iso)
    .run();
  return Number(res.meta.last_row_id ?? 0);
}

let token = "";
let customerId = 0;
let orderCode = "";

beforeAll(async () => {
  (env as unknown as Record<string, unknown>).ALLOW_MOCK_PAYMENTS = "true";
  (env as unknown as Record<string, unknown>).PAYMENT_SECRET_KEY = "master-key-for-tests";
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
       VALUES ('mock', '测试网关（演示）', NULL, 'MOCK-VIEWS', NULL, '["alipay"]',
         NULL, 999, 'live', 'CNY', ?, ?, ?)`,
    ).bind(JSON.stringify([USER, EMPTY_USER]), now, now),
    env.DB.prepare(
      `INSERT INTO plans (id, name, kind, price_minor, currency, licence_limit, term_days,
         monthly_quota_gb, traffic_gb, validity_days, line_ids, sales_channels,
         store_product_id, sort_order, status, visibility, created_at, updated_at)
       VALUES ('views_30d', '月付 · 10 元', 'period', 1000, 'CNY', 1, 30, 100,
         NULL, NULL, '[]', '[{"channel":"web_checkout","methods":["alipay"]}]',
         '{}', 1, 'active', 'public', ?, ?)`,
    ).bind(now, now),
  ]);

  token = await login(USER);
  orderCode = await payMonthly(token);
  customerId = await customerIdOf(USER);

  // 礼包到账 → 时间线应该多一条 gift
  const { deliverGift } = await import("../../src/promotions/gift");
  await deliverGift(env, { promotionId: await makeGift(7, 5), customerId, source: "manual" });

  // 塞一条 settle 与 hold 进台账（它们**不该**出现在用户时间线里）
  const sub = await env.DB.prepare(
    `SELECT id FROM platform_subscriptions WHERE customer_id = ?`,
  )
    .bind(customerId)
    .first<{ id: number }>();
  for (const action of ["settle", "hold"]) {
    await env.DB.prepare(
      `INSERT INTO subscription_changes (at, customer_id, subscription_id, action, detail)
       VALUES (?, ?, ?, ?, '{}')`,
    )
      .bind(now, customerId, sub!.id, action)
      .run();
  }
});

describe("GET /me/timeline", () => {
  it("开通与礼包各一行；settle / hold 被白名单挡在外面", async () => {
    const res = await appCall("/api/app/v1/me/timeline", token);
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      items: { action: string; title: string; delta_text: string | null; tone: string }[];
      next_cursor: number | null;
    };

    const actions = body.items.map((i) => i.action);
    expect(actions).toContain("new");
    expect(actions).toContain("gift");
    expect(actions).not.toContain("settle");
    expect(actions).not.toContain("hold");

    const gift = body.items.find((i) => i.action === "gift")!;
    expect(gift.title).toBe("礼包已到账");
    // 必须带**实际生效**的变化量，而不是一句"礼包已到账"
    expect(gift.delta_text).toBe("+7 天 · +5 GB");
    expect(gift.tone).toBe("success");

    // 新的一条在最前（倒序）
    expect(body.items[0]!.action).toBe("gift");
  });

  it("cursor 翻页：limit=1 时给下一条的游标", async () => {
    const first = (await (await appCall("/api/app/v1/me/timeline?limit=1", token)).json()) as {
      items: unknown[];
      next_cursor: number | null;
    };
    expect(first.items).toHaveLength(1);
    expect(first.next_cursor).toBeGreaterThan(0);

    const second = (await (
      await appCall(`/api/app/v1/me/timeline?limit=1&cursor=${first.next_cursor}`, token)
    ).json()) as { items: { id: number }[] };
    expect(second.items).toHaveLength(1);
  });
});

describe("GET /orders（列表）", () => {
  it("给可直接渲染的句子，pending 说明多久后再问", async () => {
    const res = await appCall("/api/app/v1/orders", token);
    const body = (await res.json()) as {
      items: {
        order_code: string;
        title: string;
        amount_text: string;
        status: string;
        status_text: string;
        tag: string;
        next_poll_after_ms: number | null;
      }[];
      next_cursor: number | null;
    };

    const order = body.items.find((i) => i.order_code === orderCode)!;
    expect(order.title).toBe("月付 · 10 元");
    expect(order.amount_text).toBe("¥10.00");
    expect(order.status).toBe("active");
    expect(order.status_text).toBe("已生效");
    // 已生效 ⇒ 不用再轮询
    expect(order.next_poll_after_ms).toBeNull();
  });

  it("金额为 0 时说明来源，不显示 ¥0.00", async () => {
    const { deliverGift } = await import("../../src/promotions/gift");
    await deliverGift(env, { promotionId: await makeGift(2, 0), customerId, source: "manual" });

    const body = (await (await appCall("/api/app/v1/orders", token)).json()) as {
      items: { amount_text: string; title: string }[];
    };
    const gift = body.items.find((i) => i.title.startsWith("礼包"));
    expect(gift).toBeTruthy();
    expect(gift!.amount_text).toContain("0 元");
  });
});

describe("GET /me/gifts（空态）", () => {
  it("没有礼包时给 empty_text，前端不拼文案", async () => {
    const other = await login(EMPTY_USER);
    const body = (await (await appCall("/api/app/v1/me/gifts", other)).json()) as {
      gifts: unknown[];
      empty_text: string | null;
    };
    expect(body.gifts).toHaveLength(0);
    expect(body.empty_text).toContain("没有可领的礼包");
  });
});

describe("GET /subscription", () => {
  it("给出下次额度重置时间（规则，不进时间线）", async () => {
    const body = (await (await appCall("/api/app/v1/subscription", token)).json()) as {
      status: string;
      next_reset_at: string | null;
    };
    expect(body.status).toBe("active");
    expect(body.next_reset_at).toBeTruthy();
    expect(Date.parse(body.next_reset_at!)).toBeGreaterThan(Date.now());
  });
});
