/**
 * cf-api 客户被误删之后的恢复（运维事故，不是用户的操作）。
 *
 * 设计口径（刻意做得简单）：
 *   - **只认 404**：平台超时 / 429 / 5xx 一律不当"被删了"——误判会白换一次码；
 *   - **恢复 = 重登**：`/auth/verify` 顺带自检一次，发现客户不在了就按当前订阅**全量重建**，
 *     本次登录直接拿到新码；
 *   - **绝不复活**：退款撤销（`hold='revoked'`）的订阅重建出来仍是 `frozen=1`；
 *   - 后台另有「重新落账」按钮，给"用户不常登录 / 客服直接处理"用。
 */
import { exports as rawExports } from "cloudflare:workers";
import { beforeAll, describe, expect, it } from "vitest";

import { env } from "./apply-migrations";
import { installFakeCfApi, seedPlatformCreds } from "./fake-cf-api";

import type { FakeCfApi } from "./fake-cf-api";

const BASE = "https://crm.test";
const GIGA = 1024 ** 3;
const CSRF = { "x-crm-request": "1" };

const REPAIR_EMAIL = "repair@test.com";
const REVOKED_EMAIL = "revoked@test.com";
const FLAKY_EMAIL = "flaky@test.com";

const worker = rawExports as unknown as {
  default: { fetch(request: Request): Promise<Response> };
};

const DEV_PASSWORD_HASH =
  "pbkdf2$sha256$50000$Y2xldmVydnBuLWRldi1zYQ$pNN_GLa4DQySXqMVpf9UB8ETxhsV6Z64uKaqiB190Mo";

const now = () => new Date().toISOString();

let cf: FakeCfApi;
let adminCookie = "";

function post(path: string, body: unknown, headers: Record<string, string> = {}) {
  return worker.default.fetch(
    new Request(`${BASE}${path}`, {
      method: "POST",
      headers: { "content-type": "application/json", ...headers },
      body: JSON.stringify(body),
    }),
  );
}

function admin(path: string, body: unknown) {
  const headers: Record<string, string> = { ...CSRF };
  if (adminCookie) headers.cookie = adminCookie;
  return post(path, body, headers);
}

interface VerifyBody {
  session_token: string;
  platform: { token: string } | null;
  platform_status: string;
}

/** 走真实的"发码 → 验证"两步（非 production 会回显验证码） */
async function login(email: string): Promise<VerifyBody> {
  const sent = await post("/api/app/v1/auth/send-code", { email });
  const { code } = (await sent.json()) as { code?: string };
  expect(code, "非 production 应回显验证码").toBeTruthy();
  const verified = await post("/api/app/v1/auth/verify", { email, code });
  expect(verified.status).toBe(200);
  return (await verified.json()) as VerifyBody;
}

async function seedCustomer(email: string): Promise<number> {
  const res = await env.DB.prepare(
    `INSERT INTO customers (uuid, email, status, created_at)
     VALUES (lower(hex(randomblob(16))), ?, 'active', ?)`,
  )
    .bind(email, now())
    .run();
  return Number(res.meta.last_row_id ?? 0);
}

/** 直接造一条已落账的订阅（省掉再买一次） */
async function seedSubscription(
  customerId: number,
  opts: { platformId: number | null; hold?: string },
): Promise<void> {
  const t = now();
  await env.DB.prepare(
    `INSERT INTO platform_subscriptions (customer_id, plan_id, kind, hold, paid_minor,
       currency, licence_limit, period_term_days, period_quota_gb, period_extra_gb,
       traffic_remaining_gb, traffic_synced_at, started_at, expires_at, period_anchor_day,
       period_settled_at, platform_customer_id, activation_code, created_at, updated_at)
     VALUES (?, 'p_period_100g', 'period', ?, 1500, 'CNY', 1, 30, 100, 0,
       NULL, ?, ?, ?, 23, ?, ?, ?, ?, ?)`,
  )
    .bind(
      customerId,
      opts.hold ?? "none",
      t,
      t,
      new Date(Date.now() + 30 * 86_400_000).toISOString(),
      t,
      opts.platformId,
      opts.platformId === null ? null : `code-${opts.platformId}`,
      t,
      t,
    )
    .run();
}

function fakeCustomer(id: number, authId: string, opts: { deleted?: boolean } = {}) {
  cf.customers.set(id, {
    id,
    code: `code-${id}`,
    name: `c-${id}`,
    email: null,
    auth_id: authId,
    licence_limit: 1,
    frozen: 0,
    expire_date: null,
    traffic_balance: 100 * GIGA,
    quota: null,
    line_ids: null,
    _is_deleted: opts.deleted ? 1 : 0,
  });
}

function subOf(customerId: number) {
  return env.DB.prepare(`SELECT * FROM platform_subscriptions WHERE customer_id = ?`)
    .bind(customerId)
    .first<{
      platform_customer_id: number | null;
      activation_code: string | null;
      expires_at: string | null;
      hold: string;
    }>();
}

beforeAll(async () => {
  const fake = installFakeCfApi();
  cf = fake;
  await seedPlatformCreds(env.DB, fake);

  await env.DB.prepare(
    `INSERT INTO admin_users (email, password_hash, totp_enabled, created_at, updated_at)
     VALUES (?, ?, 0, ?, ?)`,
  )
    .bind("ops@example.com", DEV_PASSWORD_HASH, now(), now())
    .run();
  const adminLogin = await post(
    "/api/admin/login",
    { email: "ops@example.com", password: "crm-admin-2026" },
    { ...CSRF },
  );
  expect(adminLogin.status).toBe(200);
  adminCookie = (adminLogin.headers.get("set-cookie") ?? "").split(";")[0] ?? "";

  await env.DB.prepare(
    `INSERT INTO plans (id, name, kind, price_minor, currency, licence_limit, term_days,
       monthly_quota_gb, traffic_gb, validity_days, line_ids, sales_channels,
       store_product_id, sort_order, status, visibility, created_at, updated_at)
     VALUES ('p_period_100g', '月付 · 100GB', 'period', 1500, 'CNY', 1, 30, 100, NULL, NULL,
       '[]', '[{"channel":"web_checkout","methods":["alipay"]}]', '{}', 1, 'active', 'public', ?, ?)`,
  )
    .bind(now(), now())
    .run();

  await env.DB.prepare(
    `INSERT INTO payment_gateways (driver, name, endpoint, merchant_id, secret_enc, methods,
       mapping, priority, status, currency, allowed_emails, created_at, updated_at)
     VALUES ('mock', '测试网关（演示）', NULL, 'MOCK-M1', NULL, '["alipay"]',
       NULL, 999, 'live', 'CNY', ?, ?, ?)`,
  )
    .bind(JSON.stringify([REPAIR_EMAIL]), now(), now())
    .run();
});

describe("平台客户被误删 → 重登即恢复", () => {
  it("重登拿到新码，且新客户是「完整权益」而不是空壳", async () => {
    // 1) 注册（登录即建号）
    const first = await login(REPAIR_EMAIL);
    expect(first.platform).toBeNull(); // 没买过 = 没有平台快照

    const customerId = (await env.DB.prepare(`SELECT id FROM customers WHERE email = ?`)
      .bind(REPAIR_EMAIL)
      .first<{ id: number }>())!.id;

    // 2) 买一份，落账成功
    const created = await worker.default.fetch(
      new Request(`${BASE}/api/app/v1/orders`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${first.session_token}`,
        },
        body: JSON.stringify({ plan_id: "p_period_100g", payment_method: "alipay" }),
      }),
    );
    const order = (await created.json()) as { pay_url: string };
    await worker.default.fetch(new Request(`${order.pay_url}/paid`, { method: "POST" }));

    const before = (await subOf(customerId))!;
    const oldPlatformId = before.platform_customer_id!;
    const oldCode = before.activation_code!;
    expect(oldPlatformId).toBeGreaterThan(0);
    expect(cf.customers.get(oldPlatformId)!.traffic_balance).toBe(100 * GIGA);

    // 3) 运维误删：平台侧那一行软删
    cf.customers.set(oldPlatformId, { ...cf.customers.get(oldPlatformId)!, _is_deleted: 1 });

    // 4) 用户重新登录 → 自动重建
    const again = await login(REPAIR_EMAIL);
    expect(again.platform).not.toBeNull();
    expect(again.platform!.token).not.toBe(oldCode);
    expect(again.platform_status).toBe("active");

    const after = (await subOf(customerId))!;
    expect(after.platform_customer_id).not.toBe(oldPlatformId);
    expect(after.activation_code).toBe(again.platform!.token);

    // 5) 新客户按当前订阅**全量**恢复：不是"建了个空壳"（cf-api 里空参数 = 永久不限量）
    const rebuilt = cf.customers.get(after.platform_customer_id!)!;
    expect(rebuilt.auth_id).toBe(`crm:${customerId}`);
    expect(rebuilt.traffic_balance).toBe(100 * GIGA);
    expect(rebuilt.expire_date).toBe(after.expires_at!.slice(0, 10));
    expect(rebuilt.quota).toBeNull();
    expect(rebuilt.line_ids ?? null).toBeNull();
    expect(rebuilt.frozen).toBe(0);
  });

  it("退款撤销的订阅不会被重登复活（重建出来仍是 frozen）", async () => {
    const customerId = await seedCustomer(REVOKED_EMAIL);
    await seedSubscription(customerId, { platformId: 601, hold: "revoked" });
    fakeCustomer(601, `crm:${customerId}`, { deleted: true });

    const body = await login(REVOKED_EMAIL);
    expect(body.platform_status).toBe("inactive");

    const after = (await subOf(customerId))!;
    expect(after.platform_customer_id).not.toBe(601);
    const rebuilt = cf.customers.get(after.platform_customer_id!)!;
    // 重建照做（保证映射完整），但权益是"停用"的 —— 不影响任何人
    expect(rebuilt.frozen).toBe(1);
  });

  it("平台 5xx 不重建（只有 404 才算「被删了」）", async () => {
    const customerId = await seedCustomer(FLAKY_EMAIL);
    await seedSubscription(customerId, { platformId: 602 });
    fakeCustomer(602, `crm:${customerId}`);

    const sizeBefore = cf.customers.size;
    cf.failures.remaining = 1;
    cf.failures.status = 500;

    const body = await login(FLAKY_EMAIL);
    // 登录照常成功（取不到平台快照 != 登录失败），但不该动映射
    expect(body).toBeTruthy();
    const after = (await subOf(customerId))!;
    expect(after.platform_customer_id).toBe(602);
    expect(cf.customers.size).toBe(sizeBefore);
  });
});

describe("后台「重新落账」按钮", () => {
  it("没有平台客户的订阅（手工开通）也能落账", async () => {
    const customerId = await seedCustomer("manual@test.com");
    await seedSubscription(customerId, { platformId: null });

    const res = await admin(`/api/admin/customers/${customerId}/provision`, {});
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      ok: boolean;
      platform_customer_id: number;
      activation_code: string;
      replaced: boolean;
    };
    expect(body.ok).toBe(true);
    expect(body.replaced).toBe(false); // 原来没有平台客户 ⇒ 不算"换了码"

    const after = (await subOf(customerId))!;
    expect(after.platform_customer_id).toBe(body.platform_customer_id);
    expect(after.activation_code).toBe(body.activation_code);
    expect(cf.customers.get(body.platform_customer_id)!.traffic_balance).toBe(100 * GIGA);
  });

  it("没有订阅 ⇒ 404", async () => {
    const customerId = await seedCustomer("no-sub@test.com");
    const res = await admin(`/api/admin/customers/${customerId}/provision`, {});
    expect(res.status).toBe(404);
  });
});
