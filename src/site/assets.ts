/**
 * 租户站点资产：**元数据在 D1（`site_assets`），字节在 R2（`env.SITES`）**。
 *
 * 三条设计纪律：
 *
 * 1. **资产归 CRM，不归 studio。** studio 是通用编辑器，它的存储只是缓存（草稿
 *    可以整份丢弃）；资产是租户的财产，必须跨草稿、跨发布版本活下来。
 * 2. **与草稿分开**：重置草稿删的是草稿文件，绝不能碰到这里 —— 否则租户的 logo
 *    会凭空消失。
 * 3. **软删除**：已发布的版本可能还在引用它，硬删会让线上开天窗。真正回收字节
 *    是以后独立的清理作业（按 `deleted_at` + 引用扫描）。
 *
 * 没有做内容去重：key 里带 `id`，同一个文件传两次会存两份。理由是这个场景很少
 * 见（单文件 ≤ 2 MB、每租户 ≤ 20 个），而按 `sha` 去重会立刻引入"删除时还要看
 * 有没有别人在用"的引用计数 —— 那笔复杂度现在不值得付。
 */

import type { Env } from "../env";
import { imageSizeOf } from "./image-size";

export const ASSET_LIMITS = {
  /** 单个文件上限。图标/logo/配图都远用不到 2 MB（相机原图请在浏览器侧先压） */
  bytes: 2 << 20,
  /** 每租户资产数量上限（软删除的不算） */
  perTenant: 20,
} as const;

/** 只收浏览器和站点都能直接显示的位图 / 矢量图 */
export const ASSET_MIME = new Set(["image/png", "image/jpeg", "image/webp", "image/svg+xml"]);

const EXT: Record<string, string> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/webp": "webp",
  "image/svg+xml": "svg",
};

export interface SiteAsset {
  id: string;
  kind: string;
  name: string;
  mime: string;
  bytes: number;
  sha256: string;
  /** 一句话说明（给 AI 与界面看）；空串 = 还没写 */
  description: string;
  /** 像素宽高；0 = 这个文件没解出尺寸（坏文件 / 不支持的格式） */
  width: number;
  height: number;
  created_at: string;
}

export type AssetResult<T> = { ok: true; value: T } | { ok: false; code: string; message: string };

const fail = (code: string, message: string): AssetResult<never> => ({ ok: false, code, message });

const r2Key = (tenantId: string, id: string, mime: string): string =>
  `assets/${tenantId}/${id}.${EXT[mime] ?? "bin"}`;

async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** `a_` + 12 hex，够用且短到能写进 `asset://` */
function newId(): string {
  const buf = new Uint8Array(6);
  crypto.getRandomValues(buf);
  return `a_${[...buf].map((b) => b.toString(16).padStart(2, "0")).join("")}`;
}

const rowToAsset = (r: Record<string, unknown>): SiteAsset => ({
  id: String(r.id),
  kind: String(r.kind ?? "content"),
  name: String(r.name ?? ""),
  mime: String(r.mime),
  bytes: Number(r.bytes ?? 0),
  sha256: String(r.sha256),
  description: String(r.description ?? ""),
  width: Number(r.width ?? 0),
  height: Number(r.height ?? 0),
  created_at: String(r.created_at ?? ""),
});

/** 列出租户的资产（软删除的不列），新的在前 */
export async function listSiteAssets(env: Env, tenantId: string): Promise<SiteAsset[]> {
  const rows = await env.DB.prepare(
    `SELECT id, kind, name, mime, bytes, sha256, description, width, height, created_at FROM site_assets
      WHERE tenant_id = ? AND deleted_at IS NULL ORDER BY created_at DESC, id DESC`,
  )
    .bind(tenantId)
    .all<Record<string, unknown>>();
  return (rows.results ?? []).map(rowToAsset);
}

/** 读一条元数据；不存在或已软删除都返回 null（调用方只需判断"有没有"） */
export async function getSiteAsset(
  env: Env,
  tenantId: string,
  id: string,
): Promise<SiteAsset | null> {
  const row = await env.DB.prepare(
    `SELECT id, kind, name, mime, bytes, sha256, description, width, height, created_at FROM site_assets
      WHERE tenant_id = ? AND id = ? AND deleted_at IS NULL`,
  )
    .bind(tenantId, id)
    .first<Record<string, unknown>>();
  return row ? rowToAsset(row) : null;
}

/** 取字节（预览与发布物化都用它） */
export async function readSiteAssetBytes(
  env: Env,
  tenantId: string,
  id: string,
): Promise<R2ObjectBody | null> {
  const asset = await getSiteAsset(env, tenantId, id);
  if (!asset || !env.SITES) return null;
  return env.SITES.get(r2Key(tenantId, id, asset.mime));
}

/**
 * 存一份资产。顺序是**先写 R2 再写 D1**：反过来的话，D1 里会有指向不存在对象的
 * 行，列表里就会出现一堆坏图。
 */
export async function putSiteAsset(
  env: Env,
  tenantId: string,
  input: {
    kind?: string;
    name?: string;
    /** 一句话说明（可空）。AI 排版时靠它挑图，契约 §7 */
    description?: string;
    mime: string;
    bytes: Uint8Array;
  },
): Promise<AssetResult<SiteAsset>> {
  if (!env.SITES) return fail("r2_not_configured", "没有绑定 SITES（R2）：资产无处可放");
  if (!tenantId) return fail("no_tenant", "拿不到租户 ID，不知道这份资产是谁的");

  const mime = String(input.mime ?? "").toLowerCase().split(";")[0]!.trim();
  if (!ASSET_MIME.has(mime)) {
    return fail("asset_mime_unsupported", `不支持的类型：${mime || "(空)"}（只收 png / jpeg / webp / svg）`);
  }
  if (input.bytes.byteLength === 0) return fail("asset_empty", "文件是空的");
  if (input.bytes.byteLength > ASSET_LIMITS.bytes) {
    return fail(
      "asset_too_large",
      `文件 ${(input.bytes.byteLength / 1024 / 1024).toFixed(1)} MB 超过上限 ${
        ASSET_LIMITS.bytes / 1024 / 1024
      } MB`,
    );
  }

  const countRow = await env.DB.prepare(
    `SELECT COUNT(*) AS n FROM site_assets WHERE tenant_id = ? AND deleted_at IS NULL`,
  )
    .bind(tenantId)
    .first<{ n: number }>();
  if (Number(countRow?.n ?? 0) >= ASSET_LIMITS.perTenant) {
    return fail("asset_quota_exceeded", `这个站点已经有 ${ASSET_LIMITS.perTenant} 个素材，先删掉不用的`);
  }

  const id = newId();
  const sha256 = await sha256Hex(input.bytes);
  const createdAt = new Date().toISOString();
  // 从文件头读宽高：失败就是 0（坏文件不该让上传失败，AI 只是少一个提示）
  const size = imageSizeOf(input.bytes, mime);

  await env.SITES.put(r2Key(tenantId, id, mime), input.bytes, {
    httpMetadata: { contentType: mime, cacheControl: "public, max-age=31536000, immutable" },
    customMetadata: { tenant: tenantId, asset: id, sha256 },
  });

  const asset: SiteAsset = {
    id,
    kind: String(input.kind ?? "content"),
    name: String(input.name ?? "").slice(0, 120),
    mime,
    bytes: input.bytes.byteLength,
    sha256,
    description: String(input.description ?? "").slice(0, 200),
    width: size?.width ?? 0,
    height: size?.height ?? 0,
    created_at: createdAt,
  };
  await env.DB.prepare(
    `INSERT INTO site_assets (id, tenant_id, kind, name, mime, bytes, sha256, description, width, height, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  )
    .bind(
      asset.id,
      tenantId,
      asset.kind,
      asset.name,
      asset.mime,
      asset.bytes,
      asset.sha256,
      asset.description,
      asset.width,
      asset.height,
      createdAt,
    )
    .run();

  return { ok: true, value: asset };
}

/** 改一句话说明（只动元数据，不碰字节与 id）。返回 `false` = 这条不存在 */
export async function updateSiteAssetDescription(
  env: Env,
  tenantId: string,
  id: string,
  description: string,
): Promise<boolean> {
  const res = await env.DB.prepare(
    `UPDATE site_assets SET description = ? WHERE tenant_id = ? AND id = ? AND deleted_at IS NULL`,
  )
    .bind(String(description ?? "").slice(0, 200), tenantId, id)
    .run();
  return Number(res.meta?.changes ?? 0) > 0;
}

/**
 * 软删除。**不删 R2 的字节** —— 已发布的版本可能还在引用；真正回收留给以后的清理
 * 作业。返回 `false` 表示这条本来就不存在（幂等：重复删不报错）。
 */
export async function deleteSiteAsset(
  env: Env,
  tenantId: string,
  id: string,
): Promise<boolean> {
  const res = await env.DB.prepare(
    `UPDATE site_assets SET deleted_at = ? WHERE tenant_id = ? AND id = ? AND deleted_at IS NULL`,
  )
    .bind(new Date().toISOString(), tenantId, id)
    .run();
  return Number(res.meta?.changes ?? 0) > 0;
}
