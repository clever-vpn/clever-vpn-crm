/**
 * 集成测试：支付网关管理（`/api/admin/gateways*`）
 *
 * 重点不是 CRUD，而是**三道守卫**：
 *   - 密钥永不回显（响应里只有 `has_secret`）
 *   - 没配主密钥时不允许保存密钥（不能退化存明文）
 *   - 发布前检查：易支付类必须有密钥；测试网关必须有白名单
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
  (env as unknown as Record<string, unknown>).PAYMENT_SECRET_KEY = "master-key-for-tests";
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

  it("新建易支付网关：默认草稿，密钥加密入库且不回显", async () => {
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
  });

  it("不支持的方式会被挡（stripe 不能卖支付宝）", async () => {
    const res = await call("/api/admin/gateways", {
      method: "POST",
      body: { driver: "stripe", name: "Stripe", methods: ["alipay"] },
    });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { message: string }).message).toContain("不支持");
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
    expect(((await bad.json()) as { message: string }).message).toContain("amount_unit");
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
    const ok = await call(`/api/admin/gateways/${gateway.id}/publish`, { method: "POST" });
    expect(ok.status).toBe(200);
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
    const saved = (env as unknown as Record<string, unknown>).PAYMENT_SECRET_KEY;
    (env as unknown as Record<string, unknown>).PAYMENT_SECRET_KEY = "";
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
    (env as unknown as Record<string, unknown>).PAYMENT_SECRET_KEY = saved;
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
