/**
 * 唯一的**主密钥**（`APP_SECRET`）与两把派生密钥
 *
 * 为什么只留一把：部署时要记的密钥越少越好，而"多一把密钥"从来不等于"更安全"
 * —— 它只等于"多一个会配错、会忘、会在换的时候漏掉某处的地方"。
 *
 * 但**用途必须隔离**：同一个字节串既当 HMAC key 又当 AES key，是典型的
 * 密钥复用（换算法/换用途时互相牵连，泄露面也翻倍）。做法是给每个用途一个
 * 标签，派生出的字节不同：
 *
 *   HMAC（退订链接 / mock 回调）：`<APP_SECRET>|crm/sign/v1`   → 直接当 key 材料
 *   AES-GCM（网关密钥 / cf-api token）：`SHA-256(<APP_SECRET>|crm/enc/v1)`
 *
 * 用标签拼接 + 一次 SHA-256，而不是 HKDF：HKDF 只有异步实现，而签名路径
 * （退订链接）是同步拼字符串，把它改成异步只会让调用链为"密码学上更漂亮"变复杂。
 * 标签不同 ⇒ 两把密钥在密码学上互相独立，这才是这条约束的实际要求。
 *
 * 轮换代价（改 `wrangler secret put APP_SECRET` 之前先想清楚）：
 *   - 已发出的退订链接立刻失效（重发一封即可）
 *   - 已存的网关密钥 / cf-api token 全部**解不开**，必须重新填
 * 所以：**定了就别换**。
 */
import type { Env } from "./env";

const SIGN_LABEL = "crm/sign/v1";
const ENC_LABEL = "crm/enc/v1";
/** 主密钥原文；空串 = 没配（调用方必须当成"功能不可用"，不能用空密钥签/加密） */
export function appSecretOf(env: Env): string {
  return String(env.APP_SECRET ?? "").trim();
}

/** 主密钥是否就绪 */
export function appSecretConfigured(env: Env): boolean {
  return appSecretOf(env) !== "";
}

/** HMAC 用的密钥材料（同步：退订链接签名的调用链是同步的） */
export function signingKeyOf(env: Env): string {
  const secret = appSecretOf(env);
  return secret ? `${secret}|${SIGN_LABEL}` : "";
}


/** AES-GCM 用的 CryptoKey；`null` = 没配主密钥（调用方应拒绝保存明文） */
export async function encryptionKeyOf(env: Env): Promise<CryptoKey | null> {
  const secret = appSecretOf(env);
  if (!secret) return null;
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(`${secret}|${ENC_LABEL}`),
  );
  return crypto.subtle.importKey("raw", digest, { name: "AES-GCM" }, false, [
    "encrypt",
    "decrypt",
  ]);
}
