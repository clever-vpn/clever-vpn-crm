#!/usr/bin/env node
/**
 * 把仓库里的 `site-template/` 上传成 R2 模板：`g/templates/basic/v1/…`
 *
 * 为什么模板要进 R2 而不是打进 Worker：
 *   1. Worker 只负责**实例化 + 写产物**，模板是可替换的数据，不是代码；
 *   2. 模板改一次不该触发一次 Worker 部署（`site-delivery.md` §9.2 也是这么定的：
 *      "发布 workflow 在部署时把模板上传到 R2，并把版本号写入 CRM 配置"）；
 *   3. studio 交付的模板将来也走同一条前缀，CRM 只认 `g/templates/<名>/<版本>/`。
 *
 * 用法（需要 R2 写权限的 token）：
 *   CLOUDFLARE_API_TOKEN=… node scripts/upload-site-template.mjs
 *   CLOUDFLARE_API_TOKEN=… node scripts/upload-site-template.mjs --version v2
 *
 * 幂等：同名同内容重放安全（覆盖 PUT）；不同内容请换 `--version`，
 * 因为**版本不可变**是发布回滚的前提。
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const SRC = join(ROOT, "site-template");

const arg = (name, fallback) => {
  const i = process.argv.indexOf(`--${name}`);
  if (i === -1) return fallback;
  const v = process.argv[i + 1];
  return v && !v.startsWith("--") ? v : true;
};

const ACCOUNT = process.env.CLOUDFLARE_ACCOUNT_ID;
const TOKEN = process.env.CLOUDFLARE_API_TOKEN;
const BUCKET = arg("bucket", process.env.SITES_BUCKET ?? "clever-sites");
const TEMPLATE = arg("template", "basic");
const VERSION = arg("version", "v1");

if (!ACCOUNT || !TOKEN) {
  console.error("✘ 需要 CLOUDFLARE_ACCOUNT_ID 与 CLOUDFLARE_API_TOKEN（R2 写权限）");
  process.exit(1);
}

const MIME = {
  html: "text/html; charset=utf-8",
  css: "text/css; charset=utf-8",
  js: "text/javascript; charset=utf-8",
  json: "application/json; charset=utf-8",
  svg: "image/svg+xml",
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  webp: "image/webp",
  ico: "image/x-icon",
  txt: "text/plain; charset=utf-8",
  xml: "application/xml; charset=utf-8",
  woff2: "font/woff2",
};

/** 递归列出模板文件（跳过 README 与隐藏文件：它们不是站点产物） */
function walk(dir, out = []) {
  for (const name of readdirSync(dir)) {
    if (name.startsWith(".")) continue;
    const abs = join(dir, name);
    if (statSync(abs).isDirectory()) walk(abs, out);
    else if (!/^readme\.md$/i.test(name)) out.push(abs);
  }
  return out;
}

const files = walk(SRC);
if (files.length === 0) {
  console.error(`✘ ${SRC} 里没有文件`);
  process.exit(1);
}

const prefix = `g/templates/${TEMPLATE}/${VERSION}/`;
let bytes = 0;

for (const abs of files) {
  const rel = relative(SRC, abs).split("\\").join("/");
  const body = readFileSync(abs);
  const ext = rel.slice(rel.lastIndexOf(".") + 1).toLowerCase();
  const url =
    `https://api.cloudflare.com/client/v4/accounts/${ACCOUNT}` +
    `/r2/buckets/${BUCKET}/objects/${encodeURIComponent(prefix + rel)}`;

  const res = await fetch(url, {
    method: "PUT",
    headers: {
      Authorization: `Bearer ${TOKEN}`,
      "content-type": MIME[ext] ?? "application/octet-stream",
    },
    body,
  });
  if (!res.ok) {
    console.error(`✘ ${prefix + rel}: ${res.status} ${await res.text()}`);
    process.exit(1);
  }
  bytes += body.length;
  console.error(`  ↑ ${prefix}${rel} (${body.length} B)`);
}

console.error(
  `✔ 模板已上传：${prefix} —— ${files.length} 个文件 / ${bytes} B → ${BUCKET}`,
);
console.error("  下一步：后台「网站」页点发布（或 POST /api/admin/site/publish）");
