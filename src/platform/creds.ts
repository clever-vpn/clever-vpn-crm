/**
 * cf-api 凭据的唯一读写口（`cf_api` 单行，`id = 1`）
 *
 * 三条约束：
 *
 *   1. **token 只以密文落库**（`v1:` 前缀，AES-GCM，主密钥 `PAYMENT_SECRET_KEY`）。
 *      `d1 export` 是常规运维动作，明文入库等于每次备份都在泄露租户 token。
 *   2. **容忍明文**：读到不带 `v1:` 前缀的值，当成明文用，并**就地加密回写**。
 *      托管开通流程是在平台侧把 token 直接写进租户 D1 的（那时拿不到主密钥），
 *      手工 seed 也一样；把它们一律当"坏数据"拒绝，只会让人去绕。
 *   3. **基址三处回退**：库里的 `base_url` → `env.CF_API_BASE` → 默认官方基址。
 *      自部署通常什么都不用填。
 */
import { decryptSecret, encryptSecret, secretKeyConfigured } from "../payments/secret";

import type { Env } from "../env";

const DEFAULT_BASE = "https://api.clever-vpn.org";
const ROW_ID = 1;
const CIPHER_PREFIX = "v1:";

interface CredRow {
  base_url: string;
  token_enc: string;
  verified_at: string | null;
  last_error: string | null;
}

/** 给后台看的形状：**永不返回明文 token** */
export interface PlatformCredsView {
  base_url: string;
  /** 生效的基址（含 env 回退） */
  effective_base: string;
  has_token: boolean;
  /** 库里的密文形态：`encrypted` / `plaintext`（读到明文会自动升级）/ `none` */
  token_storage: "encrypted" | "plaintext" | "none";
  verified_at: string | null;
  last_error: string | null;
  /** 没配主密钥 ⇒ 无法加密保存，只能靠 env 里的旧值 */
  cipher_ready: boolean;
}

/**
 * 调 cf-api 时要的两样东西；`token` 为空 = 不可用。
 *
 * `problem` 区分"没填"和"解不开"：后者是主密钥换过了（或密文被改），
 * 只报"未配置"会让人去翻 `wrangler secret list` 找一个根本不存在的项。
 */
export interface PlatformCreds {
  base: string;
  token: string;
  problem?: "no_token" | "undecryptable";
}

function baseOf(env: Env, stored: string): string {
  const fromDb = (stored ?? "").trim().replace(/\/+$/, "");
  if (fromDb) return fromDb;
  const fromEnv = String(env.CF_API_BASE ?? "").trim().replace(/\/+$/, "");
  return fromEnv || DEFAULT_BASE;
}

async function readRow(env: Env): Promise<CredRow | null> {
  return env.DB.prepare(
    `SELECT base_url, token_enc, verified_at, last_error FROM cf_api WHERE id = ?`,
  )
    .bind(ROW_ID)
    .first<CredRow>();
}

async function ensureRow(env: Env): Promise<void> {
  await env.DB.prepare(
    `INSERT INTO cf_api (id, base_url, token_enc, _updated_at)
     VALUES (?, '', '', ?) ON CONFLICT(id) DO NOTHING`,
  )
    .bind(ROW_ID, new Date().toISOString())
    .run();
}

/**
 * 读凭据（**调用 cf-api 只用这个**）。
 *
 * 明文 token 一律在这里就地升级成密文；升级失败（没配主密钥）不影响本次调用，
 * 只是下次读还会再试一次。
 */
export async function platformCreds(env: Env): Promise<PlatformCreds> {
  const row = await readRow(env);
  if (!row) return { base: baseOf(env, ""), token: "", problem: "no_token" };

  const stored = (row.token_enc ?? "").trim();
  const base = baseOf(env, row.base_url);
  if (!stored) return { base, token: "", problem: "no_token" };

  if (stored.startsWith(CIPHER_PREFIX)) {
    const plain = await decryptSecret(env, stored);
    // 解不开（换了主密钥 / 密文被改）⇒ 需要重新填一把，别当成"没配过"
    if (!plain) return { base, token: "", problem: "undecryptable" };
    return { base, token: plain };
  }

  // 明文：本次照用，同时尽力升级成密文
  const enc = await encryptSecret(env, stored);
  if (enc) {
    await env.DB.prepare(`UPDATE cf_api SET token_enc = ?, _updated_at = ? WHERE id = ?`)
      .bind(enc, new Date().toISOString(), ROW_ID)
      .run();
  }
  return { base, token: stored };
}

/** 后台读配置：不含明文 */
export async function readPlatformCreds(env: Env): Promise<PlatformCredsView> {
  const row = await readRow(env);
  const stored = (row?.token_enc ?? "").trim();
  return {
    base_url: (row?.base_url ?? "").trim(),
    effective_base: baseOf(env, row?.base_url ?? ""),
    has_token: stored !== "",
    token_storage: stored === "" ? "none" : stored.startsWith(CIPHER_PREFIX) ? "encrypted" : "plaintext",
    verified_at: row?.verified_at ?? null,
    last_error: row?.last_error ?? null,
    cipher_ready: secretKeyConfigured(env),
  };
}

export interface SavePlatformCredsInput {
  base_url?: unknown;
  /** 不传 / 传空串 = 保持原 token；`null` = 清空 */
  token?: unknown;
}

export interface SaveResult {
  ok: boolean;
  code?: "no_cipher_key" | "invalid_base" | "invalid_token";
  message?: string;
  view?: PlatformCredsView;
}

/**
 * 保存。基址留空 = 走 env 回退；token 留空 = 不改（换 token 才需要填）。
 */
export async function savePlatformCreds(
  env: Env,
  input: SavePlatformCredsInput,
): Promise<SaveResult> {
  await ensureRow(env);
  const sets: string[] = [];
  const binds: unknown[] = [];

  if (input.base_url !== undefined) {
    const raw = typeof input.base_url === "string" ? input.base_url.trim().replace(/\/+$/, "") : "";
    if (raw && !/^https?:\/\//i.test(raw)) {
      return { ok: false, code: "invalid_base", message: "基址必须是 http(s):// 开头" };
    }
    sets.push("base_url = ?");
    binds.push(raw);
  }

  if (input.token !== undefined && input.token !== null) {
    const token = typeof input.token === "string" ? input.token.trim() : "";
    if (token) {
      if (!/^cv_api_[\w.-]+$/.test(token)) {
        return { ok: false, code: "invalid_token", message: "这不是 cf-api 的租户 token（应以 cv_api_ 开头）" };
      }
      const enc = await encryptSecret(env, token);
      if (!enc) {
        return {
          ok: false,
          code: "no_cipher_key",
          message: "未配置 PAYMENT_SECRET_KEY，无法加密保存 token",
        };
      }
      sets.push("token_enc = ?");
      binds.push(enc);
    } else {
      return { ok: false, code: "invalid_token", message: "token 不能是空串；要清空请用 null" };
    }
  } else if (input.token === null) {
    sets.push("token_enc = ?");
    binds.push("");
  }

  if (sets.length === 0) return { ok: true, view: await readPlatformCreds(env) };

  sets.push("_updated_at = ?");
  binds.push(new Date().toISOString());
  binds.push(ROW_ID);
  await env.DB.prepare(`UPDATE cf_api SET ${sets.join(", ")} WHERE id = ?`)
    .bind(...binds)
    .run();
  return { ok: true, view: await readPlatformCreds(env) };
}

/** 联通成功：记时间、清错误 */
export async function markPlatformOk(env: Env): Promise<void> {
  const now = new Date().toISOString();
  await env.DB.prepare(`UPDATE cf_api SET verified_at = ?, last_error = NULL, _updated_at = ? WHERE id = ?`)
    .bind(now, now, ROW_ID)
    .run();
}

/** 联通失败：只记原因，不动 `verified_at`（"最后一次成功"仍有参考价值） */
export async function markPlatformError(env: Env, message: string): Promise<void> {
  await env.DB.prepare(`UPDATE cf_api SET last_error = ?, _updated_at = ? WHERE id = ?`)
    .bind(message.slice(0, 300), new Date().toISOString(), ROW_ID)
    .run();
}
