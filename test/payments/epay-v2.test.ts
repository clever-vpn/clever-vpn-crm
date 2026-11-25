import { beforeAll, describe, expect, it } from "vitest";

import { createEpayV2, queryEpayV2, verifyEpayV2Notify } from "../../src/payments/drivers/epay-v2";
import {
  importRsaPrivateKey,
  importRsaPublicKey,
  rsaSignBase64,
  rsaVerifyBase64,
} from "../../src/payments/drivers/rsa";

import type { Env } from "../../src/env";
import type { GatewayRow } from "../../src/payments/gateways";

const KEY = "merchant-key";

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

let merchantPrivatePem = "";
let merchantPublic: CryptoKey;
let platformPrivate: CryptoKey;
let platformPublicPem = "";
let secret = "";

interface Generated {
  privateKey: CryptoKey;
  publicKey: CryptoKey;
  privatePem: string;
  publicPem: string;
}

async function generate(): Promise<Generated> {
  const pair = (await crypto.subtle.generateKey(
    {
      name: "RSASSA-PKCS1-v1_5",
      modulusLength: 2048,
      publicExponent: new Uint8Array([1, 0, 1]),
      hash: "SHA-256",
    },
    true,
    ["sign", "verify"],
  )) as CryptoKeyPair;
  const priv = (await crypto.subtle.exportKey("pkcs8", pair.privateKey)) as ArrayBuffer;
  const pub = (await crypto.subtle.exportKey("spki", pair.publicKey)) as ArrayBuffer;
  return {
    privateKey: pair.privateKey,
    publicKey: pair.publicKey,
    privatePem: pem(priv, "PRIVATE KEY"),
    publicPem: pem(pub, "PUBLIC KEY"),
  };
}

function gateway(): GatewayRow {
  return {
    id: 1,
    driver: "epay_v2",
    name: "易支付V2",
    endpoint: "https://pay.test/xpay/epayn",
    paypal_env: null,
    merchant_id: "10001",
    secret_enc: null,
    webhook_enc: null,
    methods: '["alipay","wechat"]',
    channel_codes: null,
    mapping: null,
    priority: 100,
    status: "live",
    currency: "CNY",
    fx_rate: 1,
    test_amount_minor: 100,
    test_create_ok_at: null,
    test_query_ok_at: null,
    test_callback_ok_at: null,
    tested_config_hash: null,
    test_require_callback: 0,
    allowed_emails: null,
    last_test_order_id: null,
    last_ok_at: null,
    last_error: null,
  };
}

const env = {} as Env;

function signedResponse(
  fields: Record<string, unknown>,
  platformPrivateKey: CryptoKey,
): Promise<Record<string, unknown>> {
  return (async () => {
    const withTs = { ...fields, timestamp: String(Math.floor(Date.now() / 1000)) };
    return {
      ...withTs,
      sign: await rsaSignBase64(platformPrivateKey, canonical(withTs)),
      sign_type: "RSA",
    };
  })();
}

beforeAll(async () => {
  const merchant = await generate();
  const platform = await generate();
  merchantPrivatePem = merchant.privatePem;
  merchantPublic = merchant.publicKey;
  platformPrivate = platform.privateKey;
  platformPublicPem = platform.publicPem;
  secret = JSON.stringify({
    merchant_private_key: merchantPrivatePem,
    platform_public_key: platformPublicPem,
  });
});

describe("易支付 V2：RSA 双向签名 driver", () => {
  it("创建：请求用商户私钥签名；响应用平台公钥验签", async () => {
    let requestBody: Record<string, unknown> = {};
    const fake = (async (_input: RequestInfo | URL, init?: RequestInit) => {
      requestBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
      const ok = await rsaVerifyBase64(
        merchantPublic,
        canonical(requestBody),
        String(requestBody.sign ?? ""),
      );
      if (!ok) return new Response("bad sign", { status: 400 });
      const body = await signedResponse(
        {
          code: 0,
          msg: "ok",
          trade_no: "P1",
          pay_type: "jump",
          pay_info: "https://pay.test/cashier/1",
        },
        platformPrivate,
      );
      return new Response(JSON.stringify(body), { status: 200 });
    }) as typeof fetch;

    const res = await createEpayV2({
      gateway: gateway(),
      secret,
      merchantId: "10001",
      orderNo: "ORD-1",
      amountMinor: 1234,
      currency: "CNY",
      subject: "测试",
      successUrl: "https://crm.test/return",
      cancelUrl: "https://crm.test/cancel",
      notifyUrl: "https://crm.test/notify",
      paymentMethod: "wechat",
      env,
      fetch: fake,
    });
    expect(res).toMatchObject({ ok: true, payUrl: "https://pay.test/cashier/1", tradeNo: "P1" });
    expect(requestBody.type).toBe("wxpay");
    expect(requestBody.money).toBe("12.34");
    expect(requestBody.notify_url).toBe("https://crm.test/notify");
    expect(requestBody.sign_type).toBe("RSA");
  });

  it("创建：响应签名错 → 拒绝", async () => {
    const fake = (async () =>
      new Response(
        JSON.stringify({
          code: 0,
          msg: "ok",
          trade_no: "P1",
          pay_info: "https://pay.test/x",
          timestamp: "1",
          sign: "bad",
          sign_type: "RSA",
        }),
        { status: 200 },
      )) as typeof fetch;
    const res = await createEpayV2({
      gateway: gateway(),
      secret,
      merchantId: "10001",
      orderNo: "ORD-1",
      amountMinor: 1234,
      currency: "CNY",
      subject: "测试",
      successUrl: "https://crm.test/return",
      cancelUrl: "https://crm.test/cancel",
      notifyUrl: "https://crm.test/notify",
      paymentMethod: "alipay",
      env,
      fetch: fake,
    });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.message).toContain("响应签名");
  });

  it("查单：trade_no + 平台签名，status=2 已付", async () => {
    let requestBody: Record<string, unknown> = {};
    const fake = (async (_input: RequestInfo | URL, init?: RequestInit) => {
      requestBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
      const body = await signedResponse(
        { code: 0, trade_no: "P1", status: 2, money: "12.34" },
        platformPrivate,
      );
      return new Response(JSON.stringify(body), { status: 200 });
    }) as typeof fetch;

    const res = await queryEpayV2({
      gateway: gateway(),
      secret,
      merchantId: "10001",
      providerTradeNo: "P1",
      amountMinor: 1234,
      currency: "CNY",
      env,
      fetch: fake,
    });
    expect(res).toMatchObject({ status: "paid", amountMinor: 1234, tradeNo: "P1" });
    expect(requestBody.trade_no).toBe("P1");
    expect(requestBody.pid).toBe("10001");
  });

  it("回调：平台公钥验签；改字段失败", async () => {
    const params: Record<string, unknown> = {
      pid: "10001",
      out_trade_no: "ORD-1",
      trade_no: "P1",
      trade_status: "TRADE_SUCCESS",
      money: "12.34",
      timestamp: "1",
    };
    const sign = await rsaSignBase64(platformPrivate, canonical(params));
    expect(await verifyEpayV2Notify({ ...params, sign, sign_type: "RSA" }, secret)).toBe(true);
    expect(await verifyEpayV2Notify({ ...params, money: "0.01", sign, sign_type: "RSA" }, secret)).toBe(false);
  });

  it("无效密钥 JSON → 不发起请求", async () => {
    const res = await createEpayV2({
      gateway: gateway(),
      secret: "{bad",
      merchantId: "10001",
      orderNo: "ORD-1",
      amountMinor: 1234,
      currency: "CNY",
      subject: "测试",
      successUrl: "https://crm.test/return",
      cancelUrl: "https://crm.test/cancel",
      notifyUrl: "https://crm.test/notify",
      paymentMethod: "alipay",
      env,
    });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.message).toContain("密钥 JSON");
  });
});
