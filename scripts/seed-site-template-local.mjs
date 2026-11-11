#!/usr/bin/env node
/**
 * 把仓库里的 `site-template/` 种进**本地** R2：`clever-sites/g/templates/basic/v1/…`
 *
 * 为什么需要它：CRM 的公共模板不在仓库里生效，而是在 R2 里（`g/templates/<名>/<版本>/`，
 * 见 `src/site/template-source.ts`）。线上由 `npm run site:template:upload` 传；**本地
 * 以前没人传** —— 于是本地 R2 里只有一份手工丢进去的单页 `index.html`，设计器打开只有
 * 1 个文件，看起来像"模板只有一页"。
 *
 * 用法：
 *   npm run site:template:local          # 写进 .wrangler/state（wrangler dev 用的那份）
 *   npm run site:template:local -- --dry # 只打印要传什么
 *
 * 幂等：同名覆盖。本地不需要版本不可变（线上才需要，见 upload-site-template.mjs）。
 */
import { readdirSync, statSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const SRC = join(ROOT, "site-template");
const BUCKET = process.env.SITES_BUCKET ?? "clever-sites";
const TEMPLATE = process.env.PUBLIC_TEMPLATE_NAME ?? "basic";
const VERSION = process.env.PUBLIC_TEMPLATE_VERSION ?? "v1";
const WRANGLER = join(ROOT, "node_modules/.bin/wrangler");

/** 不是站点产物的文件：传进去反而会让闸门报 `bad_extension`（.md 不在白名单）。 */
const SKIP = new Set(["README.md"]);

const dry = process.argv.includes("--dry");

function walk(dir, out = []) {
  for (const name of readdirSync(dir)) {
    const abs = join(dir, name);
    if (statSync(abs).isDirectory()) walk(abs, out);
    else out.push(abs);
  }
  return out;
}

const files = walk(SRC)
  .map((abs) => relative(SRC, abs))
  .filter((rel) => !SKIP.has(rel))
  .sort();

if (files.length === 0) {
  console.error(`✘ ${SRC} 里没有可上传的文件`);
  process.exit(1);
}

console.log(`→ ${BUCKET}/g/templates/${TEMPLATE}/${VERSION}/  （${files.length} 个文件）`);
for (const rel of files) console.log(`   · ${rel}`);

if (dry) process.exit(0);

for (const rel of files) {
  const key = `${BUCKET}/g/templates/${TEMPLATE}/${VERSION}/${rel}`;
  const result = spawnSync(WRANGLER, ["r2", "object", "put", key, `--file=${join(SRC, rel)}`, "--local"], {
    cwd: ROOT,
    stdio: ["ignore", "pipe", "pipe"],
    encoding: "utf8",
  });
  if (result.status !== 0) {
    console.error(`✘ 传 ${rel} 失败\n${result.stderr || result.stdout}`);
    process.exit(1);
  }
}

console.log(`\n✓ 本地公共模板已就绪：${files.length} 个文件（重新打开设计器即可看到）`);
