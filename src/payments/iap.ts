/**
 * 商店内购（App Store / Google Play）—— **只查单，不能下单**
 *
 * 契约 §2.4.3：客户端在商店完成购买后把凭据交给 CRM，CRM **回源查询**确认，
 * 然后走与网页轨道**完全相同**的 `settlePaidOrder()`。
 *
 * 三条不可协商：
 *   1. **凭据是不可信输入**。我们只从里面取一个"查单键"（Apple 的 `transactionId`、
 *      Google 的 `purchaseToken`），其余一切以回源结果为准 —— 不验签也不信签名，
 *      因为权威数据来自 Apple/Google 的 HTTPS 响应，而不是这段 base64。
 *   2. **幂等键 = `<platform>:<事务号>`**（`orders.iap_key` 唯一）。凭据重发只会返回
 *      同一个 `order_code`，不会重复发放。
 *   3. **收尾分工**：Apple 由**客户端** `finish()`（拿到 `paid` 之后）；
 *      Google 的 `consume` 由 **CRM 服务端**在落库之后做 —— 漏了 3 天自动退款。
 */
import { encryptSecret as _unusedEncrypt } from "./secret"; // 保持与网关同一套加密模块的引用位
import type { Env } from "../env";

void _unusedEncrypt;

export type IapPlatform = "apple" | "google";

export interface StoreSecret {
  /** apple */
  p8?: string;
  issuer_id?: string;
  key_id?: string;
  /** google（服务账号 JSON 原样） */
  client_email?: string;
  private_key?: string;
}

export interface StoreChannelConfig {
  platform: IapPlatform;
  endpoint: string;
  identifier: string;
  environment: string;
  secret: StoreSecret;
}

/** 回源之后的归一化结果 —— 后面所有判断都基于它，不基于凭据 */
export interface VerifiedPurchase {
  /** 商店事务号（Apple 的 transactionId / Google 的 purchaseToken 派生键） */
  transactionId: string;
  productId: string;
  /** Apple `appAccountToken` / Google `obfuscatedAccountId`，已小写 */
  accountToken: string | null;
  environment: "production" | "sandbox";
  revoked: boolean;
  /** 实收（最小单位整数）；商店没给时为 null，用套餐价兜底 */
  amountMinor: number | null;
  currency: string | null;
  /** 原始响应，落 `orders.raw_create`（排障唯一证据） */
  raw: string;
}

export type VerifyResult =
  | { ok: true; purchase: VerifiedPurchase }
  | { ok: false; code: string; message: string };

// ────────────────────────── 公共小工具 ──────────────────────────

function b64url(bytes: Uint8Array): string {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function b64urlEncode(text: string): string {
  return b64url(new TextEncoder().encode(text));
}

function b64urlDecode(text: string): Uint8Array {
  const pad = text.length % 4 === 0 ? "" : "=".repeat(4 - (text.length % 4));
  const raw = atob(text.replace(/-/g, "+").replace(/_/g, "/") + pad);
  const out = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i += 1) out[i] = raw.charCodeAt(i);
  return out;
}

/** PEM → DER（`importKey` 要的是二进制） */
function pemToDer(pem: string): Uint8Array {
  const body = pem
    .replace(/-----BEGIN [^-]+-----/g, "")
    .replace(/-----END [^-]+-----/g, "")
    .replace(/\s+/g, "");
  const raw = atob(body);
  const out = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i += 1) out[i] = raw.charCodeAt(i);
  return out;
}

/** 解出 JWS 的 payload（**不验签**：只用它取查单键，权威数据回源拿） */
export function decodeJwsPayload(jws: string): Record<string, unknown> | null {
  const parts = jws.split(".");
  if (parts.length < 2) return null;
  try {
    const payload = parts[1] ?? "";
    return JSON.parse(new TextDecoder().decode(b64urlDecode(payload))) as Record<
      string,
      unknown
    >;
  } catch {
    return null;
  }
}

// ────────────────────────── Apple ──────────────────────────

interface AppleTransactionPayload {
  transactionId?: string;
  productId?: string;
  appAccountToken?: string;
  environment?: string;
  revocationDate?: number;
  currency?: string;
  /** 毫单位（1/1000） */
  price?: number;
}

/** App Store Server API 的 JWT（ES256，用 `.p8` 签） */
async function appleJwt(secret: StoreSecret, bundleId: string, now: Date): Promise<string> {
  const key = await crypto.subtle.importKey(
    "pkcs8",
    pemToDer(secret.p8 ?? ""),
    { name: "ECDSA", namedCurve: "P-256" },
    false,
    ["sign"],
  );
  const iat = Math.floor(now.getTime() / 1000);
  const header = b64urlEncode(JSON.stringify({ alg: "ES256", kid: secret.key_id, typ: "JWT" }));
  const payload = b64urlEncode(
    JSON.stringify({
      iss: secret.issuer_id,
      iat,
      exp: iat + 300,
      aud: "appstoreconnect-v1",
      bid: bundleId,
    }),
  );
  const data = new TextEncoder().encode(`${header}.${payload}`);
  const sig = new Uint8Array(
    await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, key, data),
  );
  return `${header}.${payload}.${b64url(sig)}`;
}

/** 从客户端给的 JWS 里取 `transactionId`，再回源查这条交易 */
export async function verifyApplePurchase(
  channel: StoreChannelConfig,
  receipt: string,
  deps: { fetch?: typeof fetch; now?: Date } = {},
): Promise<VerifyResult> {
  const payload = decodeJwsPayload(receipt) as AppleTransactionPayload | null;
  const transactionId = String(payload?.transactionId ?? "").trim();
  if (!transactionId) {
    return { ok: false, code: "invalid_receipt", message: "凭据里没有 transactionId" };
  }

  const doFetch = deps.fetch ?? fetch;
  const now = deps.now ?? new Date();
  let token: string;
  try {
    token = await appleJwt(channel.secret, channel.identifier, now);
  } catch {
    return { ok: false, code: "invalid_receipt", message: "Apple 凭据不可用（p8 无法使用）" };
  }

  const url = `${channel.endpoint}/inApps/v1/transactions/${encodeURIComponent(transactionId)}`;
  const res = await doFetch(url, { headers: { authorization: `Bearer ${token}` } });
  if (res.status === 404) {
    return { ok: false, code: "invalid_receipt", message: "商店查不到这笔交易" };
  }
  if (!res.ok) {
    return {
      ok: false,
      code: "service_unavailable",
      message: `Apple 查单失败（${res.status}）`,
    };
  }
  const body = (await res.json().catch(() => null)) as { signedTransactionInfo?: string } | null;
  const info = body?.signedTransactionInfo
    ? (decodeJwsPayload(body.signedTransactionInfo) as AppleTransactionPayload | null)
    : null;
  if (!info) {
    return { ok: false, code: "invalid_receipt", message: "Apple 返回的交易无法解析" };
  }

  const envValue = String(info.environment ?? "").toLowerCase();
  const currency = typeof info.currency === "string" ? info.currency : null;
  const amountMinor =
    typeof info.price === "number" && Number.isFinite(info.price)
      ? Math.round(info.price / 10) // Apple 是毫单位，契约要最小单位
      : null;

  return {
    ok: true,
    purchase: {
      transactionId: String(info.transactionId ?? transactionId),
      productId: String(info.productId ?? ""),
      accountToken: info.appAccountToken ? String(info.appAccountToken).toLowerCase() : null,
      environment: envValue === "sandbox" ? "sandbox" : "production",
      revoked: Boolean(info.revocationDate),
      amountMinor,
      currency,
      raw: JSON.stringify(body),
    },
  };
}

// ────────────────────────── Google ──────────────────────────

/** 服务账号 → OAuth access token（RS256 JWT 换 token） */
async function googleAccessToken(
  secret: StoreSecret,
  now: Date,
  doFetch: typeof fetch,
): Promise<string | null> {
  const key = await crypto.subtle.importKey(
    "pkcs8",
    pemToDer(secret.private_key ?? ""),
    { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const iat = Math.floor(now.getTime() / 1000);
  const header = b64urlEncode(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const payload = b64urlEncode(
    JSON.stringify({
      iss: secret.client_email,
      scope: "https://www.googleapis.com/auth/androidpublisher",
      aud: "https://oauth2.googleapis.com/token",
      iat,
      exp: iat + 300,
    }),
  );
  const data = new TextEncoder().encode(`${header}.${payload}`);
  const sig = new Uint8Array(
    await crypto.subtle.sign("RSASSA-PKCS1-v1_5", key, data),
  );
  const assertion = `${header}.${payload}.${b64url(sig)}`;

  const res = await doFetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
      assertion,
    }).toString(),
  });
  if (!res.ok) return null;
  const body = (await res.json().catch(() => null)) as { access_token?: string } | null;
  return body?.access_token ?? null;
}

interface GoogleProductPurchase {
  purchaseState?: number;
  obfuscatedExternalAccountId?: string;
  obfuscatedAccountId?: string;
  consumptionState?: number;
  regionCode?: string;
}

export async function verifyGooglePurchase(
  channel: StoreChannelConfig,
  productId: string,
  purchaseToken: string,
  deps: { fetch?: typeof fetch; now?: Date } = {},
): Promise<VerifyResult> {
  const doFetch = deps.fetch ?? fetch;
  const now = deps.now ?? new Date();
  let token: string | null;
  try {
    token = await googleAccessToken(channel.secret, now, doFetch);
  } catch {
    return { ok: false, code: "invalid_receipt", message: "Google 凭据不可用（私钥无法使用）" };
  }
  if (!token) {
    return { ok: false, code: "service_unavailable", message: "Google 授权失败" };
  }

  const url =
    `${channel.endpoint}/androidpublisher/v3/applications/${encodeURIComponent(channel.identifier)}` +
    `/purchases/products/${encodeURIComponent(productId)}/tokens/${encodeURIComponent(purchaseToken)}`;
  const res = await doFetch(url, { headers: { authorization: `Bearer ${token}` } });
  if (res.status === 400 || res.status === 404) {
    return { ok: false, code: "invalid_receipt", message: "商店查不到这笔交易" };
  }
  if (!res.ok) {
    return { ok: false, code: "service_unavailable", message: `Google 查单失败（${res.status}）` };
  }
  const info = (await res.json().catch(() => null)) as GoogleProductPurchase | null;
  if (!info) {
    return { ok: false, code: "invalid_receipt", message: "Google 返回的交易无法解析" };
  }
  // purchaseState：0 已购买、1 已取消、2 待处理
  const state = Number(info.purchaseState ?? 0);
  const account = info.obfuscatedExternalAccountId ?? info.obfuscatedAccountId ?? null;

  return {
    ok: true,
    purchase: {
      // purchaseToken 本身就唯一；不额外派生，避免与 Apple 撞键
      transactionId: purchaseToken,
      productId,
      accountToken: account ? String(account).toLowerCase() : null,
      environment: channel.environment === "sandbox" ? "sandbox" : "production",
      revoked: state === 1,
      // Google 的一次性商品查单不返回价格：用套餐价兜底（CRM 单币种）
      amountMinor: null,
      currency: null,
      raw: JSON.stringify(info),
    },
  };
}

/** 落库之后调用（**必须**在订单落库后，否则凭据消失会无法对账） */
export async function consumeGooglePurchase(
  channel: StoreChannelConfig,
  productId: string,
  purchaseToken: string,
  deps: { fetch?: typeof fetch; now?: Date } = {},
): Promise<boolean> {
  const doFetch = deps.fetch ?? fetch;
  const now = deps.now ?? new Date();
  const token = await googleAccessToken(channel.secret, now, doFetch).catch(() => null);
  if (!token) return false;
  const url =
    `${channel.endpoint}/androidpublisher/v3/applications/${encodeURIComponent(channel.identifier)}` +
    `/purchases/products/${encodeURIComponent(productId)}/tokens/${encodeURIComponent(purchaseToken)}` +
    `:consume`;
  const res = await doFetch(url, {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: "{}",
  });
  return res.ok;
}
