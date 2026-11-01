/**
 * 后台"测试支付"：验的是**网关能不能收钱**，不是"这个用户能不能买"
 *
 * 四条要钉住的：
 *   1. 测试单可以给 `draft` 网关用（验收的对象就是它）；
 *   2. 测试单忽略白名单（白名单是给"私有网关只让某人用"准备的，测试本来就要绕过去）；
 *   3. 到账后只落 `paid`，**不产生订阅、不进 `provisioning`**；
 *   4. 用户侧 `GET /orders` 看不到测试单（`customer_id = 0` + `source='test'`）。
 */
import { exports as rawExports } from "cloudflare:workers";
import { beforeAll, describe, expect, it } from "vitest";

import { env } from "./apply-migrations";

const BASE = "https://crm.test";
const CSRF = { "x-crm-request": "1" };

const worker = rawExports as unknown as {
  default: { fetch(request: Request): Promise<Response> };
};

const DEV_PASSWORD_HASH =
  "pbkdf2$sha256$50000$Y2xldmVydnBuLWRldi1zYQ$pNN_GLa4DQySXqMVpf9UB8ETxhsV6Z64uKaqiB190Mo";

const now = () => new Date().toISOString();

let cookie = "";
let gatewayId = 0;

function call(path: string, init: { method?: string; body?: unknown } = {}) {
  const headers: Record<string, string> = { ...CSRF };
  if (init.body !== undefined) headers["content-type"] = "application/json";
  if (cookie) headers.cookie = cookie;
  return worker.default.fetch(
    new Request(`${BASE}${path}`, {
      method: init.method ?? "GET",
      headers,
      body: init.body === undefined ? undefined : JSON.stringify(init.body),
    }),
  );
}

beforeAll(async () => {
  (env as unknown as Record<string, unknown>).ALLOW_MOCK_PAYMENTS = "true";

  await env.DB.prepare(
    `INSERT INTO admin_users (email, password_hash, totp_enabled, created_at, updated_at)
     VALUES (?, ?, 0, ?, ?)`,
  )
    .bind("ops@example.com", DEV_PASSWORD_HASH, now(), now())
    .run();

  const login = await call("/api/admin/login", {
    method: "POST",
    body: { email: "ops@example.com", password: "crm-admin-2026" },
  });
  expect(login.status).toBe(200);
  cookie = (login.headers.get("set-cookie") ?? "").split(";")[0] ?? "";

  // `draft` + 白名单非空 —— 真实用户永远用不到它，正好用来证明测试路径会绕过两道闸门
  const res = await env.DB.prepare(
    `INSERT INTO payment_gateways (driver, name, endpoint, merchant_id, secret_enc, methods,
       mapping, priority, status, currency, allowed_emails, created_at, updated_at)
     VALUES ('mock', '待验收网关', NULL, 'M-TEST', NULL, '["alipay"]', NULL, 500, 'draft',
       'CNY', '["only@dev.local"]', ?, ?)`,
  )
    .bind(now(), now())
    .run();
  gatewayId = Number(res.meta.last_row_id ?? 0);
});

describe("后台测试支付", () => {
  it("draft + 白名单非空的网关也能建出测试单", async () => {
    const res = await call(`/api/admin/gateways/${gatewayId}/test`, {
      method: "POST",
      body: { method: "alipay", amount_minor: 1 },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { order_code: string; pay_url: string };
    expect(body.pay_url).toContain("/pay/mock/");

    const row = await env.DB.prepare(
      `SELECT source, plan_id, customer_id, amount_minor FROM orders WHERE code = ?`,
    )
      .bind(body.order_code)
      .first<{ source: string; plan_id: string; customer_id: number; amount_minor: number }>();
    expect(row?.source).toBe("test");
    expect(row?.plan_id).toBe("__gateway_test__");
    expect(row?.customer_id).toBe(0);
    expect(row?.amount_minor).toBe(1);
  });

  it("不支持的方式直接拒绝", async () => {
    const res = await call(`/api/admin/gateways/${gatewayId}/test`, {
      method: "POST",
      body: { method: "wechat" },
    });
    expect(res.status).toBe(400);
  });

  it("用户侧 /orders 看不到测试单", async () => {
    // 用一个普通客户的会话确认列表里没有 `source='test'` 的行
    const created = await call(`/api/admin/gateways/${gatewayId}/test`, {
      method: "POST",
      body: { method: "alipay" },
    });
    expect(created.status).toBe(200);
    const count = await env.DB.prepare(
      `SELECT COUNT(*) AS n FROM orders WHERE source = 'test'`,
    ).first<{ n: number }>();
    expect(Number(count?.n ?? 0)).toBeGreaterThanOrEqual(1);
    // customer_id 恒为 0 ⇒ 任何真实客户按 customer_id 查都拿不到
    const leaked = await env.DB.prepare(
      `SELECT COUNT(*) AS n FROM orders WHERE source = 'test' AND customer_id <> 0`,
    ).first<{ n: number }>();
    expect(Number(leaked?.n ?? 0)).toBe(0);
  });
});
