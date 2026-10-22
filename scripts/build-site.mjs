#!/usr/bin/env node
/**
 * 把 `site/` 里的静态页复制到 `web/dist/`（Worker 的 assets 根目录）。
 *
 * 为什么不用 vite 的 `public/`：vite 的 root 是 `web/`、产物在 `web/dist/admin`，
 * 而官网必须落在 assets 根（`/index.html`），所以单独复制一层。
 * 纯文件操作，无依赖。
 */
import { cpSync, mkdirSync, readdirSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const SRC = join(ROOT, "site");
const OUT = join(ROOT, "web", "dist");

mkdirSync(OUT, { recursive: true });

// 只清理上次复制过来的官网文件，避免删掉 vite 产物（dist/admin）。
for (const entry of readdirSync(OUT)) {
  if (entry === "admin") continue;
  rmSync(join(OUT, entry), { recursive: true, force: true });
}

cpSync(SRC, OUT, { recursive: true });
console.log(`[build-site] site/ → web/dist/`);
