#!/usr/bin/env node
/**
 * 生成 `src/site/engine.generated.ts`：渲染引擎的版本号 = **源码的 sha256 前 16 位**。
 *
 *   node scripts/gen-engine.mjs          写文件
 *   node scripts/gen-engine.mjs --check  只校验（CI / 单测用）
 *
 * 为什么不是手填 semver：手填的版本号会与代码脱钩 —— 改了渲染逻辑却忘了 +1，
 * 两侧就开始"同版本号、不同行为"，而这正是预览与发布漂移的源头。
 * 同一条规则在 `clever-vpn-site-studio` 的 `src/site/engine.generated.ts` 里，
 * 那边的副本由 `scripts/sync-render.mjs` 从**本仓**逐字节复制并算同一个哈希。
 *
 * 规范：`site-template.md` §9.1 / 契约 `site-studio-crm.md` §4.2。
 */
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const RENDER = join(root, "src/site/render.ts");
const OUT = join(root, "src/site/engine.generated.ts");

const sha = createHash("sha256").update(readFileSync(RENDER)).digest("hex");
const id = `sha256:${sha.slice(0, 16)}`;

const content = `/**
 * **生成文件，不要手改。** 由 \`npm run engine:sync\` 产出，CI 校验一致性。
 *
 * \`ENGINE_ID\` = 渲染器源码的 sha256 前 16 位（\`site-template.md\` §9.1）。
 * 改了 \`src/site/render.ts\` 就必须重新生成，否则两侧会"同版本号、不同行为"。
 */
export const ENGINE_ID = "${id}";

/** 完整哈希（排障 / 上游比对用；对外协商只认 \`ENGINE_ID\`） */
export const ENGINE_SHA256 = "${sha}";
`;

if (process.argv.includes("--check")) {
  let current = "";
  try {
    current = readFileSync(OUT, "utf8");
  } catch {
    console.error(`✗ 缺少 ${OUT}，跑 npm run engine:sync`);
    process.exit(1);
  }
  if (current !== content) {
    console.error("✗ engine.generated.ts 与 render.ts 不一致，跑 npm run engine:sync");
    process.exit(1);
  }
  console.log(`✓ ENGINE_ID = ${id}`);
} else {
  writeFileSync(OUT, content);
  console.log(`✓ ENGINE_ID = ${id}`);
}
