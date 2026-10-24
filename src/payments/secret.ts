/**
 * 网关密钥的加密存储（`payment_gateways.secret_enc`）
 *
 * 为什么必须加密：D1 的常规运维动作就是 `wrangler d1 export`（备份、迁移、排障时
 * 打包整库）。密钥明文入库等于**每次备份都在泄露商户密钥**。
 *
 * 方案：AES-GCM（认证加密，改一个字节就解不开）+ 主密钥来自 Worker secret
 * `PAYMENT_SECRET_KEY`。密文自带版本前缀，将来换算法/轮换密钥可以双读：
 *
 *     v1:<base64(iv || ciphertext||tag)>
 *
 * 不做的事（有意）：不存 `iv` 之外的任何元数据、不做密钥派生参数存储
 * —— 主密钥由运维通过 `wrangler secret put` 管理，不需要我们保管。
 */

import type { Env } from "../env";

const VERSION = "v1";
const IV_BYTES = 12;

/** 主密钥是否就绪（没配 = 不能保存/使用真实网关密钥） */
export function secretKeyConfigured(env: Env): boolean {
  return String(env.PAYMENT_SECRET_KEY ?? "").trim() !== "";
}

async function aesKey(env: Env): Promise<CryptoKey | null> {
  const raw = String(env.PAYMENT_SECRET_KEY ?? "").trim();
  if (!raw) return null;
  // 允许运维填任意长度口令：先 SHA-256 归一到 32 字节，避免"必须是 32 位"的坑
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(raw));
  return crypto.subtle.importKey("raw", digest, { name: "AES-GCM" }, false, ["encrypt", "decrypt"]);
}

function toBase64(bytes: Uint8Array): string {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s);
}

function fromBase64(text: string): Uint8Array {
  const s = atob(text);
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
  return out;
}

/**
 * 加密一个网关密钥。
 * @returns `null` = 没配主密钥（调用方应拒绝保存明文，而不是退化存明文）
 */
export async function encryptSecret(env: Env, plaintext: string): Promise<string | null> {
  const key = await aesKey(env);
  if (!key) return null;
  const iv = crypto.getRandomValues(new Uint8Array(IV_BYTES));
  const ct = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv },
    key,
    new TextEncoder().encode(plaintext),
  );
  const merged = new Uint8Array(iv.length + ct.byteLength);
  merged.set(iv, 0);
  merged.set(new Uint8Array(ct), iv.length);
  return `${VERSION}:${toBase64(merged)}`;
}

/**
 * 解密。
 * @returns `null` = 没配主密钥 / 版本不认识 / 密文被改过 / 换了主密钥
 *          —— 一律当"解不开"，绝不返回半截明文
 */
export async function decryptSecret(env: Env, stored: string | null): Promise<string | null> {
  if (!stored) return null;
  const sep = stored.indexOf(":");
  if (sep < 0) return null;
  const version = stored.slice(0, sep);
  if (version !== VERSION) return null;

  const key = await aesKey(env);
  if (!key) return null;

  let bytes: Uint8Array;
  try {
    bytes = fromBase64(stored.slice(sep + 1));
  } catch {
    return null;
  }
  if (bytes.length <= IV_BYTES) return null;

  const iv = bytes.slice(0, IV_BYTES);
  const ct = bytes.slice(IV_BYTES);
  try {
    const pt = await crypto.subtle.decrypt({ name: "AES-GCM", iv }, key, ct);
    return new TextDecoder().decode(pt);
  } catch {
    // GCM 认证失败（被改过 / 主密钥不对）
    return null;
  }
}
