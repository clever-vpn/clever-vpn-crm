/**
 * studio 调 `/api/site/*` 的凭据 —— **CRM 签、studio 只存不用想**。
 *
 * 契约：`clever-vpn-docs/docs/contracts/site-studio-crm.md` §4.5
 *
 * ## 为什么是这么一枚 token，而不是别的东西
 *
 * studio 要替租户读设置、交模板、点发布，但它**不该拿着租户的全权 API token**
 * （`cv_api_…`）：那枚能调租户的一切。所以入场时（`POST /api/studio/ticket`）CRM
 * 顺手签一枚**只能做 `/api/site/*`** 的凭据交给 studio，studio 存进自己的会话，回来时
 * 带上。studio 从不接触 `APP_SECRET`，CRM 也不需要多配一把 secret。
 *
 * ## 三个定死的约束
 *
 * 1. **标签隔离**：key 材料是 `<APP_SECRET>|site-access/v1`，与退订链接的
 *    `crm/sign/v1` 分开。同一份主密钥签两种东西，迟早能互相冒充。
 * 2. **14 天，与会话同寿**：不是永久。永久 token 想作废只能换 `APP_SECRET`，而换它
 *    会让已发的退订链接失效、已存的网关密钥/cf-api token 全部解不开（见 `secrets.ts`）。
 *    过期不需要刷新逻辑 —— 会话也过期了，回 CRM 重进就会重签一枚。
 * 3. **受众与租户都写进 payload**：`aud` 固定 `site-studio`，`tenant` 必须与
 *    **请求解析出的租户**一致。只验签名不验租户，等于一枚 token 能改别人家站点。
 */
import { appSecretOf } from "../secrets";

import type { Env } from "../env";

const LABEL = "site-access/v1";

/** 与会话同寿（14 天）。改它等于改 studio 的可用时长，是产品决定 */
export const SITE_ACCESS_TTL_SECONDS = 14 * 24 * 60 * 60;

/** 只有这一个受众能用 */
export const SITE_ACCESS_AUD = "site-studio";

export interface SiteAccessClaims {
  v: 1;
  /** token 类型标记：`sacc`（site access），防止与别的令牌互认 */
  t: "sacc";
  aud: typeof SITE_ACCESS_AUD;
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

/** `<APP_SECRET>|site-access/v1` —— 与退订链接那把（`crm/sign/v1`）互相独立 */
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

/** 长度无关的字符串比较：不按"第几位不同"泄露信息 */
function sameText(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i += 1) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

/**
 * 签一枚。`APP_SECRET` 没配时返回 `null`（调用方当成"功能不可用"，不能拿空密钥签）。
 */
export async function issueSiteAccess(
  env: Env,
  tenant: string,
  now: number = Math.floor(Date.now() / 1000),
): Promise<string | null> {
  const id = String(tenant ?? "").trim();
  if (!id) return null;
  const key = await hmacKey(env);
  if (!key) return null;

  const claims: SiteAccessClaims = {
    v: 1,
    t: "sacc",
    aud: SITE_ACCESS_AUD,
    tenant: id,
    iat: now,
    exp: now + SITE_ACCESS_TTL_SECONDS,
  };
  const payload = b64urlEncode(enc.encode(JSON.stringify(claims)));
  const sig = await crypto.subtle.sign("HMAC", key, enc.encode(payload));
  return `sacc_${payload}.${b64urlEncode(new Uint8Array(sig))}`;
}

/**
 * 验一枚，并且**必须**与本次请求的租户一致。
 *
 * 从 `Authorization: Bearer sacc_…` 取；没带 / 无效 / 过期 / 租户不符 ⇒ `null`。
 * 调用方只回一句 `site_access_invalid`，不解释是哪一项没过。
 */
export async function verifySiteAccess(
  request: Request,
  env: Env,
  tenantId: string,
  now: number = Math.floor(Date.now() / 1000),
): Promise<SiteAccessClaims | null> {
  const header = request.headers.get("authorization") ?? "";
  const m = /^Bearer\s+(sacc_\S+)$/i.exec(header.trim());
  if (!m) return null;

  const body = m[1]!.slice("sacc_".length);
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

  let claims: SiteAccessClaims;
  try {
    claims = JSON.parse(dec.decode(b64urlDecode(payload))) as SiteAccessClaims;
  } catch {
    return null;
  }

  if (claims?.v !== 1 || claims.t !== "sacc" || claims.aud !== SITE_ACCESS_AUD) return null;
  if (typeof claims.tenant !== "string" || claims.tenant === "") return null;
  // 租户必须与本次请求解析出的租户一致：否则一枚 token 能改别人家站点
  if (!tenantId || !sameText(claims.tenant, tenantId)) return null;
  if (!Number.isFinite(claims.exp) || claims.exp <= now) return null;

  return claims;
}
