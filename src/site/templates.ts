/**
 * 模板版本库：`tpl/<sha>/` 内容寻址 + `site_templates` 记账 + `site_settings.template_version` 指针。
 *
 * 契约：`clever-vpn-docs/docs/contracts/site-studio-crm.md` §4（包格式）、§5（交付）、
 * §7（版本化与对齐）、§9（存储）。
 *
 * 三条纪律，缺一条就出事故：
 *
 *   1. **内容寻址，不是版本寻址**。R2 键是 `tpl/<sha>/`，不是 `tpl/v7/`。同一个包
 *      被交付两次（或两个租户交付同样的包）只占一份；`v7` 只是这**一份内容**在
 *      这个租户里的名字。反过来，一旦按版本号存，"同内容不同版本"就会出现两份字节，
 *      而后的"内容是否变了"只能靠逐字节比。
 *   2. **版本不可变**。写进去的 `tpl/<sha>/` 永不修改；租户改模板 = 新 sha = 新键。
 *      回滚与审计才有意义。
 *   3. **幂等靠 sha（不加时间戳）**。同内容重复交付 → 返回已有版本号，
 *      `idempotent: true`。契约 §4.3 的"确定性"就是为这一条服务的。
 *
 * 与发布的关系：本模块只生产**模板版本**（候选）；上线仍然走 `publishSite()`
 * （渲染 + 注入 SDK + 写产物 + 切指针）。**交付 ≠ 上线**。
 */

import type { Env } from "../env";

/** R2 里模板包的前缀：`tpl/<sha-hex>/`（契约 §9） */
export const tplPrefix = (sha: string): string => `tpl/${stripSha(sha)}/`;

/** 包内固定文件名（契约 §4.1） */
export const MANIFEST_PATH = "manifest.json";
export const SCHEMA_PATH = "data.schema.json";
export const SAMPLE_PATH = "data.sample.json";
export const FILES_PREFIX = "files/";

/** 契约 §4.3 的硬上限（studio 侧先拦，这里兜底） */
export const TPL_LIMITS = {
  fileBytes: 2 << 20,
  totalBytes: 10 << 20,
  files: 1000,
} as const;

export interface TemplateFileInput {
  /** 包内相对路径：`index.html`、`assets/site.css`（不允许绝对路径与 `..`） */
  path: string;
  body: Uint8Array | string;
}

export interface TemplateManifest {
  package: number;
  engine: string;
  schema: number;
  capabilities: string[];
  studio_rev: number;
  base_package: string | null;
  preview: { engine: string; artifact_sha256: string };
  signoff: { by: string; at: string };
  files: { path: string; sha256: string; bytes: number }[];
}

export interface TemplateVersion {
  version: string;
  /** `sha256:<hex>` */
  sha: string;
  seq: number;
  parent_sha: string;
  engine: string;
  schema_version: number;
  files: number;
  bytes: number;
  created_by: string | null;
  created_at: string;
}

export type TemplateResult<T> =
  | ({ ok: true } & T)
  | { ok: false; code: string; message: string };

const err = <T>(code: string, message: string): TemplateResult<T> => ({
  ok: false,
  code,
  message,
});

export const stripSha = (sha: string): string =>
  sha.toLowerCase().replace(/^sha256:/, "");

const withSha = (hex: string): string => `sha256:${hex.toLowerCase()}`;

async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)]
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

const toBytes = (body: Uint8Array | string): Uint8Array =>
  typeof body === "string" ? new TextEncoder().encode(body) : body;

/**
 * 路径安全：模板包里的路径是**别人给的**，越界写会把文件放到别的租户前缀下。
 *
 * 只允许相对路径；拒绝绝对路径、`..`、反斜杠、空段、控制字符。上限 200 字符
 * （与站点产物一致，见 `publish.ts` 的 `SITE_LIMITS`）。
 */
export function checkTemplatePath(path: string): string | null {
  if (!path) return "路径为空";
  if (path.includes("\\")) return `不允许反斜杠：${path}`;
  if (path.startsWith("/")) return `不允许绝对路径：${path}`;
  if (/[\u0000-\u001f]/.test(path)) return `路径含控制字符：${JSON.stringify(path)}`;
  if (path.length > 200) return `路径过长：${path}`;
  for (const segment of path.split("/")) {
    if (!segment) return `路径含空段：${path}`;
    if (segment === "." || segment === "..") return `路径含越界段：${path}`;
  }
  return null;
}

/**
 * 包指纹：**只由文件内容决定**。
 *
 * 输入按路径排序后拼接 `path\0sha256\0bytes\n`，再取一次 SHA-256 —— 所以
 * 「文件顺序不同」「交付时间不同」「谁交付的」都不影响 sha（契约 §4.3 第 1 条）。
 */
export async function packageSha(
  entries: { path: string; sha256: string; bytes: number }[],
): Promise<string> {
  const lines = [...entries]
    .sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))
    .map((e) => `${e.path}\u0000${e.sha256}\u0000${e.bytes}`)
    .join("\n");
  return withSha(await sha256Hex(new TextEncoder().encode(lines)));
}

/** 逐文件算 sha，并在超限时立刻返回（不留半份） */
export async function describeFiles(
  files: TemplateFileInput[],
): Promise<TemplateResult<{ entries: NonNullable<TemplateManifest["files"]>; totalBytes: number }>> {
  if (files.length === 0) return err("site_manifest_invalid", "模板包为空");
  if (files.length > TPL_LIMITS.files) {
    return err("site_bundle_too_large", `文件数 ${files.length} 超过上限 ${TPL_LIMITS.files}`);
  }

  const seen = new Set<string>();
  const entries: NonNullable<TemplateManifest["files"]> = [];
  let totalBytes = 0;

  for (const file of files) {
    const problem = checkTemplatePath(file.path);
    if (problem) return err("site_path_rejected", problem);
    if (seen.has(file.path)) {
      return err("site_manifest_invalid", `重复路径：${file.path}`);
    }
    seen.add(file.path);

    const bytes = toBytes(file.body);
    if (bytes.byteLength > TPL_LIMITS.fileBytes) {
      return err(
        "site_bundle_too_large",
        `${file.path} 有 ${bytes.byteLength} 字节，超过单文件上限 ${TPL_LIMITS.fileBytes}`,
      );
    }
    totalBytes += bytes.byteLength;
    if (totalBytes > TPL_LIMITS.totalBytes) {
      return err("site_bundle_too_large", `整包超过上限 ${TPL_LIMITS.totalBytes} 字节`);
    }
    entries.push({ path: file.path, sha256: await sha256Hex(bytes), bytes: bytes.byteLength });
  }

  return { ok: true, entries, totalBytes };
}

export interface StoreTemplateInput {
  files: TemplateFileInput[];
  /** 渲染引擎版本；必须与 CRM 自己的一致（契约 §4.2），调用方先比 */
  engine: string;
  schemaVersion?: number;
  capabilities?: string[];
  studioRev?: number;
  /** 血缘：我改自哪一版 */
  basePackage?: string | null;
  preview?: { engine: string; artifact_sha256: string };
  signoff?: { by: string; at: string };
  actor?: string;
}

/**
 * 写一版模板（幂等）。
 *
 * 顺序：算 sha → 若这个 sha 在本租户已有版本，直接返回它 → 否则写 R2
 * （`tpl/<sha>/…`）→ 再插 D1 行并分配 `v<seq>`。
 *
 * **先写 R2 再写 D1**：R2 写失败就什么都没有；反过来会留下"有版本行、没有字节"的
 * 版本，发布时才发现读不到。R2 写入本身是幂等的（同键同内容），重复交付只是白写一次。
 */
export async function storeTemplate(
  env: Env,
  tenantId: string,
  input: StoreTemplateInput,
): Promise<TemplateResult<{ version: string; sha: string; idempotent: boolean }>> {
  const sites = env.SITES;
  if (!sites) {
    return err("r2_not_configured", "没有绑定 SITES（R2）：模板包无处可放");
  }

  const described = await describeFiles(input.files);
  if (!described.ok) return described;

  const sha = await packageSha(described.entries);
  const hex = stripSha(sha);

  // 幂等：同一份内容在这个租户下已经有了 —— 返回那一版，别分配新版本号。
  const existing = await env.DB.prepare(
    `SELECT version FROM site_templates WHERE tenant_id = ? AND sha = ? ORDER BY seq LIMIT 1`,
  )
    .bind(tenantId, sha)
    .first<{ version: string }>();
  if (existing) {
    return { ok: true, version: existing.version, sha, idempotent: true };
  }

  // 1) R2：`tpl/<sha>/files/<path>` + `manifest.json` + schema/sample
  const prefix = tplPrefix(sha);
  const manifest: TemplateManifest = {
    package: 1,
    engine: input.engine,
    schema: input.schemaVersion ?? 1,
    capabilities: input.capabilities ?? [],
    studio_rev: input.studioRev ?? 0,
    base_package: input.basePackage ?? null,
    preview: input.preview ?? { engine: input.engine, artifact_sha256: "" },
    signoff: input.signoff ?? { by: "", at: "" },
    files: described.entries,
  };

  for (const file of input.files) {
    const body = toBytes(file.body);
    await sites.put(`${prefix}${FILES_PREFIX}${file.path}`, body, {
      httpMetadata: { contentType: contentTypeOf(file.path) },
      customMetadata: { tpl_sha: sha },
    });
  }
  await sites.put(`${prefix}${MANIFEST_PATH}`, JSON.stringify(manifest, null, 2), {
    httpMetadata: { contentType: "application/json; charset=utf-8" },
  });

  // 2) D1：分配本租户的下一个版本号
  const maxRow = await env.DB.prepare(
    `SELECT COALESCE(MAX(seq), 0) AS n FROM site_templates WHERE tenant_id = ?`,
  )
    .bind(tenantId)
    .first<{ n: number }>();
  const seq = Number(maxRow?.n ?? 0) + 1;
  const version = `v${seq}`;

  try {
    await env.DB.prepare(
      `INSERT INTO site_templates
         (tenant_id, seq, version, parent_sha, sha, engine, schema_version, files, bytes, created_by, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
      .bind(
        tenantId,
        seq,
        version,
        input.basePackage ?? "",
        sha,
        input.engine,
        input.schemaVersion ?? 1,
        described.entries.length,
        described.totalBytes,
        input.actor ?? null,
        new Date().toISOString(),
      )
      .run();
  } catch {
    // 唯一索引挡住了并发：说明同一瞬间另一路已经交付了 v<seq>。
    // 这里不重试编号（重试会引入"分配了但没写"的空洞），交给调用方重试整次交付。
    return err("site_template_conflict", "有人同时在交付模板，请重试");
  }

  /**
   * 3) 指针：交付即成为"当前模板"（上线仍需 publish）。
   *
   * **必须是 upsert，不能只 UPDATE**：全新部署里 `site_settings` 还没有行（要等租户
   * 第一次保存设置才出现）。只 UPDATE 的话这里影响 0 行 —— 版本进了库、指针却是空的，
   * 表现是"交付成功但 studio 拉到的还是公共模板"。这个坑只在干净库上出现，
   * 本地测过一轮设置就再也复现不了。
   */
  await env.DB.prepare(
    "INSERT INTO site_settings (id, template_version, rev, updated_at) VALUES (1, ?, 1, ?) " +
      "ON CONFLICT(id) DO UPDATE SET template_version = excluded.template_version, " +
      "rev = site_settings.rev + 1, updated_at = excluded.updated_at",
  )
    .bind(version, new Date().toISOString())
    .run();

  return { ok: true, version, sha, idempotent: false };
}

/** 读一版模板（`version` 为空时读当前指针；都没有则返回 null） */
export async function readTemplateVersion(
  env: Env,
  tenantId: string,
  version?: string,
): Promise<TemplateVersion | null> {
  const wanted = version?.trim() ?? "";
  const row = wanted
    ? await env.DB.prepare(
        `SELECT * FROM site_templates WHERE tenant_id = ? AND version = ? LIMIT 1`,
      )
        .bind(tenantId, wanted)
        .first<Record<string, unknown>>()
    : await env.DB.prepare(
        `SELECT t.* FROM site_templates t
           JOIN site_settings s ON s.template_version = t.version AND s.id = 1
          WHERE t.tenant_id = ?
          ORDER BY t.seq DESC LIMIT 1`,
      )
        .bind(tenantId)
        .first<Record<string, unknown>>();
  return row ? toVersion(row) : null;
}

/** 版本列表（最新在前），用于"从历史版本开新草稿" */
export async function listTemplateVersions(
  env: Env,
  tenantId: string,
  limit = 20,
): Promise<TemplateVersion[]> {
  const rows = await env.DB.prepare(
    `SELECT * FROM site_templates WHERE tenant_id = ? ORDER BY seq DESC LIMIT ?`,
  )
    .bind(tenantId, Math.max(1, Math.min(limit, 100)))
    .all<Record<string, unknown>>();
  return (rows.results ?? []).map(toVersion);
}

function toVersion(row: Record<string, unknown>): TemplateVersion {
  return {
    version: String(row.version),
    sha: String(row.sha),
    seq: Number(row.seq),
    parent_sha: String(row.parent_sha ?? ""),
    engine: String(row.engine),
    schema_version: Number(row.schema_version ?? 1),
    files: Number(row.files ?? 0),
    bytes: Number(row.bytes ?? 0),
    created_by: row.created_by === null || row.created_by === undefined ? null : String(row.created_by),
    created_at: String(row.created_at ?? ""),
  };
}

/** 读回一版模板的文件（`files/<path>`）；用于 `GET /api/site/template` */
export async function readTemplateFiles(
  env: Env,
  sha: string,
): Promise<{ path: string; body: ArrayBuffer }[]> {
  const sites = env.SITES;
  if (!sites) return [];
  const prefix = `${tplPrefix(sha)}${FILES_PREFIX}`;
  // R2 的 `limit` 上限是 1000（含）；超上限会直接报 10022。
  const listed = await sites.list({ prefix, limit: Math.min(TPL_LIMITS.files, 1000) });
  const out: { path: string; body: ArrayBuffer }[] = [];
  for (const object of listed.objects) {
    if (object.key.endsWith("/")) continue;
    const got = await sites.get(object.key);
    if (!got) continue;
    out.push({ path: object.key.slice(prefix.length), body: await got.arrayBuffer() });
  }
  return out.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
}

function contentTypeOf(path: string): string {
  const ext = path.slice(path.lastIndexOf(".") + 1).toLowerCase();
  const map: Record<string, string> = {
    html: "text/html; charset=utf-8",
    css: "text/css; charset=utf-8",
    js: "text/javascript; charset=utf-8",
    mjs: "text/javascript; charset=utf-8",
    json: "application/json; charset=utf-8",
    txt: "text/plain; charset=utf-8",
    xml: "application/xml; charset=utf-8",
    svg: "image/svg+xml",
    png: "image/png",
    jpg: "image/jpeg",
    jpeg: "image/jpeg",
    webp: "image/webp",
    gif: "image/gif",
    ico: "image/x-icon",
    woff2: "font/woff2",
  };
  return map[ext] ?? "application/octet-stream";
}
