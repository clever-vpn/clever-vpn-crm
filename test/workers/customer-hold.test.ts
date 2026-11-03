/**
 * 临时冻结 / 解冻（契约 §2.6 ⑦ 的第一条）
 *
 * 两处必须同时动：
 *   1. **平台** `frozen=1` ⇒ VPN server 侧立刻拒绝这个码的流量；
 *   2. **CRM** 订阅 `hold='frozen'` ⇒ `/subscription` 变 `inactive / frozen`，
 *      App 显示"服务已暂停" + 客服入口。
 *
 * 与"调整权益 / 撤销会话"的区别：
 *   - 调整权益是**加**东西（补天数、补流量），不减也不停；
 *   - 撤销会话是**收回凭据**（把人踢出登录，连客服入口都进不去）—— 不该用于欠费；
 *   - 冻结只停服务，会话与激活码都不动，解冻即可恢复。
 */
import { exports as rawExports } from "cloudflare:workers";
import { beforeAll, describe, expect, it } from "vitest";

import { env } from "./apply-migrations";
import { installFakeCfApi } from "./fake-cf-api";

import type { FakeCfApi } from "./fake-cf-api";

const BASE = "https://crm.test";
const CSRF = { "x-crm-request": "1" };
const EMAIL = "hold@test.com";

const worker = rawExports as unknown as {
  default: { fetch(request: Request): Promise<Response> };
};

const DEV_PASSWORD_HASH =
  "pbkdf2$sha256$50000$Y2xldmVydnBuLWRldi1zYQ$pNN_GLa4DQySXqMVpf9UB8ETxhsV6Z64uKaqiB190Mo";

const now = () => new Date().toISOString();
let cookie = "";
let customerId = 0;
let cf: FakeCfApi;

function admin(path: string, init: { method?: string; body?: unknown } = {}) {
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
  const fake = installFakeCfApi();
  cf = fake;
  (env as unknown as Record<string, unknown>).CF_API_BASE = fake.base;
  (env as unknown as Record<string, unknown>).CF_API_TOKEN = fake.token;

  await env.DB.prepare(
    `INSERT INTO admin_users (email, password_hash, totp_enabled, created_at, updated_at)
     VALUES (?, ?, 0, ?, ?)`,
  )
    .bind("ops@example.com", DEV_PASSWORD_HASH, now(), now())
    .run();
  const login = await admin("/api/admin/login", {
    method: "POST",
    body: { email: "ops@example.com", password: "crm-admin-2026" },
  });
  cookie = (login.headers.get("set-cookie") ?? "").split(";")[0] ?? "";

  const res = await env.DB.prepare(
    `INSERT INTO customers (uuid, email, status, created_at) VALUES (?, ?, 'active', ?)`,
  )
    .bind(crypto.randomUUID(), EMAIL, now())
    .run();
  customerId = Number(res.meta.last_row_id ?? 0);
});

describe("临时冻结 / 解冻", () => {
  it("没有订阅 ⇒ 404，先开通再冻结", async () => {
    const res = await admin(`/api/admin/customers/${customerId}/hold`, {
      method: "POST",
      body: { frozen: true, reason: "测试" },
    });
    expect(res.status).toBe(404);
  });

  it("冻结后：平台 frozen=1 + 本地 hold=frozen，/subscription 变 inactive/frozen", async () => {
    // 造一条已开通的订阅并落平台客户
    await env.DB.prepare(
      `INSERT INTO platform_subscriptions (customer_id, plan_id, kind, hold, paid_minor,
         currency, licence_limit, period_term_days, period_quota_gb, period_extra_gb,
         started_at, expires_at, period_anchor_day, period_settled_at,
         platform_customer_id, activation_code, created_at, updated_at)
       VALUES (?, 'dev_period_100g', 'period', 'none', 1500, 'CNY', 1, 30, 100, 0, ?, ?,
         23, ?, 501, '1234567890123456', ?, ?)`,
    )
      .bind(customerId, now(), new Date(Date.now() + 30 * 86400_000).toISOString(), now(), now(), now())
      .run();

    // 假 cf-api 里也必须存在这个客户，否则 PATCH 会 404（真实平台同理）
    cf.customers.set(501, {
      id: 501,
      code: "1234567890123456",
      name: "hold",
      email: EMAIL,
      auth_id: `crm:${customerId}`,
      licence_limit: 1,
      frozen: 0,
      expire_date: null,
      traffic_balance: null,
      quota: null,
      _is_deleted: 0,
    });

    const res = await admin(`/api/admin/customers/${customerId}/hold`, {
      method: "POST",
      body: { frozen: true, reason: "欠费暂停" },
    });
    expect(res.status).toBe(200);
    expect(((await res.json()) as { hold: string }).hold).toBe("frozen");

    const row = await env.DB.prepare(
      `SELECT hold, hold_reason FROM platform_subscriptions WHERE customer_id = ?`,
    )
      .bind(customerId)
      .first<{ hold: string; hold_reason: string }>();
    expect(row?.hold).toBe("frozen");
    expect(row?.hold_reason).toBe("欠费暂停");
    expect(cf.patches.at(-1)?.body.frozen).toBe(1);
  });

  it("解冻后 hold 回到 none", async () => {
    const res = await admin(`/api/admin/customers/${customerId}/hold`, {
      method: "POST",
      body: { frozen: false, reason: "已结清" },
    });
    expect(res.status).toBe(200);
    const row = await env.DB.prepare(
      `SELECT hold FROM platform_subscriptions WHERE customer_id = ?`,
    )
      .bind(customerId)
      .first<{ hold: string }>();
    expect(row?.hold).toBe("none");
    expect(cf.patches.at(-1)?.body.frozen).toBe(0);
  });

  it("退款撤销（revoked）不能靠解冻复活", async () => {
    await env.DB.prepare(
      `UPDATE platform_subscriptions SET hold = 'revoked', hold_reason = '退款' WHERE customer_id = ?`,
    )
      .bind(customerId)
      .run();
    const res = await admin(`/api/admin/customers/${customerId}/hold`, {
      method: "POST",
      body: { frozen: false, reason: "想恢复" },
    });
    expect(res.status).toBe(400);
    // 后台错误信封是扁平形状：`{ error: "<code>", message }`
    expect(((await res.json()) as { error: string }).error).toBe("invalid_state");
  });
});
