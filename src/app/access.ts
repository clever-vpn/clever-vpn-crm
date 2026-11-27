/**
 * studio 调 `/api/studio/app-bind` 的凭据 —— **CRM 签、studio 只存不想**（2026-11-27）。
 *
 * 契约：`clever-vpn-docs/docs/contracts/studio-identity.md` §2.1.2
 *       + `services/crm/app-studio.md` §3.2。
 *
 * 与 site 的 `sacc_` 同构，只是受众与作用域不同：
 *
 *   aacc_<b64url(payload)>.<b64url(HMAC-SHA256(<APP_SECRET>|app-access/v1, payload))>
 *   payload = { v:1, t:"aacc", aud:"app-studio", tenant, iat, exp }     TTL 14 天
 *
 * 三件事与 `site/access.ts` 逐条对齐（每一条都对应一次真实事故）：
 *
 *  1. **标签隔离**：key 材料是 `<APP_SECRET>|app-access/v1`，与退订链接的 `crm/sign/v1`、
 *     site 的 `site-access/v1` 都分开 —— 同一份主密钥签多种东西，迟早能互相冒充。
 *  2. **受众与租户都写进 payload**：`aud` 固定 `app-studio`，`tenant` 必须与本次请求
 *     解析出的租户一致。只验签名不验租户，一枚 token 就能改别人家绑定。
 *  3. **14 天，与会话同寿**：过期就回面板重进、重签一枚；不需要 refresh。
 *
 * 作用域最小：这枚 token **只被 `/api/studio/app-bind` 接受**（写一个仓库名）。
 */

import { appSecretOf } from "../secrets";

import type { Env } from "../env";

const LABEL = "app-access/v1";

/** 与会话同寿（14 天）——与 `site-access` 保持一致，改它等于改产品可用时长 */
export const APP_ACCESS_TTL_SECONDS = 14 * 24 * 60 * 60;

/** 只有这一个受众能用 */
export const APP_ACCESS_AUD = "app-studio";

export interface AppAccessClaims {
  v: 1;
  /** token 类型标记：`aacc`（app access），防止与 `sacc` 互认 */
  t: "aacc";
  aud: typeof APP_ACCESS_AUD;
  /** `accounts.id` 的字符串形式 */
  tenant: string;
  iat: number;
  exp: number;
}

const enc = new TextEncoder();
const dec = new TextDecoder();

function b64urlEncode(bytes: Uint8Array): string {
  let text = "";
  for (const byte of bytes) text += String.fromCharCode(byte);
  return btoa(text).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function b64urlDecode(text: string): Uint8Array {
  const padded = text.replace(/-/g, "+").replace(/_/g, "/");
  const raw = atob(padded + "=".repeat((4 - (padded.length % 4)) % 4));
  const out = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i += 1) out[i] = raw.charCodeAt(i);
  return out;
}

/** `<APP_SECRET>|app-access/v1` —— 与 site-access、退订签名互相独立 */
function keyMaterial(env: Env): string {
  const secret = appSecretOf(env);
  return secret ? `${secret}|${LABEL}` : "";
}

async function hmacKey(env: Env): Promise<CryptoKey | null> {
  const material = keyMaterial(env);
  if (!material) return null;
  return crypto.subtle.importKey("raw", enc.encode(material), { name: "HMAC", hash: "SHA-256" }, false, [
    "sign",
    "verify",
  ]);
}

/** 长度无关的字符串比较（不按"第几位不同"泄露信息） */
function sameText(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i += 1) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

/** 签一枚。`APP_SECRET` 没配 / 租户为空 ⇒ `null`（调用方当成"功能不可用"）。 */
export async function issueAppAccess(
  env: Env,
  tenant: string,
  now: number = Math.floor(Date.now() / 1000),
): Promise<string | null> {
  const id = String(tenant ?? "").trim();
  if (!id) return null;
  const key = await hmacKey(env);
  if (!key) return null;

  const claims: AppAccessClaims = {
    v: 1,
    t: "aacc",
    aud: APP_ACCESS_AUD,
    tenant: id,
    iat: now,
    exp: now + APP_ACCESS_TTL_SECONDS,
  };
  const payload = b64urlEncode(enc.encode(JSON.stringify(claims)));
  const sig = await crypto.subtle.sign("HMAC", key, enc.encode(payload));
  return `aacc_${payload}.${b64urlEncode(new Uint8Array(sig))}`;
}

/**
 * 验一枚，并且**必须**与本次请求的租户一致。
 *
 * 从 `Authorization: Bearer aacc_…` 取；没带 / 无效 / 过期 / 租户不符 ⇒ `null`。
 * 调用方只回一句 `app_access_invalid`，不解释是哪一项没过。
 */
export async function verifyAppAccess(
  request: Request,
  env: Env,
  tenantId: string,
  now: number = Math.floor(Date.now() / 1000),
): Promise<AppAccessClaims | null> {
  const header = request.headers.get("authorization") ?? "";
  const m = /^Bearer\s+(aacc_\S+)$/i.exec(header.trim());
  if (!m) return null;

  const body = m[1]!.slice("aacc_".length);
  const dot = body.indexOf(".");
  if (dot <= 0) return null;
  const payload = body.slice(0, dot);
  const signature = body.slice(dot + 1);

  const key = await hmacKey(env);
  if (!key) return null;

  let ok = false;
  try {
    ok = await crypto.subtle.verify("HMAC", key, b64urlDecode(signature), enc.encode(payload));
  } catch {
    return null;
  }
  if (!ok) return null;

  let claims: AppAccessClaims;
  try {
    claims = JSON.parse(dec.decode(b64urlDecode(payload))) as AppAccessClaims;
  } catch {
    return null;
  }

  if (claims?.v !== 1 || claims.t !== "aacc" || claims.aud !== APP_ACCESS_AUD) return null;
  if (typeof claims.tenant !== "string" || claims.tenant === "") return null;
  if (!tenantId || !sameText(claims.tenant, tenantId)) return null;
  if (!Number.isFinite(claims.exp) || claims.exp <= now) return null;

  return claims;
}
