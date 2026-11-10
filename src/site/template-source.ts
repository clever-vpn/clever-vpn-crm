/**
 * `GET /api/site/template` —— 拉当前模板（契约 §7.3）。
 *
 * 三态：
 *
 * | 租户状态 | 返回 |
 * |---|---|
 * | 有租户模板（`site_settings.template_version` 指向一版） | `source: "tenant"`，读 `tpl/<sha>/files/` |
 * | 没有 | `source: "public"`，读公共模板 `g/templates/<name>/<version>/` |
 *
 * **对齐只看 `sha`**（契约 §7.3）：同一个模板版本可以被不同数据发布多次，版本号不是
 * 内容。所以两种来源都用同一套 `describeFiles` + `packageSha` 算 sha —— 与交付时
 * 同一个算法，`base_package` 才能直接比。
 *
 * 文件用 base64 传（`content_b64`）：模板里有 png/woff2，按文本传会在客户端悄悄变形。
 *
 * 这与"契约归 CRM"（v8）不冲突：模板**文件**本来就是租户/平台的内容，不是数据契约。
 * 数据契约走 `/api/site/meta`，两者是两件事。
 */

import { ENGINE_ID } from "./engine.generated";
import { SITE_CONTRACT } from "./meta";
import {
  FILES_PREFIX,
  describeFiles,
  packageSha,
  readTemplateFiles,
  readTemplateVersion,
  tplPrefix,
} from "./templates";

import type { Env } from "../env";

/** 公共模板的位置（与 `scripts/upload-site-template.mjs` 一致） */
export const PUBLIC_TEMPLATE_NAME = "basic";
export const PUBLIC_TEMPLATE_VERSION = "v1";

export interface TemplateFileOut {
  path: string;
  sha256: string;
  bytes: number;
  /** base64（二进制安全；文本自己解码） */
  content_b64: string;
}

export type TemplateSource = "tenant" | "public";

export interface SiteTemplateOut {
  source: TemplateSource;
  template_version: string;
  /** `sha256:<hex>` —— 对齐只看这个 */
  sha: string;
  engine: string;
  contract: number;
  files: TemplateFileOut[];
}

const PUBLIC_PREFIX = `g/templates/${PUBLIC_TEMPLATE_NAME}/${PUBLIC_TEMPLATE_VERSION}/`;

const b64 = (bytes: Uint8Array): string => {
  let text = "";
  for (const byte of bytes) text += String.fromCharCode(byte);
  return btoa(text);
};

/** 把一组 `{path, bytes}` 打包成对外形状，并用**交付时同一个算法**算 sha */
async function pack(raw: { path: string; body: ArrayBuffer }[]): Promise<SiteTemplateOut | null> {
  if (raw.length === 0) return null;
  const files = raw.map((f) => ({ path: f.path, body: new Uint8Array(f.body) }));
  const described = await describeFiles(files);
  // 路径不安全 / 超限：**不返回半个包**，让调用方看到"没有模板"而不是一个坏包
  if (!described.ok) return null;

  const sha = await packageSha(described.entries);
  const byPath = new Map(files.map((f) => [f.path, f.body]));
  const out: TemplateFileOut[] = described.entries.map((entry) => ({
    path: entry.path,
    sha256: entry.sha256,
    bytes: entry.bytes,
    content_b64: b64(byPath.get(entry.path) ?? new Uint8Array(0)),
  }));

  return {
    source: "public",
    template_version: PUBLIC_TEMPLATE_VERSION,
    sha,
    engine: ENGINE_ID,
    contract: SITE_CONTRACT,
    files: out,
  };
}

/** 公共模板：`g/templates/basic/v1/…` */
async function readPublic(env: Env): Promise<SiteTemplateOut | null> {
  const sites = env.SITES;
  if (!sites) return null;
  const listed = await sites.list({ prefix: PUBLIC_PREFIX, limit: 1000 });
  const objects = listed.objects.filter((o) => !o.key.endsWith("/"));
  if (objects.length === 0) return null;

  const raw: { path: string; body: ArrayBuffer }[] = [];
  for (const object of objects) {
    const got = await sites.get(object.key);
    if (!got) continue;
    raw.push({ path: object.key.slice(PUBLIC_PREFIX.length), body: await got.arrayBuffer() });
  }
  raw.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  return pack(raw);
}

/**
 * 取当前模板。**租户有就用租户的，否则用公共的**；两者都没有返回 `null`
 * （调用方回 404 `site_template_missing`，让 studio 说"还没有模板"而不是白屏）。
 */
export async function siteTemplateOf(env: Env, tenantId: string): Promise<SiteTemplateOut | null> {
  const current = await readTemplateVersion(env, tenantId);
  if (current) {
    const raw = await readTemplateFiles(env, current.sha);
    const packed = await pack(raw);
    if (packed) {
      return {
        ...packed,
        source: "tenant",
        template_version: current.version,
        // 用**库里记的** sha，而不是重算的：内容寻址意味着两者必须相等，不相等就是
        // 存储坏了（这时宁可暴露出来，也不要悄悄用另一个值）
        sha: current.sha,
        engine: current.engine || packed.engine,
      };
    }
  }
  return readPublic(env);
}

/** 排障用：`tpl/<sha>/` 前缀（日志里不打印完整 key 时用得上） */
export const templatePrefixOf = (sha: string): string => `${tplPrefix(sha)}${FILES_PREFIX}`;
