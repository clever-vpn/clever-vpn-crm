/**
 * 商店渠道（`store_channels`）—— **不是支付网关**
 *
 * 见 `docs/contracts/app-crm/payment.md` §2.4.3.1：钱进 Apple / Google 的账，
 * CRM 只能"查单"，不能发起支付、不能退款、不接收签名回调。所以它单独一张表，
 * 每平台最多一行，也不参与 `pickGateway()` 的路由。
 *
 * 共享的只有两件事：**同一套密钥加密**（`secret_enc` + `PAYMENT_SECRET_KEY`）
 * 与"查单 → settlePaidOrder()"那段代码。
 */
import { encryptSecret, secretKeyConfigured } from "./secret";

import type { Env } from "../env";

export const STORE_PLATFORMS = ["apple", "google"] as const;
export type StorePlatform = (typeof STORE_PLATFORMS)[number];

export const STORE_STATUSES = ["draft", "live", "disabled"] as const;
export const STORE_ENVIRONMENTS = ["production", "sandbox"] as const;

/** 官方 API 根地址；运营只需要在"沙盒域名 / 自建代理"时改它 */
export const DEFAULT_ENDPOINTS: Record<StorePlatform, string> = {
  apple: "https://api.storekit.itunes.apple.com",
  google: "https://androidpublisher.googleapis.com",
};

export interface StoreChannelRow {
  id: number;
  platform: string;
  endpoint: string | null;
  identifier: string;
  environment: string;
  secret_enc: string | null;
  status: string;
  last_ok_at: string | null;
  last_error: string | null;
  created_at: string;
  updated_at: string;
}

const COLUMNS = `id, platform, endpoint, identifier, environment, secret_enc, status,
  last_ok_at, last_error, created_at, updated_at`;

export async function listStoreChannels(env: Env): Promise<StoreChannelRow[]> {
  const rows = await env.DB.prepare(
    `SELECT ${COLUMNS} FROM store_channels ORDER BY platform`,
  ).all<StoreChannelRow>();
  return rows.results ?? [];
}

export async function loadStoreChannel(
  env: Env,
  platform: string,
): Promise<StoreChannelRow | null> {
  return env.DB.prepare(`SELECT ${COLUMNS} FROM store_channels WHERE platform = ?`)
    .bind(platform)
    .first<StoreChannelRow>();
}

/** 只有 `live` 的那一行才会被查单调用 */
export async function liveStoreChannel(
  env: Env,
  platform: string,
): Promise<StoreChannelRow | null> {
  const row = await loadStoreChannel(env, platform);
  return row?.status === "live" ? row : null;
}

export interface StoreChannelInput {
  identifier: string;
  environment?: string;
  endpoint?: string | null;
  /** 明文凭据（Apple：`{p8, issuer_id, key_id}`；Google：服务账号 JSON 原文） */
  secret?: string;
  clearSecret?: boolean;
  status?: string;
}

export interface StoreChannelView {
  platform: string;
  endpoint: string;
  identifier: string;
  environment: string;
  status: string;
  has_secret: boolean;
  last_ok_at: string | null;
  last_error: string | null;
}

/** 对外视图：**永不回显 `secret_enc`**，只给 `has_secret` */
export function storeChannelView(row: StoreChannelRow): StoreChannelView {
  return {
    platform: row.platform,
    endpoint: row.endpoint || DEFAULT_ENDPOINTS[row.platform as StorePlatform] || "",
    identifier: row.identifier,
    environment: row.environment,
    status: row.status,
    has_secret: Boolean(row.secret_enc),
    last_ok_at: row.last_ok_at,
    last_error: row.last_error,
  };
}

/** 凭据形状校验：宁可保存时就报错，也不要等第一次查单才炸 */
export function validateStoreSecret(platform: string, plain: string): string | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(plain);
  } catch {
    return "凭据必须是 JSON";
  }
  if (!parsed || typeof parsed !== "object") return "凭据必须是 JSON 对象";
  const obj = parsed as Record<string, unknown>;
  if (platform === "apple") {
    if (typeof obj.p8 !== "string" || !obj.p8.includes("BEGIN PRIVATE KEY")) {
      return "Apple 需要 p8（PKCS#8，含 BEGIN PRIVATE KEY）";
    }
    if (typeof obj.issuer_id !== "string" || !obj.issuer_id.trim()) return "Apple 需要 issuer_id";
    if (typeof obj.key_id !== "string" || !obj.key_id.trim()) return "Apple 需要 key_id";
    return null;
  }
  if (platform === "google") {
    if (typeof obj.client_email !== "string" || !obj.client_email.includes("@")) {
      return "Google 需要服务账号的 client_email";
    }
    if (typeof obj.private_key !== "string" || !obj.private_key.includes("PRIVATE KEY")) {
      return "Google 需要服务账号的 private_key";
    }
    return null;
  }
  return `未知平台：${platform}`;
}

export type UpsertResult =
  | { ok: true; row: StoreChannelRow }
  | { ok: false; code: string; message: string };

/**
 * 新建或更新一个平台的渠道（每平台最多一行，`platform` 是唯一键）。
 *
 * 幂等：同样的入参重复提交结果一致；`secret` 不传就保留原值（后台表单不回显密钥）。
 */
export async function upsertStoreChannel(
  env: Env,
  platform: string,
  input: StoreChannelInput,
  now: Date = new Date(),
): Promise<UpsertResult> {
  if (!STORE_PLATFORMS.includes(platform as StorePlatform)) {
    return { ok: false, code: "unknown_platform", message: "只支持 apple / google" };
  }
  const identifier = String(input.identifier ?? "").trim();
  if (!identifier) return { ok: false, code: "identifier_required", message: "必须填包名 / Bundle ID" };

  const environment = input.environment ?? "production";
  if (!STORE_ENVIRONMENTS.includes(environment as (typeof STORE_ENVIRONMENTS)[number])) {
    return { ok: false, code: "bad_environment", message: "environment 只能是 production / sandbox" };
  }
  // 沙盒只在非生产实例上配置：生产实例收到沙盒凭据一律 422 sandbox_rejected（契约 §2.4.3）
  if (environment === "sandbox" && String(env.ENVIRONMENT ?? "").trim() === "production") {
    return {
      ok: false,
      code: "sandbox_not_allowed",
      message: "生产实例不能配置沙盒环境",
    };
  }

  const status = input.status ?? "draft";
  if (!STORE_STATUSES.includes(status as (typeof STORE_STATUSES)[number])) {
    return { ok: false, code: "bad_status", message: "status 只能是 draft / live / disabled" };
  }

  let secretEnc: string | null | undefined;
  if (input.clearSecret) {
    secretEnc = null;
  } else if (typeof input.secret === "string" && input.secret.trim()) {
    if (!secretKeyConfigured(env)) {
      return { ok: false, code: "secret_key_missing", message: "未配置 PAYMENT_SECRET_KEY，无法保存凭据" };
    }
    const bad = validateStoreSecret(platform, input.secret.trim());
    if (bad) return { ok: false, code: "invalid_secret", message: bad };
    const enc = await encryptSecret(env, input.secret.trim());
    if (!enc) return { ok: false, code: "secret_key_missing", message: "凭据加密失败" };
    secretEnc = enc;
  }

  const existing = await loadStoreChannel(env, platform);
  const iso = now.toISOString();
  const endpoint = (input.endpoint ?? existing?.endpoint ?? "")?.toString().trim() || null;

  if (existing) {
    await env.DB.prepare(
      `UPDATE store_channels SET endpoint = ?, identifier = ?, environment = ?,
         secret_enc = COALESCE(?, secret_enc), status = ?, updated_at = ?
        WHERE id = ?`,
    )
      .bind(endpoint, identifier, environment, secretEnc ?? null, status, iso, existing.id)
      .run();
  } else {
    await env.DB.prepare(
      `INSERT INTO store_channels (platform, endpoint, identifier, environment, secret_enc,
         status, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    )
      .bind(platform, endpoint, identifier, environment, secretEnc ?? null, status, iso, iso)
      .run();
  }

  const row = await loadStoreChannel(env, platform);
  if (!row) return { ok: false, code: "save_failed", message: "保存后读不到这条渠道" };
  return { ok: true, row };
}
