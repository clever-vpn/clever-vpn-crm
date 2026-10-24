/**
 * 集成测试：后台「客户」与「订单」列表
 *
 * 重点：客户列表必须带出**当前订阅 + 算出来的状态**（一个客户一行），
 * 订单列表要能按状态筛。这两个页面是运营每天第一眼看的东西，字段错了没法解释。
 */
import { exports as rawExports } from "cloudflare:workers";
import { beforeAll, describe, expect, it } from "vitest";

import { env } from "./apply-migrations";

const BASE = "https://crm.test";
const CSRF = { "x-crm-request": "1" };
const DEV_PASSWORD_HASH =
  "pbkdf2$sha256$50000$Y2xldmVydnBuLWRldi1zYQ$pNN_GLa4DQySXqMVpf9UB8ETxhsV6Z64uKaqiB190Mo";

const worker = rawExports as unknown as {
  default: { fetch(request: Request): Promise<Response> };
};

let cookie = "";

function call(path: string, init: { method?: string; body?: unknown; auth?: boolean } = {}) {
  const headers: Record<string, string> = { ...CSRF };
  if (init.body !== undefined) headers["content-type"] = "application/json";
  if (init.auth !== false && cookie) headers.cookie = cookie;
  return worker.default.fetch(
    new Request(`${BASE}${path}`, {
      method: init.method ?? "GET",
      headers,
      body: init.body === undefined ? undefined : JSON.stringify(init.body),
    }),
  );
}

beforeAll(async () => {
  const now = new Date().toISOString();
  await env.DB.prepare(
    `INSERT INTO admin_users (email, password_hash, totp_enabled, created_at, updated_at)
     VALUES (?, ?, 0, ?, ?)`,
  )
    .bind("ops@example.com", DEV_PASSWORD_HASH, now, now)
    .run();

  await env.DB.prepare(
    `INSERT INTO plans (id, name, kind, price_minor, currency, licence_limit, term_days,
       monthly_quota_gb, traffic_gb, validity_days, allow_addons, line_ids, sales_channels,
       store_product_id, sort_order, status, visibility, created_at, updated_at)
     VALUES ('adm_plan_30d', '月付 · 测试', 'period', 1500, 'CNY', 1, 30, 100, NULL, NULL, 0,
       '[]', '[{"channel":"web_checkout","methods":["alipay"]}]', '{}', 1, 'active', 'public', ?, ?)`,
  )
    .bind(now, now)
    .run();

  const res = await call("/api/admin/login", {
    method: "POST",
    auth: false,
    body: { email: "ops@example.com", password: "crm-admin-2026" },
  });
  expect(res.status).toBe(200);
  cookie = (res.headers.get("set-cookie") ?? "").split(";")[0] ?? "";
  expect(cookie).toContain("crm_admin=");
});

describe("客户列表", () => {
  it("未登录不能看", async () => {
    const res = await call("/api/admin/customers", { auth: false });
    expect(res.status).toBe(401);
  });

  it("没有订阅的客户 → subscription 为 null", async () => {
    const created = await call("/api/admin/customers", {
      method: "POST",
      body: { email: "no-sub@test.com" },
    });
    expect(created.status).toBe(201);

    const list = await call("/api/admin/customers");
    const { customers } = (await list.json()) as {
      customers: { email: string; subscription: unknown }[];
    };
    expect(customers.find((c) => c.email === "no-sub@test.com")?.subscription).toBeNull();
  });

  it("开通之后带出套餐、状态与到期日（状态是算出来的）", async () => {
    const created = await call("/api/admin/customers", {
      method: "POST",
      body: { email: "with-sub@test.com" },
    });
    const { customer } = (await created.json()) as { customer: { id: number } };

    const grant = await call("/api/admin/subscriptions", {
      method: "POST",
      body: { customer_id: customer.id, plan_id: "adm_plan_30d" },
    });
    expect(grant.status).toBe(201);

    const list = await call("/api/admin/customers");
    const { customers } = (await list.json()) as {
      customers: {
        email: string;
        subscription: {
          plan_id: string;
          status: string;
          status_reason: string | null;
          expires_at: string;
        } | null;
      }[];
    };
    const row = customers.find((c) => c.email === "with-sub@test.com");
    expect(row?.subscription?.plan_id).toBe("adm_plan_30d");
    expect(row?.subscription?.status).toBe("active");
    expect(row?.subscription?.status_reason).toBeNull();
    expect(Date.parse(row?.subscription?.expires_at ?? "")).toBeGreaterThan(Date.now());
  });

  it("同一客户再开通一次 = 覆盖同一行（不是新增一行）", async () => {
    const list = await call("/api/admin/customers");
    const { customers } = (await list.json()) as {
      customers: { id: number; email: string }[];
    };
    const target = customers.find((c) => c.email === "with-sub@test.com");
    await call("/api/admin/subscriptions", {
      method: "POST",
      body: { customer_id: target?.id, plan_id: "adm_plan_30d" },
    });

    const rows = await env.DB.prepare(
      `SELECT COUNT(*) AS n FROM platform_subscriptions WHERE customer_id = ?`,
    )
      .bind(target?.id ?? 0)
      .first<{ n: number }>();
    expect(rows?.n).toBe(1);
  });
});

describe("订单列表", () => {
  it("空库返回空数组，且能按状态筛", async () => {
    const all = await call("/api/admin/orders");
    expect(all.status).toBe(200);
    const body = (await all.json()) as { orders: unknown[] };
    expect(Array.isArray(body.orders)).toBe(true);

    const filtered = await call("/api/admin/orders?status=paid");
    expect(filtered.status).toBe(200);
    expect(((await filtered.json()) as { orders: unknown[] }).orders).toEqual([]);
  });

  it("下单之后能在列表里看到（带客户邮箱与金额）", async () => {
    const list = await call("/api/admin/customers");
    const { customers } = (await list.json()) as {
      customers: { id: number; email: string }[];
    };
    const target = customers.find((c) => c.email === "with-sub@test.com");

    const now = new Date().toISOString();
    await env.DB.prepare(
      `INSERT INTO orders (code, customer_id, plan_id, kind, plan_snapshot, amount_minor, currency,
         source, payment_method, status, created_at, updated_at)
       VALUES ('ORD-TEST-1', ?, 'adm_plan_30d', 'period', '{}', 1500, 'CNY',
         'purchase', 'alipay', 'pending', ?, ?)`,
    )
      .bind(target?.id ?? 0, now, now)
      .run();

    const res = await call("/api/admin/orders?status=pending");
    const { orders } = (await res.json()) as {
      orders: { code: string; email: string; amount_minor: number; status: string }[];
    };
    const row = orders.find((o) => o.code === "ORD-TEST-1");
    expect(row?.email).toBe("with-sub@test.com");
    expect(row?.amount_minor).toBe(1500);
    expect(row?.status).toBe("pending");
  });
});
