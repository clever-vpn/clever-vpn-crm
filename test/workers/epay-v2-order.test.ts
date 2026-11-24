import { beforeAll, describe, expect, it } from "vitest";

import { createCharge } from "../../src/payments/checkout";
import { handlePayNotify } from "../../src/payments/notify";
import { pollOrderOnce } from "../../src/payments/poll";
import { encryptSecret } from "../../src/payments/secret";
import {
  importRsaPrivateKey,
  importRsaPublicKey,
  rsaSignBase64,
  rsaVerifyBase64,
} from "../../src/payments/drivers/rsa";
import { env } from "./apply-migrations";

import type { Plan } from "../../src/plans/model";

const NOW = new Date("2026-11-23T10:00:00Z");
const KEY = "epay-v2-test-key";

function b64(bytes: ArrayBuffer): string {
  const arr = new Uint8Array(bytes);
  let s = "";
  for (const b of arr) s += String.fromCharCode(b);
  return btoa(s);
}

function pem(bytes: ArrayBuffer, type: "PRIVATE KEY" | "PUBLIC KEY"): string {
  const body = b64(bytes).replace(/(.{64})/g, "$1\n").trim();
  return `-----BEGIN ${type}-----\n${body}\n-----END ${type}-----`;
}

function canonical(params: Record<string, unknown>): string {
  return Object.keys(params)
    .filter((k) => k !== "sign" && k !== "sign_type" && String(params[k] ?? "") !== "")
    .sort()
    .map((k) => `${k}=${String(params[k])}`)
    .join("&");
}

async function signed(fields: Record<string, unknown>, privateKey: CryptoKey): Promise<Record<string, unknown>> {
  const withTs = { ...fields, timestamp: String(Math.floor(NOW.getTime() / 1000)) };
  return { ...withTs, sign: await rsaSignBase64(privateKey, canonical(withTs)), sign_type: "RSA" };
}

let merchantPublic: CryptoKey;
let platformPrivate: CryptoKey;
let secretEnc: string | null = null;
let gatewayId = 0;

function plan(): Plan {
  return {
    id: "__epay_v2_test__",
    name: "易支付V2测试",
    kind: "period",
    price_minor: 1500,
    currency: "CNY",
    licence_limit: 1,
    term_days: 30,
    monthly_quota_gb: 100,
    traffic_gb: null,
    validity_days: null,
    line_ids: [],
    up_mbps: null,
    down_mbps: null,
    sales_channels: [{ channel: "web_checkout", methods: ["alipay"] }],
    store_product_id: {},
    sort_order: 0,
    status: "active",
    visibility: "public",
    retired_at: null,
    trial: false,
  };
}

beforeAll(async () => {
  (env as unknown as Record<string, unknown>).APP_SECRET = "epay-v2-test-master";
  const merchant = (await crypto.subtle.generateKey(
    { name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" },
    true,
    ["sign", "verify"],
  )) as CryptoKeyPair;
  const platform = (await crypto.subtle.generateKey(
    { name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" },
    true,
    ["sign", "verify"],
  )) as CryptoKeyPair;
  merchantPublic = merchant.publicKey;
  platformPrivate = platform.privateKey;
  const merchantPrivPem = pem(
    (await crypto.subtle.exportKey("pkcs8", merchant.privateKey)) as ArrayBuffer,
    "PRIVATE KEY",
  );
  const platformPubPem = pem(
    (await crypto.subtle.exportKey("spki", platform.publicKey)) as ArrayBuffer,
    "PUBLIC KEY",
  );
  secretEnc = await encryptSecret(
    env,
    JSON.stringify({ merchant_private_key: merchantPrivPem, platform_public_key: platformPubPem }),
  );
  const res = await env.DB.prepare(
    `INSERT INTO payment_gateways (driver, name, endpoint, merchant_id, secret_enc, methods,
       mapping, priority, status, currency, allowed_emails, created_at, updated_at)
     VALUES ('epay_v2', '易支付V2', 'https://pay.test/xpay/epayn', '10001', ?, '["alipay"]',
       NULL, 100, 'draft', 'CNY', NULL, ?, ?)`,
  )
    .bind(secretEnc, NOW.toISOString(), NOW.toISOString())
    .run();
  gatewayId = Number(res.meta.last_row_id ?? 0);
});

function createFetch(): typeof fetch {
  return (async (_input: RequestInfo | URL, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
    const ok = await rsaVerifyBase64(merchantPublic, canonical(body), String(body.sign ?? ""));
    if (!ok) return new Response("bad sign", { status: 400 });
    return new Response(
      JSON.stringify(await signed({ code: 0, msg: "ok", trade_no: "P-V2-1", pay_type: "jump", pay_info: "https://pay.test/cashier/1" }, platformPrivate)),
      { status: 200 },
    );
  }) as typeof fetch;
}

function queryFetch(): typeof fetch {
  return (async () =>
    new Response(
      JSON.stringify(await signed({ code: 0, trade_no: "P-V2-1", status: 2, money: "15.00" }, platformPrivate)),
      { status: 200 },
    )) as typeof fetch;
}

describe("易支付 V2：createCharge/poll/notify", () => {
  it("创建订单：请求签名 + 平台响应验签", async () => {
    const res = await createCharge(env, {
      customerId: 0,
      customerEmail: "ops@test.com",
      plan: plan(),
      method: "alipay",
      amountMinor: 1500,
      entry: "admin",
      origin: "https://crm.test",
      testGatewayId: gatewayId,
      fetch: createFetch(),
      now: NOW,
    });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.payUrl).toBe("https://pay.test/cashier/1");
    const row = await env.DB.prepare(`SELECT provider_trade_no, status FROM orders WHERE code = ?`)
      .bind(res.orderCode)
      .first<{ provider_trade_no: string; status: string }>();
    expect(row).toMatchObject({ provider_trade_no: "P-V2-1", status: "pending" });

    const out = await pollOrderOnce(env, res.orderCode, { fetch: queryFetch(), now: NOW });
    expect(out?.verdict).toBe("paid");
    const after = await env.DB.prepare(`SELECT status FROM orders WHERE code = ?`)
      .bind(res.orderCode)
      .first<{ status: string }>();
    expect(after?.status).toBe("paid");
  });

  it("回调：平台公钥验签 → 触发查单 → success", async () => {
    const created = await createCharge(env, {
      customerId: 0,
      customerEmail: "ops@test.com",
      plan: plan(),
      method: "alipay",
      amountMinor: 1500,
      entry: "admin",
      origin: "https://crm.test",
      testGatewayId: gatewayId,
      fetch: createFetch(),
      now: NOW,
    });
    if (!created.ok) throw new Error(created.message);

    const params: Record<string, unknown> = {
      pid: "10001",
      out_trade_no: created.orderCode,
      trade_no: "P-V2-1",
      trade_status: "TRADE_SUCCESS",
      money: "15.00",
      timestamp: "1",
    };
    const sign = await rsaSignBase64(platformPrivate, canonical(params));
    const qs = new URLSearchParams({ ...Object.fromEntries(Object.entries(params).map(([k, v]) => [k, String(v)])), sign, sign_type: "RSA" });
    const res = await handlePayNotify(
      env,
      new Request(`https://crm.test/api/pay/notify/${gatewayId}?${qs.toString()}`),
      String(gatewayId),
      { now: NOW, refresh: (code) => pollOrderOnce(env, code, { fetch: queryFetch(), now: NOW }) },
    );
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("success");
    const after = await env.DB.prepare(`SELECT status FROM orders WHERE code = ?`)
      .bind(created.orderCode)
      .first<{ status: string }>();
    expect(after?.status).toBe("paid");
  });
});
