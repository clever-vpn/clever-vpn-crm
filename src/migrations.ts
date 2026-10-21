/**
 * 迁移定义 —— **随代码发布**（打进 Worker bundle）。
 *
 * 为什么不用 `wrangler d1 migrations`：
 *   托管形态下每个租户一个 D1，控制面只想"建空库 + 上传脚本"，
 *   由 Worker 在首次请求时自查指纹并迁移（见 db.ts）。
 *
 * 约束（很重要）：
 *   1. 每条语句必须**幂等**（`CREATE TABLE IF NOT EXISTS` / `CREATE INDEX IF NOT EXISTS`），
 *      因为指纹不一致时会把全部迁移重跑一遍；
 *   2. 只做**向后兼容**的变更（加表/加列），删列改名请拆成两次发布；
 *   3. 迁移一旦发布就不能修改内容，只能新增下一个 id。
 */

export interface Migration {
  /** 稳定 id（同时也是顺序），不要改名 */
  id: string;
  statements: string[];
}

export const MIGRATIONS: Migration[] = [
  {
    id: "0001_init",
    statements: [
      `CREATE TABLE IF NOT EXISTS customers (
         id INTEGER PRIMARY KEY AUTOINCREMENT,
         email TEXT NOT NULL UNIQUE,
         password_hash TEXT,
         display_name TEXT,
         status TEXT NOT NULL DEFAULT 'active',
         created_at TEXT NOT NULL
       )`,
      `CREATE TABLE IF NOT EXISTS activation_codes (
         id INTEGER PRIMARY KEY AUTOINCREMENT,
         customer_id INTEGER NOT NULL,
         code TEXT NOT NULL UNIQUE,
         status TEXT NOT NULL DEFAULT 'issued',
         expires_at TEXT,
         created_at TEXT NOT NULL
       )`,
      `CREATE INDEX IF NOT EXISTS idx_activation_codes_customer
         ON activation_codes (customer_id)`,
      `CREATE TABLE IF NOT EXISTS subscriptions (
         id INTEGER PRIMARY KEY AUTOINCREMENT,
         customer_id INTEGER NOT NULL,
         plan_id TEXT,
         status TEXT NOT NULL DEFAULT 'pending',
         starts_at TEXT,
         ends_at TEXT,
         created_at TEXT NOT NULL
       )`,
      `CREATE INDEX IF NOT EXISTS idx_subscriptions_customer
         ON subscriptions (customer_id)`,
    ],
  },
];

/** schema 指纹：迁移 id 序列（顺序敏感） */
export function schemaFingerprint(): string {
  return MIGRATIONS.map((m) => m.id).join(",");
}
