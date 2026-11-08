#!/usr/bin/env node
/**
 * 把 `migrations/*.sql` 打包成 **一个 JSON**（release asset）。
 *
 * 为什么不是 tar/zip，也不是直接给 .sql 目录：**消费方是 cf-api 的 Worker**。
 * Worker 没有 shell、不能解包、也调不了 wrangler；它只能用 D1 的 HTTP API。
 *
 * **执行单位是一个文件，不是一条语句。** D1 的 `/query` 一次请求 = 一个事务
 * （wrangler 源码原话 *"D1 runs your SQL in a transaction for you"*），所以整文件
 * 提交才是原子的；拆成逐条语句执行反而会丢掉原子性 —— 中途失败留半截库。
 *
 * 因此：
 *   - `files[].sql` 存**归一化后的整文件原文**（消费方直接提交，不拼不拆）；
 *   - `statements` 不写进资产，只留 `statement_count` 供审计；
 *   - 归一化 = 剔掉独立成行的 `BEGIN TRANSACTION;` / `COMMIT;`（D1 自己会套事务，
 *     文件里再写就是嵌套）。出现**多段事务**直接让构建失败 —— 这类错该在 CI 里
 *     炸，不该等到开通第 37 个租户时才炸。
 *
 * 幂等靠 D1 内置的台账 `d1_migrations`（`id/name/applied_at`，与 wrangler 逐字
 * 相同）：消费方执行完一个文件就记一笔 `name = 文件名`，重跑只跑未记账的文件。
 *
 * `schema_version` 是**内容指纹**（所有 `(name, sql)` 逐对再哈希），不靠人读版本号：
 * `slots.schema_version` 拿它比，等价判断不需要解析 semver。
 *
 * 输出（stdout 或 --out）：
 *   { tag, schema_version, generated_at,
 *     files: [{ name, sha256, sql, statement_count }], statement_count }
 *
 * 契约：`clever-vpn-docs/docs/contracts/cf-api-hosting.md` §4.5.4
 */
import { createHash } from "node:crypto";
import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

/** 按 breakpoint 拆语句。**仅用于计数**，不参与执行。导出是为了单测。 */
export function splitStatements(sql) {
  return String(sql)
    .split("--> statement-breakpoint")
    .map((s) => s.trim())
    .filter(Boolean);
}

const TX_LINES = new Set(["BEGIN TRANSACTION;", "BEGIN;", "COMMIT;", "END TRANSACTION;"]);

const normLine = (line) =>
  line
    .trim()
    .replace(/\s+/g, " ")
    .replace(/\s*;$/, ";")
    .toUpperCase();

/**
 * 归一化：剔掉事务控制语句（D1 会替你套事务）。
 * 多段事务直接报错 —— 那意味着这份 SQL 不是"一个迁移 = 一个事务"的形状。
 * 导出是为了单测。
 */
export function normalizeSql(sql, name = "?") {
  let begins = 0;
  let commits = 0;
  const kept = [];
  for (const line of String(sql).split("\n")) {
    if (TX_LINES.has(normLine(line))) {
      if (normLine(line).startsWith("BEGIN")) begins++;
      else commits++;
      continue;
    }
    kept.push(line);
  }
  if (begins > 1 || commits > 1) {
    throw new Error(
      `${name}: 含多段事务（BEGIN×${begins} / COMMIT×${commits}）。D1 会替你套事务，迁移文件里不许自己写`,
    );
  }
  return kept.join("\n");
}

/** 纯函数：文件列表 → 资产对象（不碰文件系统，便于单测） */
export function buildBundle(files, { tag = "dev", now = new Date().toISOString() } = {}) {
  const sorted = [...files]
    .map((f) => ({ name: f.name, sql: normalizeSql(f.sql, f.name) }))
    .sort((a, b) => a.name.localeCompare(b.name));
  const h = createHash("sha256");
  for (const f of sorted) {
    h.update(f.name);
    h.update("\0");
    h.update(f.sql);
    h.update("\0");
  }
  const entries = sorted.map((f) => ({
    name: f.name,
    sha256: createHash("sha256").update(f.sql).digest("hex"),
    sql: f.sql,
    statement_count: splitStatements(f.sql).length,
  }));
  return {
    tag,
    schema_version: `sha256:${h.digest("hex").slice(0, 16)}`,
    generated_at: now,
    files: entries,
    statement_count: entries.reduce((n, f) => n + f.statement_count, 0),
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
