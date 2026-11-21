#!/usr/bin/env node
/**
 * 把 `migrations/*.sql` **内嵌进 Worker**：生成 `src/db/migrations.generated.ts`。
 *
 *   node scripts/embed-migrations.mjs          写文件
 *   node scripts/embed-migrations.mjs --check  只校验（CI / 单测用）
 *
 * 为什么要把 SQL 打进 Worker（而不是运行时下载）：
 *   - 门禁在**每个租户的第一次请求里**跑（`src/db/schema-guard.ts`）。请求路径上
 *     不能依赖外部（GitHub / R2）—— 对方慢或挂，租户就打不开后台；
 *   - 同一份代码必须配同一份 SQL：内嵌是"代码与 DDL 同一个 commit"，release asset
 *     那条路（cf-api 消费）才有"版本要对齐"的问题。
 *
 * 与 `pack-migrations.mjs` 的关系：**同一套归一化与哈希**（直接复用），
 * 只是产出的形状不同 —— release asset 要整文件 `sql`（给 cf-api 一次 `/query` 提交），
 * Worker 里要**语句数组**（`batch` 一次提交，DDL 与台账 INSERT 同批）。
 *
 * 产物是**确定性**的：不含 `generated_at` / `tag`（那两样每次都变，会把 `--check`
 * 变成"永远漂移"）。`schemaVersion` 只进日志与排障。
 */
import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { buildBundle, splitStatements } from "./pack-migrations.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const DIR = join(root, "migrations");
const OUT = join(root, "src/db/migrations.generated.ts");

const files = readdirSync(DIR)
  .filter((name) => name.endsWith(".sql"))
  .map((name) => ({ name, sql: readFileSync(join(DIR, name), "utf8") }));

if (files.length === 0) {
  console.error(`✘ ${DIR} 里没有 .sql —— 内嵌一份空迁移没有意义，宁可失败`);
  process.exit(1);
}

const bundle = buildBundle(files);
const embedded = {
  schemaVersion: bundle.schema_version,
  files: bundle.files.map((f) => ({
    name: f.name,
    sha256: f.sha256,
    statements: splitStatements(f.sql),
  })),
};

const content = `/**
 * **生成文件，不要手改。** 由 \`npm run db:embed\` 从 \`migrations/*.sql\` 产出，
 * CI 用 \`npm run db:embed:check\` 校验一致性。
 *
 * 这份 bundle 是**门禁的期望值**（\`src/db/schema-guard.ts\`）：租户库的
 * \`d1_migrations\` 台账里的文件名集合必须与 \`files[].name\` 集合相等 ——
 * 缺就 \`batch\` 补上，多就是"库比代码新"，拒绝服务。
 *
 * \`schemaVersion\`（${bundle.schema_version}）是全部 \`(name, sql)\` 的内容指纹，
 * 只用于日志与排障 —— **不参与门禁判断**（判据是文件名集合，理由见 ADR
 * \`0007-tenant-migration-execution.md\`）。
 */
export interface EmbeddedMigrationFile {
  /** 文件名，同时是 \`d1_migrations.name\`；升序即执行顺序 */
  readonly name: string;
  /** 归一化后整文件 SQL 的 sha256（hex）——与 release asset 里的同一个值 */
  readonly sha256: string;
  /** 语句数组：\`batch\` 里逐条 prepare，**DDL 与台账 INSERT 同批提交** */
  readonly statements: readonly string[];
}

export const MIGRATION_BUNDLE: {
  readonly schemaVersion: string;
  readonly files: readonly EmbeddedMigrationFile[];
} = ${JSON.stringify(embedded, null, 2)};

/** 期望值 = 文件名集合（纯 A 判据；release tag 不参与） */
export const EXPECTED_NAMES: ReadonlySet<string> = new Set(
  MIGRATION_BUNDLE.files.map((file) => file.name),
);
`;

const label = `${embedded.files.length} 个文件 / ${embedded.files.reduce((n, f) => n + f.statements.length, 0)} 条语句 / ${embedded.schemaVersion}`;

if (process.argv.includes("--check")) {
  let current = "";
  try {
    current = readFileSync(OUT, "utf8");
  } catch {
    console.error(`✘ 缺少 ${OUT}，跑 npm run db:embed`);
    process.exit(1);
  }
  if (current !== content) {
    console.error(`✘ migrations.generated.ts 与 migrations/ 不一致，跑 npm run db:embed`);
    process.exit(1);
  }
  console.log(`✓ 内嵌 bundle 与 migrations/ 一致（${label}）`);
} else {
  writeFileSync(OUT, content);
  console.log(`✓ 已写入 src/db/migrations.generated.ts（${label}）`);
}
