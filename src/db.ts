/**
 * 自迁移：Worker 首次请求时按 schema 指纹校准库结构。
 *
 * 与 cf-api 的 TenantDO 同一套思路（`[tenant:N] schema init (hash)`）：
 *   - 控制面（托管）或租户（自托管）只需要"建一个空库"；
 *   - 代码升级后，任一新实例的首个请求会把库迁移到与代码一致的版本；
 *   - 迁移失败不缓存，下次请求重试（失败可观测，不会静默半迁移）。
 *
 * 注意：`CREATE TABLE IF NOT EXISTS` 保证重跑安全；迁移内容一旦发布不可修改。
 */

import { MIGRATIONS, schemaFingerprint } from "./migrations";

const META_TABLE = "_meta";
const SCHEMA_KEY = "schema_version";

/** isolate 级缓存：同一实例只校验一次 */
let ready: Promise<void> | null = null;

export function ensureSchema(db: D1Database): Promise<void> {
  if (!ready) {
    ready = migrate(db).catch((e: unknown) => {
      ready = null; // 失败不缓存，下次请求重试
      throw e;
    });
  }
  return ready;
}

async function migrate(db: D1Database): Promise<void> {
  await db
    .prepare(`CREATE TABLE IF NOT EXISTS ${META_TABLE} (k TEXT PRIMARY KEY, v TEXT NOT NULL)`)
    .run();

  const expected = schemaFingerprint();
  const row = await db
    .prepare(`SELECT v FROM ${META_TABLE} WHERE k = ?`)
    .bind(SCHEMA_KEY)
    .first<{ v: string }>();
  if (row?.v === expected) return;

  for (const migration of MIGRATIONS) {
    for (const statement of migration.statements) {
      await db.prepare(statement).run();
    }
  }

  await db
    .prepare(
      `INSERT INTO ${META_TABLE} (k, v) VALUES (?, ?)
       ON CONFLICT(k) DO UPDATE SET v = excluded.v`,
    )
    .bind(SCHEMA_KEY, expected)
    .run();
}

/** 仅测试用：重置 isolate 缓存 */
export function __resetSchemaCacheForTests(): void {
  ready = null;
}
