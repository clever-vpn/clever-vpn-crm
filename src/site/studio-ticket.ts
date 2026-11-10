/**
 * studio 身份：**票据的签发方**（CRM 是唯一签发方）。
 *
 * 契约：`clever-vpn-docs/docs/contracts/studio-identity.md`（`Contract: 1`，`kind: shared`）。
 * site-studio / app-studio 两侧用**同一套格式**，所以这里每一处编码都必须与契约字节一致。
 *
 * 三件事在这里：
 *   1. `K_aud = HMAC(APP_SECRET|crm/studio/v1, "studio-ticket:<aud>")` —— 两层派生：
 *      第一层与退订链接、AES-GCM 并列（同一把 `APP_SECRET`，不同标签），第二层按产品
 *      分开，所以一个 studio 的密钥泄漏只影响它自己那个产品。
 *   2. 签 `tkt_`（60 秒）/ 验 `tkt_` 与 `sts_`（studio 拿同一把 K_aud 换发会话）；
 *   3. `POST /api/studio/ticket`（管理员 Cookie 鉴权 → 返回带 `#t=` 的跳转 URL）。
 *
 * ⚠️ 票据放 **URL fragment**（`#t=`）而不是 query：fragment 不上服务器、不进 `Referer`、
 * 不进访问日志。这是契约 §2.1 的硬要求。
 */

import { fromBase64Url, sha256Hex, toBase64Url } from "../admin/crypto";
import { studioKeyMaterialOf } from "../secrets";

import type { Env } from "../env";

/** 允许的受众。加产品 = 加一行 + 配一个 `STUDIO_<X>_URL`。 */
export const STUDIO_AUDIENCES = ["site-studio", "app-studio"] as const;
export type StudioAud = (typeof STUDIO_AUDIENCES)[number];

/** 票据 60 秒；会话 14 天（契约 §3.1）。 */
export const TICKET_TTL_SECONDS = 60;
export const SESSION_TTL_SECONDS = 14 * 24 * 60 * 60;

export interface StudioClaims {
  /** 格式版本，当前 1 */
  v: 1;
  aud: StudioAud;
  /** `accounts.id` 的字符串形式 —— 与 `metadata.tenant`、`idFromName()` 同一个键 */
  tenant: string;
  /** CRM origin（无尾斜杠） */
  crm: string;
  /** Unix 秒 */
  exp: number;
  /** 仅 `aud=app-studio` */
  gh?: { installation: number; repo: string };
}

const enc = new TextEncoder();
const dec = new TextDecoder();

const isAud = (value: unknown): value is StudioAud =>
  typeof value === "string" && (STUDIO_AUDIENCES as readonly string[]).includes(value);

function b64(bytes: ArrayBuffer | Uint8Array): string {
  return toBase64Url(bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes));
}

/**
 * `HMAC(APP_SECRET|crm/studio/v1, "studio-ticket:<aud>")` → 该产品的签名密钥。
 *
 * 没有 `APP_SECRET` 就返回 `null`（fail closed）。**不额外引入 secret**。
 */
export async function studioKeyOf(env: Env, aud: StudioAud): Promise<CryptoKey | null> {
  const master = studioKeyMaterialOf(env);
  if (!master) return null;
  const base = await crypto.subtle.importKey(
    "raw",
    enc.encode(master),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const derived = await crypto.subtle.sign("HMAC", base, enc.encode(`studio-ticket:${aud}`));
  return crypto.subtle.importKey("raw", derived, { name: "HMAC", hash: "SHA-256" }, false, [
    "sign",
    "verify",
  ]);
}

async function signToken(
  key: CryptoKey,
  prefix: "tkt" | "sts",
  claims: StudioClaims,
): Promise<string> {
  const payload = b64(enc.encode(JSON.stringify(claims)));
  const signature = await crypto.subtle.sign("HMAC", key, enc.encode(payload));
  return `${prefix}_${payload}.${b64(signature)}`;
}

/**
 * 验一枚票据或会话。
 *
 * 三项全查：**签名 + `exp` + `aud`**（契约 §3.2）。任何一项不过都返回 `null` ——
 * 调用方只回一句"请从 CRM 重新进入"，不向浏览器解释细分原因。
 */
export async function verifyStudioToken(
  env: Env,
  token: string,
  expected: { aud: StudioAud; prefix: "tkt" | "sts"; now?: number },
): Promise<StudioClaims | null> {
  const raw = String(token ?? "");
  const head = `${expected.prefix}_`;
  if (!raw.startsWith(head)) return null;

  const body = raw.slice(head.length);
  const dot = body.indexOf(".");
  if (dot <= 0) return null;

  const payload = body.slice(0, dot);
  const signature = body.slice(dot + 1);

  const key = await studioKeyOf(env, expected.aud);
  if (!key) return null;

  let ok = false;
  try {
    ok = await crypto.subtle.verify("HMAC", key, fromBase64Url(signature), enc.encode(payload));
  } catch {
    return null;
  }
  if (!ok) return null;

  let claims: StudioClaims;
  try {
    claims = JSON.parse(dec.decode(fromBase64Url(payload))) as StudioClaims;
  } catch {
    return null;
  }

  if (claims?.v !== 1) return null;
  if (claims.aud !== expected.aud) return null;
  const now = expected.now ?? Math.floor(Date.now() / 1000);
  if (!Number.isFinite(claims.exp) || claims.exp <= now) return null;
  if (typeof claims.tenant !== "string" || claims.tenant === "") return null;

  return claims;
}

/** 每侧 studio 的对外地址（`STUDIO_SITE_URL` / `STUDIO_APP_URL`），去尾斜杠。 */
export function studioOriginOf(env: Env, aud: StudioAud): string {
  const name = aud === "site-studio" ? "STUDIO_SITE_URL" : "STUDIO_APP_URL";
  return String((env as unknown as Record<string, unknown>)[name] ?? "")
    .trim()
    .replace(/\/+$/, "");
}

export type MintResult =
  | { ok: true; url: string; expiresAt: string }
  | { ok: false; status: number; code: string; message: string };

/**
 * 签一张票并拼出跳转 URL。
 *
 * `url` 由**服务端配置**决定，不接受调用方传入 —— 否则就是开放重定向（契约 §2.1）。
 */
export async function mintStudioTicket(
  env: Env,
  input: { tenant: string; crm: string; aud: StudioAud; gh?: StudioClaims["gh"]; now?: number },
): Promise<MintResult> {
  const key = await studioKeyOf(env, input.aud);
  if (!key) {
    return {
      ok: false,
      status: 500,
      code: "studio_not_configured",
      message: "缺少 APP_SECRET（wrangler secret put），签不出票据",
    };
  }
  const origin = studioOriginOf(env, input.aud);
  if (!origin) {
    return {
      ok: false,
      status: 500,
      code: "studio_not_configured",
      message: `缺少 ${input.aud === "site-studio" ? "STUDIO_SITE_URL" : "STUDIO_APP_URL"}，不知道往哪跳`,
    };
  }

  const now = input.now ?? Math.floor(Date.now() / 1000);
  const exp = now + TICKET_TTL_SECONDS;
  const claims: StudioClaims = {
    v: 1,
    aud: input.aud,
    tenant: String(input.tenant),
    crm: input.crm.replace(/\/+$/, ""),
    exp,
    ...(input.gh ? { gh: input.gh } : {}),
  };
  const ticket = await signToken(key, "tkt", claims);
  return {
    ok: true,
    url: `${origin}/#t=${ticket}`,
    expiresAt: new Date(exp * 1000).toISOString(),
  };
}

/**
 * `POST /api/studio/ticket` —— CRM 后台「网站 / 应用」页点开设计器时调用。
 *
 * 鉴权沿用后台那套：管理员 Cookie 会话 + `x-crm-request: 1`（同源 fetch 才会带的自定义头）。
 * 唯一入参是 `aud`；`tenant` 来自本次请求解析出的租户，**不接受客户端传入**。
 */
export async function handleStudioTicket(
  request: Request,
  env: Env,
  tenantId: string,
  session: { user_id: number } | null,
  csrfOk: boolean,
): Promise<Response> {
  const json = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), {
      status,
      headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
    });

  if (!csrfOk) return json({ error: "csrf_rejected" }, 403);
  if (!session) return json({ error: "unauthorized" }, 401);

  let aud: unknown;
  try {
    aud = ((await request.json()) as { aud?: unknown })?.aud;
  } catch {
    return json({ error: "studio_aud_unknown", message: "body 必须是 JSON：{\"aud\":\"site-studio\"}" }, 400);
  }
  if (!isAud(aud)) return json({ error: "studio_aud_unknown" }, 400);

  const result = await mintStudioTicket(env, {
    tenant: tenantId,
    crm: new URL(request.url).origin,
    aud,
  });
  if (!result.ok) return json({ error: result.code, message: result.message }, result.status);
  return json({ url: result.url, expires_at: result.expiresAt, aud });
}

/** 会话 id 的哈希（与 `admin_sessions.id` 同算法），导出给测试与其它鉴权路径复用。 */
export const sessionIdOf = sha256Hex;
