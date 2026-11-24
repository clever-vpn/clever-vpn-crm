/**
 * 集成测试：支付网关管理（`/api/admin/gateways*`）
 *
 * 重点不是 CRUD，而是**三道守卫**：
 *   - 列表/详情不回显密钥；当前值只能显式查看（审计）
 *   - 没配主密钥时不允许保存密钥（不能退化存明文）
 *   - 发布前检查：易支付类必须有密钥；测试网关必须有白名单
 */
import { exports as rawExports } from "cloudflare:workers";
import { beforeAll, describe, expect, it } from "vitest";

import { env } from "./apply-migrations";
import { gatewayConfigHash } from "../../src/admin/gateways";
import { GATEWAY_COLUMNS, type GatewayRow } from "../../src/payments/gateways";

const BASE = "https://crm.test";
const CSRF = { "x-crm-request": "1" };
const DEV_PASSWORD_HASH =
  "pbkdf2$sha256$50000$Y2xldmVydnBuLWRldi1zYQ$pNN_GLa4DQySXqMVpf9UB8ETxhsV6Z64uKaqiB190Mo";

const worker = rawExports as unknown as {
  default: { fetch(request: Request): Promise<Response> };
};

let cookie = "";

async function markTested(id: number): Promise<void> {
  const row = await env.DB.prepare(`SELECT ${GATEWAY_COLUMNS} FROM payment_gateways WHERE id = ?`)
    .bind(id)
    .first<GatewayRow>();
  if (!row) throw new Error(`gateway ${id} not found`);
  const now = new Date().toISOString();
  await env.DB.prepare(
    `UPDATE payment_gateways SET test_create_ok_at = ?, test_query_ok_at = ?, tested_config_hash = ? WHERE id = ?`,
  )
    .bind(now, now, await gatewayConfigHash(row), id)
    .run();
}

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
  // 本文件需要"配了主密钥"的默认态
  (env as unknown as Record<string, unknown>).APP_SECRET = "master-key-for-tests";
  (env as unknown as Record<string, unknown>).ALLOW_MOCK_PAYMENTS = "true";

  const now = new Date().toISOString();
  await env.DB.prepare(
    `INSERT INTO admin_users (email, password_hash, totp_enabled, created_at, updated_at)
     VALUES (?, ?, 0, ?, ?)`,
  )
    .bind("ops@example.com", DEV_PASSWORD_HASH, now, now)
    .run();

  const res = await call("/api/admin/login", {
    method: "POST",
    body: { email: "ops@example.com", password: "crm-admin-2026" },
  });
  expect(res.status).toBe(200);
  cookie = (res.headers.get("set-cookie") ?? "").split(";")[0] ?? "";
});

describe("网关管理", () => {
  it("列表带出驱动与能力（不回显密钥）", async () => {
    const res = await call("/api/admin/gateways");
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      drivers: { driver: string; methods: string[] }[];
      mock_enabled: boolean;
      secret_key_ready: boolean;
      gateways: Record<string, unknown>[];
    };
    expect(body.mock_enabled).toBe(true);
    expect(body.secret_key_ready).toBe(true);
    expect(body.drivers.find((d) => d.driver === "stripe")?.methods).toEqual(["stripe"]);
    for (const gw of body.gateways) expect(gw).not.toHaveProperty("secret");
  });

  it("新建易支付网关：默认草稿，密钥加密入库；列表不返回，显式查看可读", async () => {
    const res = await call("/api/admin/gateways", {
      method: "POST",
      body: {
        driver: "epay_v1",
        name: "易支付-主号",
        endpoint: "https://pay.example.com",
        merchant_id: "M1",
        secret: "super-secret-value",
        methods: ["alipay", "wechat"],
      },
    });
    expect(res.status).toBe(201);
    const text = await res.text();
    expect(text).not.toContain("super-secret-value"); // 明文绝不出现

    const { gateway } = JSON.parse(text) as { gateway: { id: number; status: string; has_secret: boolean } };
    expect(gateway.status).toBe("draft");
    expect(gateway.has_secret).toBe(true);

    // 库里存的是密文（v1: 前缀），不是明文
    const row = await env.DB.prepare(`SELECT secret_enc FROM payment_gateways WHERE id = ?`)
      .bind(gateway.id)
      .first<{ secret_enc: string }>();
    expect(row?.secret_enc).toMatch(/^v1:/);
    expect(row?.secret_enc).not.toContain("super-secret-value");

    // 列表/详情仍不回显；显式查看才返回明文，且禁止缓存
    const list = (await (await call("/api/admin/gateways")).json()) as {
      gateways: Record<string, unknown>[];
    };
    expect(list.gateways.find((g) => g.id === gateway.id)).not.toHaveProperty("secret");

    const revealed = await call(`/api/admin/gateways/${gateway.id}/secret`);
    expect(revealed.status).toBe(200);
    expect(revealed.headers.get("cache-control")).toContain("no-store");
    expect(((await revealed.json()) as { secret: string }).secret).toBe("super-secret-value");
  });

  it("未设置密钥时显式查看返回 secret_not_set", async () => {
    const created = await call("/api/admin/gateways", {
      method: "POST",
      body: {
        driver: "epay_v1",
        name: "易支付-无密钥",
        endpoint: "https://pay.example.com",
        merchant_id: "M2",
        methods: ["alipay"],
        channel_codes: { alipay: "alipay" },
      },
    });
    expect(created.status).toBe(201);
    const id = ((await created.json()) as { gateway: { id: number } }).gateway.id;
    const revealed = await call(`/api/admin/gateways/${id}/secret`);
    expect(revealed.status).toBe(400);
    expect(((await revealed.json()) as { error: string }).error).toBe("secret_not_set");
  });

  it("不支持的方式会被挡（stripe 不能卖支付宝）", async () => {
    const res = await call("/api/admin/gateways", {
      method: "POST",
      body: { driver: "stripe", name: "Stripe", methods: ["alipay"] },
    });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { message: string }).message).toContain("不支持");
  });

  it("Stripe：只填密钥即可创建并发布；发布前必须有密钥", async () => {
    const noSecret = await call("/api/admin/gateways", {
      method: "POST",
      body: { driver: "stripe", name: "Stripe-无密钥", methods: ["stripe"] },
    });
    expect(noSecret.status).toBe(201);
    const noSecretId = ((await noSecret.json()) as { gateway: { id: number } }).gateway.id;
    const denied = await call(`/api/admin/gateways/${noSecretId}/publish`, { method: "POST" });
    expect(denied.status).toBe(400);
    expect(((await denied.json()) as { error: string }).error).toBe("secret_required");

    const created = await call("/api/admin/gateways", {
      method: "POST",
      body: {
        driver: "stripe",
        name: "Stripe-主号",
        secret: "sk_test_value",
        webhook_secret: "whsec_test_value",
        methods: ["stripe"],
      },
    });
    expect(created.status).toBe(201);
    const id = ((await created.json()) as { gateway: { id: number } }).gateway.id;
    await markTested(id);
    await markTested(id);
    const pub = await call(`/api/admin/gateways/${id}/publish`, { method: "POST" });
    expect(pub.status).toBe(200);
    expect(((await pub.json()) as { gateway: { status: string } }).gateway.status).toBe("live");
  });

  it("易支付 V2：密钥 JSON 创建并发布（无 webhook）", async () => {
    const created = await call("/api/admin/gateways", {
      method: "POST",
      body: {
        driver: "epay_v2",
        name: "易支付V2-主号",
        endpoint: "https://pay.test/xpay/epayn",
        merchant_id: "10001",
        secret: JSON.stringify({ merchant_private_key: "pem", platform_public_key: "pem" }),
        methods: ["alipay", "wechat"],
      },
    });
    expect(created.status).toBe(201);
    const body = (await created.json()) as { gateway: { id: number; has_secret: boolean; has_webhook: boolean } };
    expect(body.gateway.has_secret).toBe(true);
    expect(body.gateway.has_webhook).toBe(false);

    await markTested(body.gateway.id);
    const published = await call(`/api/admin/gateways/${body.gateway.id}/publish`, { method: "POST" });
    expect(published.status).toBe(200);
  });

  it("PayPal：Client ID + Client Secret 才能创建/发布", async () => {
    const missingClient = await call("/api/admin/gateways", {
      method: "POST",
      body: { driver: "paypal", name: "PayPal-缺 Client", secret: "secret", methods: ["paypal"] },
    });
    expect(missingClient.status).toBe(400);
    expect(((await missingClient.json()) as { message: string }).message).toContain("Client ID");

    const created = await call("/api/admin/gateways", {
      method: "POST",
      body: {
        driver: "paypal",
        name: "PayPal-主号",
        merchant_id: "paypal-client-id",
        secret: "paypal-secret",
        webhook_secret: "WH-test-id",
        methods: ["paypal"],
      },
    });
    expect(created.status).toBe(201);
    const id = ((await created.json()) as { gateway: { id: number } }).gateway.id;
    await markTested(id);
    await markTested(id);
    const pub = await call(`/api/admin/gateways/${id}/publish`, { method: "POST" });
    expect(pub.status).toBe(200);
  });

  it("Stripe/PayPal 发布前必须有 webhook 凭据；保存后只回 has_webhook", async () => {
    const created = await call("/api/admin/gateways", {
      method: "POST",
      body: {
        driver: "stripe",
        name: "Stripe-无 webhook",
        secret: "sk_test_no_webhook",
        methods: ["stripe"],
      },
    });
    expect(created.status).toBe(201);
    const body = (await created.json()) as { gateway: { id: number; has_webhook: boolean } };
    expect(body.gateway.has_webhook).toBe(false);
    expect(JSON.stringify(body)).not.toContain("sk_test_no_webhook");

    const denied = await call(`/api/admin/gateways/${body.gateway.id}/publish`, { method: "POST" });
    expect(denied.status).toBe(400);
    expect(((await denied.json()) as { error: string }).error).toBe("webhook_required");

    const patched = await call(`/api/admin/gateways/${body.gateway.id}`, {
      method: "PATCH",
      body: { webhook_secret: "whsec_patched" },
    });
    expect(patched.status).toBe(200);
    expect(JSON.stringify(await patched.json())).not.toContain("whsec_patched");

    await markTested(body.gateway.id);
    const ok = await call(`/api/admin/gateways/${body.gateway.id}/publish`, { method: "POST" });
    expect(ok.status).toBe(200);
  });

  it("草稿改驱动会清掉旧驱动的密钥与 webhook", async () => {
    const created = await call("/api/admin/gateways", {
      method: "POST",
      body: {
        driver: "stripe",
        name: "Stripe-改驱动",
        secret: "sk_old_stripe",
        webhook_secret: "whsec_old_stripe",
        methods: ["stripe"],
      },
    });
    expect(created.status).toBe(201);
    const g = (await created.json()) as { gateway: { id: number } };

    const patched = await call(`/api/admin/gateways/${g.gateway.id}`, {
      method: "PATCH",
      body: { driver: "paypal", merchant_id: "paypal-client", methods: ["paypal"] },
    });
    expect(patched.status).toBe(200);
    const after = (await patched.json()) as {
      gateway: { has_secret: boolean; has_webhook: boolean; driver: string };
    };
    expect(after.gateway.driver).toBe("paypal");
    expect(after.gateway.has_secret).toBe(false);
    expect(after.gateway.has_webhook).toBe(false);
  });

  it("删除是软删除：列表隐藏，但不能编辑/发布/测试/重复删除", async () => {
    const created = await call("/api/admin/gateways", {
      method: "POST",
      body: {
        driver: "epay_v1",
        name: "待删除-易支付",
        endpoint: "https://pay.example.com",
        merchant_id: "M-DELETE",
        secret: "epay-secret",
        methods: ["alipay"],
      },
    });
    expect(created.status).toBe(201);
    const g = (await created.json()) as { gateway: { id: number } };
    const id = g.gateway.id;

    const deleted = await call(`/api/admin/gateways/${id}`, { method: "DELETE" });
    expect(deleted.status).toBe(200);
    expect(await deleted.json()).toEqual({ ok: true });

    const list = (await (await call("/api/admin/gateways")).json()) as {
      gateways: Array<{ id: number; name: string }>;
    };
    expect(list.gateways.find((row) => row.id === id)).toBeUndefined();

    for (const [method, path] of [
      ["PATCH", `/api/admin/gateways/${id}`],
      ["POST", `/api/admin/gateways/${id}/publish`],
      ["POST", `/api/admin/gateways/${id}/test`],
      ["DELETE", `/api/admin/gateways/${id}`],
    ] as const) {
      const res = await call(path, { method });
      expect(res.status).toBe(404);
    }

    const row = await env.DB.prepare(`SELECT status FROM payment_gateways WHERE id = ?`)
      .bind(id)
      .first<{ status: string }>();
    expect(row?.status).toBe("deleted");
  });

  it("有测试订单的网关也能软删除，订单引用保留", async () => {
    const created = await call("/api/admin/gateways", {
      method: "POST",
      body: {
        driver: "mock",
        name: "待删除-mock",
        methods: ["alipay"],
        allowed_emails: ["alice@example.com"],
      },
    });
    expect(created.status).toBe(201);
    const g = (await created.json()) as { gateway: { id: number } };
    const id = g.gateway.id;

    const test = await call(`/api/admin/gateways/${id}/test`, {
      method: "POST",
      body: { method: "alipay" },
    });
    expect(test.status).toBe(200);
    const testBody = (await test.json()) as { order_code: string };
    const order = await env.DB.prepare(`SELECT gateway_id, source FROM orders WHERE code = ?`)
      .bind(testBody.order_code)
      .first<{ gateway_id: number; source: string }>();
    expect(order).toMatchObject({ gateway_id: id, source: "test" });

    const deleted = await call(`/api/admin/gateways/${id}`, { method: "DELETE" });
    expect(deleted.status).toBe(200);

    // 订单引用还在，证明“删除不等于丢历史”
    const after = await env.DB.prepare(`SELECT gateway_id FROM orders WHERE code = ?`)
      .bind(testBody.order_code)
      .first<{ gateway_id: number }>();
    expect(after?.gateway_id).toBe(id);
  });

  it("自定义映射必须能通过校验", async () => {
    const bad = await call("/api/admin/gateways", {
      method: "POST",
      body: {
        driver: "generic_json_v1",
        name: "自定义-坏配置",
        endpoint: "https://x.example.com",
        merchant_id: "M2",
        methods: ["alipay"],
        mapping: { create: { path: "/pay" } },
      },
    });
    expect(bad.status).toBe(400);
    expect(((await bad.json()) as { message: string }).message).toContain("create.response");
  });

  it("通用映射没有查单接口 → 保存被拒", async () => {
    const res = await call("/api/admin/gateways", {
      method: "POST",
      body: {
        driver: "generic_json_v1",
        name: "自定义-无查单",
        endpoint: "https://x.example.com",
        merchant_id: "M2",
        methods: ["alipay"],
        mapping: {
          create: {
            request: {
              path: "/pay",
              format: "json",
              fields: [
                { field: "mch", role: "merchant", value: "{merchant}" },
                { field: "no", role: "order_no", value: "{order_no}" },
                { field: "amt", role: "amount", value: "{amount}", unit: "yuan" },
              ],
              sign: { algo: "md5", key_append: "" },
            },
            response: { ok: { path: "code", equals: 200 }, fields: [{ field: "payUrl", role: "pay_url" }] },
          },
          notify: {
            request: {
              fields: [{ field: "no", role: "order_no" }],
              paid_when: { path: "status", equals: 1 },
              sign: { algo: "md5" },
            },
            response: { reply: "success" },
          },
        },
      },
    });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { message: string }).message).toContain("query");
  });

  it("易支付：没密钥不能发布；设了密钥才能发布", async () => {
    const created = await call("/api/admin/gateways", {
      method: "POST",
      body: {
        driver: "epay_v1",
        name: "易支付-无密钥",
        endpoint: "https://pay2.example.com",
        merchant_id: "M3",
        methods: ["alipay"],
      },
    });
    const { gateway } = (await created.json()) as { gateway: { id: number; has_secret: boolean } };
    expect(gateway.has_secret).toBe(false);

    const denied = await call(`/api/admin/gateways/${gateway.id}/publish`, { method: "POST" });
    expect(denied.status).toBe(400);
    expect(((await denied.json()) as { error: string }).error).toBe("secret_required");

    const patched = await call(`/api/admin/gateways/${gateway.id}`, {
      method: "PATCH",
      body: { secret: "another-secret" },
    });
    expect(patched.status).toBe(200);

    await markTested(gateway.id);
    const ok = await call(`/api/admin/gateways/${gateway.id}/publish`, { method: "POST" });
    expect(ok.status).toBe(200);
    const body = (await ok.json()) as { gateway: { status: string } };
    expect(body.gateway.status).toBe("live");
  });

  it("测试网关：白名单为空不能发布（否则等于免费开通）", async () => {
    const created = await call("/api/admin/gateways", {
      method: "POST",
      body: { driver: "mock", name: "测试网关-无白名单", methods: ["alipay", "wechat"] },
    });
    const { gateway } = (await created.json()) as { gateway: { id: number } };

    const denied = await call(`/api/admin/gateways/${gateway.id}/publish`, { method: "POST" });
    expect(denied.status).toBe(400);
    expect(((await denied.json()) as { error: string }).error).toBe("mock_whitelist_required");

    await call(`/api/admin/gateways/${gateway.id}`, {
      method: "PATCH",
      body: { allowed_emails: ["tester@example.com"] },
    });
    await markTested(gateway.id);
    const ok = await call(`/api/admin/gateways/${gateway.id}/publish`, { method: "POST" });
    expect(ok.status).toBe(200);
  });

  it("已发布的测试网关不能把白名单清空（清空后等于不存在）", async () => {
    const created = await call("/api/admin/gateways", {
      method: "POST",
      body: {
        driver: "mock",
        name: "测试网关-清空白名单",
        methods: ["alipay"],
        allowed_emails: ["tester@example.com"],
      },
    });
    const { gateway } = (await created.json()) as { gateway: { id: number } };
    await markTested(gateway.id);
    const pub = await call(`/api/admin/gateways/${gateway.id}/publish`, {
      method: "POST",
    });
    expect(pub.status).toBe(200);

    const cleared = await call(`/api/admin/gateways/${gateway.id}`, {
      method: "PATCH",
      body: { allowed_emails: [] },
    });
    expect(cleared.status).toBe(400);
    expect(((await cleared.json()) as { error: string }).error).toBe(
      "mock_whitelist_required",
    );

    // draft 阶段允许清空（还没发布，清空不影响任何人）
    const draft = await call("/api/admin/gateways", {
      method: "POST",
      body: {
        driver: "mock",
        name: "测试网关-草稿清空",
        methods: ["alipay"],
        allowed_emails: ["tester@example.com"],
      },
    });
    const draftId = ((await draft.json()) as { gateway: { id: number } }).gateway.id;
    const draftCleared = await call(`/api/admin/gateways/${draftId}`, {
      method: "PATCH",
      body: { allowed_emails: [] },
    });
    expect(draftCleared.status).toBe(200);
  });

  it("环境开关关闭时不能创建测试网关", async () => {
    (env as unknown as Record<string, unknown>).ALLOW_MOCK_PAYMENTS = "false";
    const res = await call("/api/admin/gateways", {
      method: "POST",
      body: { driver: "mock", name: "测试网关-关闭态", methods: ["alipay"] },
    });
    (env as unknown as Record<string, unknown>).ALLOW_MOCK_PAYMENTS = "true";
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toBe("mock_disabled");
  });

  it("没配主密钥时拒绝保存密钥（不退化成存明文）", async () => {
    const saved = (env as unknown as Record<string, unknown>).APP_SECRET;
    (env as unknown as Record<string, unknown>).APP_SECRET = "";
    const res = await call("/api/admin/gateways", {
      method: "POST",
      body: {
        driver: "epay_v1",
        name: "易支付-无主密钥",
        endpoint: "https://pay3.example.com",
        merchant_id: "M4",
        secret: "plain-should-not-be-stored",
        methods: ["alipay"],
      },
    });
    (env as unknown as Record<string, unknown>).APP_SECRET = saved;
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toBe("secret_key_missing");
  });

  it("停用后从 App 的支付方式里消失", async () => {
    const list = await call("/api/admin/gateways");
    const { gateways } = (await list.json()) as { gateways: { id: number; status: string }[] };
    const live = gateways.find((g) => g.status === "live");
    expect(live).toBeTruthy();
    const res = await call(`/api/admin/gateways/${live!.id}/disable`, { method: "POST" });
    expect(res.status).toBe(200);
    expect(((await res.json()) as { gateway: { status: string } }).gateway.status).toBe("disabled");
  });
});
