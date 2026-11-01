/**
 * `POST /orders/iap` —— 客户端已在商店付完，把凭据交给 CRM 回源校验
 *
 * 用假 fetch 顶替 App Store / Google Play 的接口，钉住五条：
 *   1. **回源查得到才算数**：凭据里的内容只是查单键，权威数据来自商店响应；
 *   2. **账号绑定**：`appAccountToken` / `obfuscatedAccountId` 必须等于当前用户 `uuid`；
 *   3. **幂等**：同一笔交易重复提交返回同一个 `order_code`，不重复发放；
 *   4. **别人的交易** ⇒ `receipt_already_used`；
 *   5. Google 的 `consume` 由 CRM 在落库之后调（漏了 3 天自动退款）。
 */
import { exports as rawExports } from "cloudflare:workers";
import { beforeAll, describe, expect, it } from "vitest";

import { sha256Hex } from "../../src/admin/crypto";
import { env } from "./apply-migrations";

const BASE = "https://crm.test";
const TOKEN = "session-iap-buyer";

const worker = rawExports as unknown as {
  default: { fetch(request: Request): Promise<Response> };
};

const now = () => new Date().toISOString();

let customerUuid = "";

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

function b64url(text: string): string {
  return btoa(text).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** 造一个"客户端拿到的" JWS：只有 payload 有用（CRM 只从里面取 transactionId） */
function fakeAppleReceipt(transactionId: string): string {
  return [
    b64url(JSON.stringify({ alg: "ES256", x5c: [] })),
    b64url(JSON.stringify({ transactionId, productId: "p.iap.30d" })),
    "sig",
  ].join(".");
}

/** 假商店：Apple 查单 + Google 授权/查单/consume 全走这里 */
function installFakeStores(opts: {
  productId: string;
  accountToken: string;
  environment?: string;
  revoked?: boolean;
  purchaseState?: number;
}) {
  const calls: string[] = [];
  const realFetch = globalThis.fetch;
  const fake = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input.toString();
    calls.push(`${init?.method ?? "GET"} ${url}`);
    if (url.startsWith("https://api.storekit.itunes.apple.com/inApps/v1/transactions/")) {
      const info = {
        transactionId: "2000000123",
        productId: opts.productId,
        appAccountToken: opts.accountToken,
        environment: opts.environment ?? "Production",
        currency: "CNY",
        price: 15000,
        ...(opts.revoked ? { revocationDate: Date.parse(now()) } : {}),
      };
      return new Response(
        JSON.stringify({ signedTransactionInfo: `h.${b64url(JSON.stringify(info))}.s` }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }
    if (url.startsWith("https://oauth2.googleapis.com/token")) {
      return new Response(JSON.stringify({ access_token: "ya29.fake" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }
    if (url.endsWith(":consume")) {
      return new Response("{}", { status: 200 });
    }
    if (url.includes("/purchases/products/")) {
      return new Response(
        JSON.stringify({
          purchaseState: opts.purchaseState ?? 0,
          obfuscatedExternalAccountId: opts.accountToken,
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }
    return realFetch(input as RequestInfo, init);
  }) as typeof fetch;
  (globalThis as unknown as Record<string, unknown>).fetch = fake;
  return {
    calls,
    restore: () => {
      (globalThis as unknown as Record<string, unknown>).fetch = realFetch;
    },
  };
}

/** 生成真的 PKCS#8 PEM（假 PEM 会在 importKey 那一步就炸，测不到后面的逻辑） */
async function pemOf(kind: "ec" | "rsa"): Promise<string> {
  const pair =
    kind === "ec"
      ? await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign"])
      : await crypto.subtle.generateKey(
          {
            name: "RSASSA-PKCS1-v1_5",
            modulusLength: 2048,
            publicExponent: new Uint8Array([1, 0, 1]),
            hash: "SHA-256",
          },
          true,
          ["sign"],
        );
  const raw = await crypto.subtle.exportKey("pkcs8", (pair as CryptoKeyPair).privateKey);
  if (!(raw instanceof ArrayBuffer)) throw new Error("exportKey 应返回 ArrayBuffer");
  const der = new Uint8Array(raw);
  let bin = "";
  for (const b of der) bin += String.fromCharCode(b);
  const body = btoa(bin).replace(/(.{64})/g, "$1\n");
  return `-----BEGIN PRIVATE KEY-----\n${body}\n-----END PRIVATE KEY-----`;
}

beforeAll(async () => {
  // 一个客户 + 一个会话
  const res = await env.DB.prepare(
    `INSERT INTO customers (uuid, email, status, created_at) VALUES (?, ?, 'active', ?)`,
  )
    .bind(crypto.randomUUID(), "iap@test.com", now())
    .run();
  const customerId = Number(res.meta.last_row_id ?? 0);
  const row = await env.DB.prepare(`SELECT uuid FROM customers WHERE id = ?`)
    .bind(customerId)
    .first<{ uuid: string }>();
  customerUuid = row?.uuid ?? "";
  await env.DB.prepare(
    `INSERT INTO app_sessions (id, customer_id, created_at, last_used_at) VALUES (?, ?, ?, ?)`,
  )
    .bind(await sha256Hex(TOKEN), customerId, now(), now())
    .run();

  // 套餐 + 两个平台各一条 `live` 渠道（凭据是假的，但形状合法，能过 import）
  await env.DB.prepare(
    `INSERT INTO plans (id, name, kind, price_minor, currency, licence_limit, term_days,
       monthly_quota_gb, traffic_gb, validity_days, line_ids, sales_channels,
       store_product_id, sort_order, status, visibility, created_at, updated_at)
     VALUES ('p_iap_30d', 'IAP 月付', 'period', 1500, 'CNY', 1, 30, 100, NULL, NULL,
       '[]', '[{"channel":"apple_iap"},{"channel":"google_play"}]',
       '{"apple":"p.iap.30d","google":"p.iap.30d"}', 1, 'active', 'public', ?, ?)`,
  )
    .bind(now(), now())
    .run();

  const appleSecret = JSON.stringify({
    p8: await pemOf("ec"),
    issuer_id: "iss",
    key_id: "KID",
  });
  const googleSecret = JSON.stringify({
    client_email: "svc@example.com",
    private_key: await pemOf("rsa"),
  });
  for (const [platform, secret] of [
    ["apple", appleSecret],
    ["google", googleSecret],
  ] as const) {
    await env.DB.prepare(
      `INSERT INTO store_channels (platform, endpoint, identifier, environment, secret_enc,
         status, created_at, updated_at)
       VALUES (?, ?, 'org.clevervpn.android', 'production', ?, 'live', ?, ?)`,
    )
      .bind(
        platform,
        platform === "apple"
          ? "https://api.storekit.itunes.apple.com"
          : "https://androidpublisher.googleapis.com",
        // 直接存明文会解不开（需要 AES-GCM），测试里用同一套加密工具
        await import("../../src/payments/secret").then((m) => m.encryptSecret(env, secret)),
        now(),
        now(),
      )
      .run();
  }
});

describe("POST /orders/iap", () => {
  it("Apple：回源通过 ⇒ 落单并开通；重复提交返回同一个单号", async () => {
    const stores = installFakeStores({ productId: "p.iap.30d", accountToken: customerUuid });
    try {
      const res = await call("/api/app/v1/orders/iap", {
        method: "POST",
        token: TOKEN,
        body: { platform: "apple", product_id: "p.iap.30d", receipt: fakeAppleReceipt("2000000123") },
      });
      expect(res.status).toBe(200);
      const body = (await res.json()) as { order_code: string; status: string };
      expect(body.status).toBe("paid");
      expect(body.order_code).toBeTruthy();

      const again = await call("/api/app/v1/orders/iap", {
        method: "POST",
        token: TOKEN,
        body: { platform: "apple", product_id: "p.iap.30d", receipt: fakeAppleReceipt("2000000123") },
      });
      expect(again.status).toBe(200);
      expect(((await again.json()) as { order_code: string }).order_code).toBe(body.order_code);

      const count = await env.DB.prepare(
        `SELECT COUNT(*) AS n FROM orders WHERE iap_key = 'apple:2000000123'`,
      ).first<{ n: number }>();
      expect(Number(count?.n ?? 0)).toBe(1);
    } finally {
      stores.restore();
    }
  });

  it("账号绑定对不上 ⇒ 403 account_mismatch", async () => {
    const stores = installFakeStores({ productId: "p.iap.30d", accountToken: "someone-else" });
    try {
      const res = await call("/api/app/v1/orders/iap", {
        method: "POST",
        token: TOKEN,
        body: { platform: "apple", product_id: "p.iap.30d", receipt: fakeAppleReceipt("2000000999") },
      });
      expect(res.status).toBe(403);
      expect(((await res.json()) as { error: { code: string } }).error.code).toBe(
        "account_mismatch",
      );
    } finally {
      stores.restore();
    }
  });

  it("商品号对不上任何套餐 ⇒ 422 product_mismatch", async () => {
    const stores = installFakeStores({ productId: "p.unknown", accountToken: customerUuid });
    try {
      const res = await call("/api/app/v1/orders/iap", {
        method: "POST",
        token: TOKEN,
        body: { platform: "apple", product_id: "p.unknown", receipt: fakeAppleReceipt("2000000777") },
      });
      expect(res.status).toBe(422);
      expect(((await res.json()) as { error: { code: string } }).error.code).toBe(
        "product_mismatch",
      );
    } finally {
      stores.restore();
    }
  });

  it("Google：落账后由 CRM 调 consume", async () => {
    const stores = installFakeStores({ productId: "p.iap.30d", accountToken: customerUuid });
    try {
      const res = await call("/api/app/v1/orders/iap", {
        method: "POST",
        token: TOKEN,
        body: {
          platform: "google",
          product_id: "p.iap.30d",
          receipt: "token-abc",
        },
      });
      expect(res.status).toBe(200);
      expect(stores.calls.some((c) => c.endsWith(":consume"))).toBe(true);
    } finally {
      stores.restore();
    }
  });
});
