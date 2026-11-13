/**
 * `GET /api/site/template` —— **重建用**的源包（契约 `site-studio-crm.md` §0.1.4）。
 *
 * studio 的 DO 是可弃的：租户从 CRM 进来、DO 是空的时，按这张表决定给他哪一份源包：
 *
 * | 场景 | 来源 |
 * |---|---|
 * | 发布过 | **最近一次发布记录的 `source_sha`** |
 * | 从没发布过（新租户，或只在 studio 里改过还没发） | **当前部署的种子** |
 *
 * 两条硬规则：
 *
 *   1. **取不到就报错，绝不降级。** 内容缺失 / R2 不可用时返回 `null`，调用方回
 *      404，studio 必须**挡住**（不建草稿、不建空站）。给一个空站或换一份骨架，
 *      租户看起来都是"我的网站没了"。
 *   2. **对齐只看 sha。** 版本号是发布记录的事；这里给的是内容。
 *
 * 返回值里没有 `template_version` —— 那个概念在 Contract 14 里已经不存在。
 */

import { ENGINE_ID } from "./engine.generated";
import { SITE_CONTRACT } from "./meta";
import { latestRelease } from "./publish";
import { describeFiles, readSource, seedFiles, seedSha, sourceSha } from "./source";

import type { Env } from "../env";

export interface SourceFileOut {
  path: string;
  sha256: string;
  bytes: number;
  /** base64（二进制安全；文本自己解码） */
  content_b64: string;
}

/** `release` = 已发布的那份源包；`seed` = 还没发布过，用部署自带的种子 */
export type SourceOrigin = "release" | "seed";

export interface SiteSourceOut {
  source: SourceOrigin;
  /** `sha256:<hex>` —— 对齐只看这个 */
  sha: string;
  engine: string;
  contract: number;
  /**
   * 全部文件（文本 + 图片），`content_b64` 是字节。
   *
   * 2026-11-13 起不再有 `assets` 映射：图片就是文件，重建草稿时按路径写回去即可，
   * 不需要"把指针还原"这一步。
   */
  files: SourceFileOut[];
}

const b64 = (bytes: Uint8Array): string => {
  let text = "";
  for (const byte of bytes) text += String.fromCharCode(byte);
  return btoa(text);
};

const toBytes = (body: Uint8Array | string): Uint8Array =>
  typeof body === "string" ? new TextEncoder().encode(body) : body;

/** 把一组 `{path, bytes}` 打包成对外形状，并用**发布时同一个算法**算 sha */
async function pack(
  origin: SourceOrigin,
  raw: { path: string; body: ArrayBuffer }[],
): Promise<SiteSourceOut | null> {
  if (raw.length === 0) return null;
  const files = raw.map((f) => ({ path: f.path, body: new Uint8Array(f.body) }));
  const described = await describeFiles(files);
  // 路径不安全 / 超限：**不返回半个包**，让调用方看到"没有源包"而不是一个坏包
  if (!described.ok) return null;

  const sha = await sourceSha(described.entries);
  const byPath = new Map(files.map((f) => [f.path, f.body]));
  const out: SourceFileOut[] = described.entries.map((entry) => ({
    path: entry.path,
    sha256: entry.sha256,
    bytes: entry.bytes,
    content_b64: b64(byPath.get(entry.path) ?? new Uint8Array(0)),
  }));

  return {
    source: origin,
    sha,
    engine: ENGINE_ID,
    contract: SITE_CONTRACT,
    files: out,
  };
}

/**
 * 取重建用的源包。返回 `null` ⇒ 调用方回 `404`，studio 必须挡住、不许自己造一份。
 */
export async function siteSourceOf(env: Env, tenantId: string): Promise<SiteSourceOut | null> {
  const latest = await latestRelease(env, tenantId);
  if (latest) {
    const raw = await readSource(env, latest.sourceSha);
    const packed = await pack("release", raw);
    if (packed) {
      // 用**库里记的** sha，而不是重算的：内容寻址意味着两者必须相等，不相等就是
      // 存储坏了（这时宁可暴露出来，也不要悄悄用另一个值）
      return { ...packed, sha: latest.sourceSha };
    }
    // 发布过但内容读不到 ⇒ 明确失败，**不退回种子**（否则等于把租户的站换掉）
    return null;
  }

  const seed = seedFiles().map((f) => {
    const bytes = toBytes(f.body);
    return { path: f.path, body: bytes.buffer.slice(0) as ArrayBuffer };
  });
  const packed = await pack("seed", seed);
  if (!packed) return null;
  return { ...packed, sha: await seedSha() };
}
