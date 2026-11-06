#!/usr/bin/env node
/**
 * 把 `migrations/*.sql` 打包成 **一个 JSON**（release asset）。
 *
 * 为什么不是 tar/zip，也不是直接给 .sql 目录：**消费方是 cf-api 的 Worker**。
 * Worker 没有 shell、不能解包、也调不了 wrangler；它能用的只有 D1 的 HTTP API，
 * 而那个 API 一次只可靠地执行一条语句。所以必须在 CI 里就把语句拆好。
 *
 * 拆法：按 drizzle 的 `--> statement-breakpoint` 切分。**不按分号切** ——
 * 字符串字面量里可能出现分号，按分号切会切坏。
 *
 * 输出（stdout 或 --out）：
 *   { tag, schema_version, generated_at, files: [{ name, sha256, statements }],
 *     statement_count }
 *
 * `schema_version` 是**内容哈希**（所有 .sql 的 sha256 再哈希），不靠人读版本号：
 * slots.schema_version 拿它比，等价判断不需要解析 semver。
 */
import { createHash } from "node:crypto";
import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

/** 按 breakpoint 拆语句；空块丢掉。导出是为了单测。 */
export function splitStatements(sql) {
  return String(sql)
    .split("--> statement-breakpoint")
    .map((s) => s.trim())
    .filter(Boolean);
}

/** 纯函数：文件列表 → 资产对象（不碰文件系统，便于单测） */
export function buildBundle(files, { tag = "dev", now = new Date().toISOString() } = {}) {
  const sorted = [...files].sort((a, b) => a.name.localeCompare(b.name));
  const h = createHash("sha256");
  for (const f of sorted) {
    h.update(f.name);
    h.update("\0");
    h.update(f.sql);
    h.update("\0");
  }
  const files_ = sorted.map((f) => ({
    name: f.name,
    sha256: createHash("sha256").update(f.sql).digest("hex"),
    statements: splitStatements(f.sql),
  }));
  return {
    tag,
    schema_version: `sha256:${h.digest("hex").slice(0, 16)}`,
    generated_at: now,
    files: files_,
    statement_count: files_.reduce((n, f) => n + f.statements.length, 0),
  };
}

const isMain = process.argv[1] && resolve(process.argv[1]).endsWith("pack-migrations.mjs");
if (isMain) {
  const dir = process.argv.includes("--dir")
    ? process.argv[process.argv.indexOf("--dir") + 1]
    : "migrations";
  const out = process.argv.includes("--out")
    ? process.argv[process.argv.indexOf("--out") + 1]
    : null;
  const tag = process.env.GITHUB_REF_NAME ?? process.env.TAG ?? "dev";

  const files = readdirSync(dir)
    .filter((n) => n.endsWith(".sql"))
    .map((name) => ({ name, sql: readFileSync(join(dir, name), "utf8") }));

  if (files.length === 0) {
    console.error(`✘ ${dir} 里没有 .sql`);
    process.exit(1);
  }

  const bundle = buildBundle(files, { tag });
  const text = JSON.stringify(bundle) + "\n";
  if (out) {
    writeFileSync(out, text);
    console.error(
      `✔ ${out}：${bundle.files.length} 个文件 / ${bundle.statement_count} 条语句 / ${bundle.schema_version}`,
    );
  } else {
    process.stdout.write(text);
  }
}
