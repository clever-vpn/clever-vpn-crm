/**
 * **源包与种子**（契约 `site-studio-crm.md` §0.1）。
 *
 * 全系统只有两种东西：
 *
 *   · **种子** —— CRM 仓库里的 `site-template/`，随部署走，**没有版本号**。它只在
 *     "CRM 里还没有该租户源包"时被读一次（新租户建站）。
 *   · **租户源包** —— 带占位符的一堆文件。工作副本在 studio 的 DO（可弃）；**已发布**
 *     的那份在 R2 `tpl/<sha>/files/`，并由 `site_releases` 的 `source_sha` 指向。
 *
 * 三条纪律：
 *
 *   1. **内容寻址，不是版本寻址**。键是 `tpl/<sha>/`，不是 `tpl/v7/`。同一份内容被
 *      发布多次（或多个租户交出同样的包）只占一份；版本号是**发布记录**的事。
 *   2. **写进去的 `tpl/<sha>/` 永不修改**。改源包 = 新 sha = 新键。
 *   3. **幂等靠 sha**（不加时间戳）：同内容重复提交不会多占字节。
 *
 * 这里**不**记账、**不**分配版本号 —— 那是 `publish.ts` 的事。源包可以在"还没发布成功"
 * 的状态下存在于 R2（内容寻址的孤儿），但它**不会**成为任何可引用的版本。
 */

import type { Env } from "../env";
import { SEED_BINARY, SEED_FILES } from "./seed.generated";

/** R2 里源包的前缀：`tpl/<sha-hex>/`（契约 §9） */
export const tplPrefix = (sha: string): string => `tpl/${stripSha(sha)}/`;

/** 包内子目录 */
export const FILES_PREFIX = "files/";

/**
 * 契约 §4.3 / `site-assets.md` §6 的硬上限（studio 侧先拦，这里兜底）。
 *
 * `totalBytes` 数的是**整版产物**：文本 + 素材字节。两者原来混在一起用 10 MB，
 * 于是一个正常站点（6 张 1.5 MB 的图）会撞墙，而 studio 那边的 8 MB 只数文本
 * —— 它不是同一个口径，别拿它当参照。素材单张 2 MB 时，32 MB 够放 15 张左右。
 */
export const TPL_LIMITS = {
  fileBytes: 2 << 20,
  totalBytes: 32 << 20,
  files: 1000,
} as const;

export interface SourceFileInput {
  /** 包内相对路径：`index.html`、`assets/site.css`（不允许绝对路径与 `..`） */
  path: string;
  body: Uint8Array | string;
  /**
   * 这个文件是**素材物化**来的（原指针的 id）。
   *
   * 记在 R2 对象元数据里，是为了"重置草稿"能把它还原成指针：源包里存的是字节，
   * 但草稿只认指针（契约 `site-assets.md` §1）。不记的话，重置一次租户的图就全丢了。
   */
  assetId?: string;
}

export interface SourceEntry {
  path: string;
  sha256: string;
  bytes: number;
}

export type SourceResult<T> = ({ ok: true } & T) | { ok: false; code: string; message: string };

const err = <T>(code: string, message: string): SourceResult<T> => ({
  ok: false,
  code,
  message,
});

export const stripSha = (sha: string): string => sha.toLowerCase().replace(/^sha256:/, "");

const withSha = (hex: string): string => `sha256:${hex.toLowerCase()}`;

async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

const toBytes = (body: Uint8Array | string): Uint8Array =>
  typeof body === "string" ? new TextEncoder().encode(body) : body;

/**
 * 路径安全：源包里的路径是**别人给的**，越界写会把文件放到别的租户前缀下。
 *
 * 只允许相对路径；拒绝绝对路径、`..`、反斜杠、空段、控制字符。上限 200 字符。
 */
export function checkSourcePath(path: string): string | null {
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
 * 源包指纹：**只由文件内容决定**。
 *
 * 输入按路径排序后拼接 `path\0sha256\0bytes\n`，再取一次 SHA-256 —— 文件顺序、
 * 提交时间、谁提交的都不影响 sha（契约 §4.3 第 1 条）。
 */
export async function sourceSha(entries: SourceEntry[]): Promise<string> {
  const lines = [...entries]
    .sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))
    .map((e) => `${e.path}\u0000${e.sha256}\u0000${e.bytes}`)
    .join("\n");
  return withSha(await sha256Hex(new TextEncoder().encode(lines)));
}

/** 逐文件算 sha，并在超限时立刻返回（不留半份） */
export async function describeFiles(
  files: SourceFileInput[],
): Promise<SourceResult<{ entries: SourceEntry[]; totalBytes: number }>> {
  if (files.length === 0) return err("site_manifest_invalid", "源包为空");
  if (files.length > TPL_LIMITS.files) {
    return err("site_bundle_too_large", `文件数 ${files.length} 超过上限 ${TPL_LIMITS.files}`);
  }

  const seen = new Set<string>();
  const entries: SourceEntry[] = [];
  let totalBytes = 0;

  for (const file of files) {
    const problem = checkSourcePath(file.path);
    if (problem) return err("site_path_rejected", problem);
    if (seen.has(file.path)) return err("site_manifest_invalid", `重复路径：${file.path}`);
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

const TEXT_EXT = new Set([
  "html",
  "htm",
  "css",
  "js",
  "mjs",
  "json",
  "txt",
  "xml",
  "svg",
  "webmanifest",
]);

const contentTypeOf = (path: string): string => {
  const ext = path.slice(path.lastIndexOf(".") + 1).toLowerCase();
  const map: Record<string, string> = {
    html: "text/html; charset=utf-8",
    htm: "text/html; charset=utf-8",
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
};

/**
 * 把源包写进 R2（`tpl/<sha>/files/<path>`），返回它的 sha。
 *
 * **只写不记账**：发布成功与否由 `publishSite()` 决定。已存在的对象直接跳过 ——
 * 内容寻址意味着"同 sha 同字节"，重写没有任何意义（还多花一次 PUT）。
 */
export async function storeSource(
  env: Env,
  files: SourceFileInput[],
): Promise<SourceResult<{ sha: string; entries: SourceEntry[]; totalBytes: number }>> {
  const sites = env.SITES;
  if (!sites) return err("r2_not_configured", "没有绑定 SITES（R2）：源包无处可放");

  const described = await describeFiles(files);
  if (!described.ok) return described;

  const sha = await sourceSha(described.entries);
  const prefix = `${tplPrefix(sha)}${FILES_PREFIX}`;

  const existing = await sites.list({ prefix, limit: described.entries.length + 1 });
  const have = new Set(existing.objects.filter((o) => !o.key.endsWith("/")).map((o) => o.key));

  for (const file of files) {
    const key = `${prefix}${file.path}`;
    if (have.has(key)) continue;
    await sites.put(key, toBytes(file.body), {
      httpMetadata: { contentType: contentTypeOf(file.path) },
      customMetadata: {
        source_sha: sha,
        // 素材物化来的文件带上原指针：重置草稿时按它还原，图不会凭空消失
        ...(file.assetId ? { asset_id: file.assetId } : {}),
      },
    });
  }

  return { ok: true, sha, entries: described.entries, totalBytes: described.totalBytes };
}

/** 读回一份源包（按路径排序）。内容缺失时返回空数组，由调用方决定怎么报错。 */
export async function readSource(
  env: Env,
  sha: string,
): Promise<{ path: string; body: ArrayBuffer; assetId?: string }[]> {
  const sites = env.SITES;
  if (!sites) return [];
  const prefix = `${tplPrefix(sha)}${FILES_PREFIX}`;
  // `include: ['customMetadata']`：素材指针记在那里，少一次 head 请求
  const listed = await sites.list({
    prefix,
    limit: Math.min(TPL_LIMITS.files, 1000),
    include: ["customMetadata"],
  });
  const out: { path: string; body: ArrayBuffer; assetId?: string }[] = [];
  for (const object of listed.objects) {
    if (object.key.endsWith("/")) continue;
    const got = await sites.get(object.key);
    if (!got) continue;
    const assetId = object.customMetadata?.asset_id ?? got.customMetadata?.asset_id;
    out.push({
      path: object.key.slice(prefix.length),
      body: await got.arrayBuffer(),
      ...(assetId ? { assetId } : {}),
    });
  }
  return out.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
}

/* ── 种子 ─────────────────────────────────────────────────────────── */

/** 种子文件（来自 `site-template/`，由 `npm run seed:gen` 生成） */
export function seedFiles(): SourceFileInput[] {
  const out: SourceFileInput[] = [];
  for (const [path, text] of Object.entries(SEED_FILES)) out.push({ path, body: text });
  for (const [path, b64] of Object.entries(SEED_BINARY)) {
    const raw = atob(b64);
    const bytes = new Uint8Array(raw.length);
    for (let i = 0; i < raw.length; i += 1) bytes[i] = raw.charCodeAt(i);
    out.push({ path, body: bytes });
  }
  return out;
}

let seedShaCache: Promise<string> | null = null;

/** 种子的内容指纹（血缘戳 `seed_sha`）。按 isolate 缓存一次。 */
export function seedSha(): Promise<string> {
  if (!seedShaCache) {
    seedShaCache = (async () => {
      const described = await describeFiles(seedFiles());
      if (!described.ok) throw new Error(`种子不合法：${described.message}`);
      return sourceSha(described.entries);
    })();
  }
  return seedShaCache;
}

/** 内容是否是文本（决定发布时要不要做占位符替换） */
export const isTextPath = (path: string): boolean =>
  TEXT_EXT.has(path.slice(path.lastIndexOf(".") + 1).toLowerCase());
