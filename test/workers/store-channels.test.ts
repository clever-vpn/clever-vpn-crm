/**
 * 商店渠道（`/api/admin/store-channels`）
 *
 * 钉住四条：
 *   1. 每平台最多一行（重复 PUT 是更新，不是新建）；
 *   2. 凭据只进不出 —— 响应里永远没有 `secret_enc`，只有 `has_secret`；
 *   3. 凭据形状在保存时就校验（p8 / service account），不等到第一次查单才炸；
 *   4. 沙盒环境只允许在非生产实例配置。
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

const APPLE_SECRET = JSON.stringify({
  p8: "-----BEGIN PRIVATE KEY-----\nMIGT...\n-----END PRIVATE KEY-----",
  issuer_id: "issuer-123",
  key_id: "KEY123",
});

beforeAll(async () => {
  // CI 没有 `.dev.vars`：没有主密钥就存不了凭据。这里给一把测试用的。
  (env as unknown as Record<string, unknown>).PAYMENT_SECRET_KEY = "test-secret-key";
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
});

interface ChannelView {
  platform: string;
  endpoint: string;
  identifier: string;
  environment: string;
  status: string;
  has_secret: boolean;
}

describe("商店渠道配置", () => {
  it("未配置时两个平台都在，端点给默认值", async () => {
    const res = await call("/api/admin/store-channels");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { channels: ChannelView[] };
    expect(body.channels.map((c) => c.platform)).toEqual(["apple", "google"]);
    const apple = body.channels.find((c) => c.platform === "apple")!;
    expect(apple.endpoint).toBe("https://api.storekit.itunes.apple.com");
    expect(apple.status).toBe("unset");
    expect(apple.has_secret).toBe(false);
  });

  it("保存 Apple 凭据：不回显密钥，重复保存是更新不是新建", async () => {
    const saved = await call("/api/admin/store-channels/apple", {
      method: "PUT",
      body: {
        identifier: "org.clevervpn.android",
        secret: APPLE_SECRET,
        status: "draft",
      },
    });
    expect(saved.status).toBe(200);
    const body = (await saved.json()) as { channel: ChannelView };
    expect(body.channel.has_secret).toBe(true);
    expect(JSON.stringify(body)).not.toContain("BEGIN PRIVATE KEY");

    const again = await call("/api/admin/store-channels/apple", {
      method: "PUT",
      body: { identifier: "org.clevervpn.android", status: "live" },
    });
    expect(again.status).toBe(200);
    expect(((await again.json()) as { channel: ChannelView }).channel.status).toBe("live");

    const rows = await env.DB.prepare(
      `SELECT COUNT(*) AS n FROM store_channels WHERE platform = 'apple'`,
    ).first<{ n: number }>();
    expect(Number(rows?.n ?? 0)).toBe(1);
  });

  it("凭据形状不对在保存时就拒（不等到查单）", async () => {
    const res = await call("/api/admin/store-channels/google", {
      method: "PUT",
      body: { identifier: "org.clevervpn.android", secret: '{"client_email":"nope"}' },
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("invalid_secret");
  });

  it("生产实例不能配沙盒环境", async () => {
    (env as unknown as Record<string, unknown>).ENVIRONMENT = "production";
    const res = await call("/api/admin/store-channels/google", {
      method: "PUT",
      body: { identifier: "org.clevervpn.android", environment: "sandbox" },
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("sandbox_not_allowed");
    (env as unknown as Record<string, unknown>).ENVIRONMENT = "development";
  });
});
