/**
 * 支付回跳 token —— 给外部浏览器用的**签名凭证**。
 *
 * 回跳页/refresh 不能要求 CRM 会话（第三方付完是在外部浏览器打开，站点会话不在），
 * 也不能只靠订单号（可枚举）。所以签一枚短 token：
 *
 *   claims = { v:1, t:"prt", c:订单号, to:最终落地地址|null, exp:unix }
 *   token  = base64url(JSON) + "." + base64url(HMAC-SHA256)
 *
 * key 材料是 `<APP_SECRET>|pay-return/v1`，与退订链接（`crm/sign/v1`）、
 * site-access（`site-access/v1`）互相独立。
 *
 * 最终落地地址放在 token 里，而不是 query 里：页面**不信任** query 的 `to`，
 * 否则就是一个开放重定向。
 */

import { appSecretOf } from "../secrets";

import type { Env } from "../env";

/** 24h：支付窗口 60 分钟，留足迟到/重开的时间 */
export const RETURN_TOKEN_TTL_SECONDS = 24 * 60 * 60;

const LABEL = "pay-return/v1";
const TOKEN_TYPE = "prt";

export interface ReturnClaims {
  v: 1;
  t: typeof TOKEN_TYPE;
  /** 订单号 */
  c: string;
  /** 最终落地地址；null = 没有客户端回跳，CRM 只显示结果 */
  to: string | null;
  /** unix 秒 */
  exp: number;
}

const enc = new TextEncoder();
const dec = new TextDecoder();

function b64urlEncode(bytes: Uint8Array): string {
  let text = "";
  for (const byte of bytes) text += String.fromCharCode(byte);
  return btoa(text).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function b64urlDecode(text: string): Uint8Array | null {
  if (!/^[A-Za-z0-9_-]+$/.test(text)) return null;
  const padded = text.replace(/-/g, "+").replace(/_/g, "/");
  try {
    const raw = atob(padded + "=".repeat((4 - (padded.length % 4)) % 4));
    const out = new Uint8Array(raw.length);
    for (let i = 0; i < raw.length; i += 1) out[i] = raw.charCodeAt(i);
    return out;
  } catch {
    return null;
  }
}

async function hmacKey(env: Env): Promise<CryptoKey | null> {
  const secret = appSecretOf(env);
  if (!secret) return null;
  return crypto.subtle.importKey(
    "raw",
    enc.encode(`${secret}|${LABEL}`),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign", "verify"],
  );
}

const DANGEROUS_SCHEMES = new Set(["javascript:", "data:", "file:", "blob:", "vbscript:"]);

/**
 * 把调用方给的最终地址规范化：追加 `order=<code>`，拒绝危险 scheme。
 * - 空/非法 → `null`（CRM 兜底页只显示结果，不跳）；
 * - http(s) / 自定义 scheme（App 深链）都接受；
 * - 不在这里做域名白名单：最终地址由已鉴权的 App/Site 调用方提供，token 只防篡改。
 */
export function normalizeReturnUrl(raw: string | null | undefined, orderCode: string): string | null {
  const text = (raw ?? "").trim();
  if (!text) return null;
  let url: URL;
  try {
    url = new URL(text);
  } catch {
    return null;
  }
  const scheme = url.protocol.toLowerCase();
  if (DANGEROUS_SCHEMES.has(scheme)) return null;
  url.searchParams.set("order", orderCode);
  return url.toString();
}

export async function makeReturnToken(
  env: Env,
  orderCode: string,
  to: string | null,
  now: Date = new Date(),
): Promise<string | null> {
  const key = await hmacKey(env);
  if (!key) return null;
  const claims: ReturnClaims = {
    v: 1,
    t: TOKEN_TYPE,
    c: orderCode,
    to,
    exp: Math.floor(now.getTime() / 1000) + RETURN_TOKEN_TTL_SECONDS,
  };
  const payload = b64urlEncode(enc.encode(JSON.stringify(claims)));
  const sig = await crypto.subtle.sign("HMAC", key, enc.encode(payload));
  return `${payload}.${b64urlEncode(new Uint8Array(sig))}`;
}

export async function verifyReturnToken(
  env: Env,
  token: string,
  orderCode: string,
  now: Date = new Date(),
): Promise<ReturnClaims | null> {
  const dot = token.indexOf(".");
  if (dot <= 0 || dot === token.length - 1) return null;
  const payload = token.slice(0, dot);
  const sig = b64urlDecode(token.slice(dot + 1));
  if (!sig) return null;
  const key = await hmacKey(env);
  if (!key) return null;
  const ok = await crypto.subtle.verify("HMAC", key, sig, enc.encode(payload));
  if (!ok) return null;
  const payloadBytes = b64urlDecode(payload);
  if (!payloadBytes) return null;
  let claims: ReturnClaims;
  try {
    claims = JSON.parse(dec.decode(payloadBytes)) as ReturnClaims;
  } catch {
    return null;
  }
  if (claims.v !== 1 || claims.t !== TOKEN_TYPE) return null;
  if (claims.c !== orderCode) return null;
  if (!Number.isFinite(claims.exp) || claims.exp <= Math.floor(now.getTime() / 1000)) return null;
  if (claims.to !== null && typeof claims.to !== "string") return null;
  return claims;
}

/** CRM 兜底页 URL：`<crmOrigin>/pay/return/<code>?t=<token>` */
export async function makeReturnPageUrl(
  env: Env,
  crmOrigin: string,
  orderCode: string,
  to: string | null,
  now: Date = new Date(),
): Promise<string | null> {
  const token = await makeReturnToken(env, orderCode, to, now);
  if (!token) return null;
  return `${crmOrigin.replace(/\/+$/, "")}/pay/return/${encodeURIComponent(orderCode)}?t=${encodeURIComponent(token)}`;
}

/** 客户端直接回跳：在它的 URL 上追加 token / cancel 标记 */
export async function appendReturnToken(
  url: string,
  env: Env,
  orderCode: string,
  to: string | null,
  now: Date = new Date(),
  cancel = false,
): Promise<string | null> {
  const token = await makeReturnToken(env, orderCode, to, now);
  if (!token) return null;
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return null;
  }
  u.searchParams.set("crm_pay_token", token);
  if (cancel) u.searchParams.set("crm_pay_cancel", "1");
  return u.toString();
}
