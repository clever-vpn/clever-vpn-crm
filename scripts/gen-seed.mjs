#!/usr/bin/env node
/**
 * 生成 `src/site/seed.generated.ts` —— 把 `site-template/` 变成能打进 Worker 的常量。
 *
 * 为什么不用 `import html from "../site-template/index.html"`：
 * wrangler 的默认模块规则只覆盖 `.txt/.html/.sql`，`.css` / `.js` 会被当成模块
 * 解析而报错；而自己写一条 `Text` 规则会和默认规则冲突（见 cf-workers 踩坑记录：
 * 同 type 的规则只留第一条，写了反而让默认的那条失效）。**生成一个 TS 文件**没有
 * 这些副作用，产物可复现，CI 里 `npm run seed:check` 能发现"改了模板忘了重新生成"。
 *
 * 用法：
 *   node scripts/gen-seed.mjs            # 写文件
 *   node scripts/gen-seed.mjs --check    # 只校验，不一致退出码 1（CI 用）
 */

import { readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";

const ROOT = process.cwd();
const SRC_DIR = join(ROOT, "site-template");
const OUT = join(ROOT, "src", "site", "seed.generated.ts");

/** 不进种子的文件：README 是给人看的说明，不是站点的内容 */
const SKIP = new Set(["README.md"]);

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

const extOf = (path) => path.slice(path.lastIndexOf(".") + 1).toLowerCase();

function walk(dir) {
  const out = [];
  for (const name of readdirSync(dir).sort()) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) out.push(...walk(full));
    else out.push(full);
  }
  return out;
}

const text = {};
const binary = {};
for (const file of walk(SRC_DIR)) {
  const rel = relative(SRC_DIR, file).split("\\").join("/");
  if (SKIP.has(rel)) continue;
  const bytes = readFileSync(file);
  if (TEXT_EXT.has(extOf(rel))) text[rel] = bytes.toString("utf8");
  else binary[rel] = bytes.toString("base64");
}

const q = (s) => JSON.stringify(s);
const body = `/**
 * 由 \`npm run seed:gen\` 生成（\`scripts/gen-seed.mjs\`），**别手改**。
 *
 * 唯一来源是仓库里的 \`site-template/\` —— 种子是**代码**，不是数据（契约
 * \`site-studio-crm.md\` §0.1.2）：它随部署走，没有版本号，只在"CRM 里还没有该租户
 * 源包"时被读一次。
 *
 * 文本文件进 \`SEED_FILES\`，二进制进 \`SEED_BINARY\`（base64）。
 * 改了模板请重跑 \`npm run seed:gen\`，否则 \`npm run seed:check\`（CI）会失败。
 */

export const SEED_FILES: Record<string, string> = {
${Object.entries(text)
  .map(([k, v]) => `  ${q(k)}: ${q(v)},`)
  .join("\n")}
};

export const SEED_BINARY: Record<string, string> = {
${Object.entries(binary)
  .map(([k, v]) => `  ${q(k)}: ${q(v)},`)
  .join("\n")}
};
`;

if (process.argv.includes("--check")) {
  let current = "";
  try {
    current = readFileSync(OUT, "utf8");
  } catch {
    current = "";
  }
  if (current !== body) {
    console.error("✗ seed.generated.ts 与 site-template/ 不一致：跑 npm run seed:gen");
    process.exit(1);
  }
  console.log(`✓ 种子与 site-template/ 一致（${Object.keys(text).length} 文本 / ${Object.keys(binary).length} 二进制）`);
} else {
  writeFileSync(OUT, body);
  console.log(
    `✓ 写入 ${relative(ROOT, OUT)}：${Object.keys(text).length} 文本 / ${Object.keys(binary).length} 二进制`,
  );
}
