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
  {
    id: "0002_admin",
    statements: [
      // 只有一个管理员账号：不做角色模型，需要多人时再加一列即可（additive）。
      `CREATE TABLE IF NOT EXISTS admin_users (
         id INTEGER PRIMARY KEY AUTOINCREMENT,
         email TEXT NOT NULL UNIQUE,
         password_hash TEXT NOT NULL,
         totp_secret TEXT,
         totp_enabled INTEGER NOT NULL DEFAULT 0,
         failed_attempts INTEGER NOT NULL DEFAULT 0,
         locked_until TEXT,
         created_at TEXT NOT NULL,
         updated_at TEXT NOT NULL
       )`,
      // id = sha256(token)；pending=1 表示"密码已过、还差 2FA"的 5 分钟挑战票。
      `CREATE TABLE IF NOT EXISTS admin_sessions (
         id TEXT PRIMARY KEY,
         user_id INTEGER NOT NULL,
         pending INTEGER NOT NULL DEFAULT 0,
         created_at TEXT NOT NULL,
         last_used_at TEXT NOT NULL,
         ip TEXT,
         user_agent TEXT
       )`,
      `CREATE INDEX IF NOT EXISTS idx_admin_sessions_user
         ON admin_sessions (user_id)`,
      `CREATE TABLE IF NOT EXISTS audit_log (
         id INTEGER PRIMARY KEY AUTOINCREMENT,
         at TEXT NOT NULL,
         actor TEXT NOT NULL,
         action TEXT NOT NULL,
         target TEXT,
         detail TEXT
       )`,
      `CREATE INDEX IF NOT EXISTS idx_audit_log_at ON audit_log (at)`,
    ],
  },
  {
    id: "0003_plans",
    statements: [
      // 套餐是 CRM 的**唯一销售资产**：能不能买、多少钱、怎么落账，全在这里。
      // 一行 = 一个可售商品；改价/换规则请新建一行并用 supersedes_id 指向旧行
      // （active 行不可原地修改，保证历史订单可追溯）。
      `CREATE TABLE IF NOT EXISTS plans (
         id TEXT PRIMARY KEY,
         name TEXT NOT NULL,
         kind TEXT NOT NULL,
         price_minor INTEGER NOT NULL,
         currency TEXT NOT NULL,
         licence_limit INTEGER NOT NULL,
         term_days INTEGER,
         monthly_quota_gb REAL,
         traffic_gb REAL,
         validity_days INTEGER,
         allow_addons INTEGER NOT NULL DEFAULT 0,
         line_ids TEXT NOT NULL DEFAULT '[]',
         up_mbps INTEGER,
         down_mbps INTEGER,
         channels TEXT NOT NULL DEFAULT '[]',
         store_product_id TEXT NOT NULL DEFAULT '{}',
         sort_order INTEGER NOT NULL DEFAULT 0,
         status TEXT NOT NULL DEFAULT 'draft',
         supersedes_id TEXT,
         retired_at TEXT,
         created_at TEXT NOT NULL,
         updated_at TEXT NOT NULL
       )`,
      `CREATE INDEX IF NOT EXISTS idx_plans_status ON plans (status, sort_order)`,
    ],
  },
  {
    id: "0004_subscriptions",
    statements: [
      // 一个用户同时只有一个主订阅（period / traffic）；addon 是附加物，单独一行但不占主位。
      // 这一行是**销售事实**：卖出去的那一刻冻结的规则快照 + 实付价，后续改价不影响它。
      `CREATE TABLE IF NOT EXISTS platform_subscriptions (
         id INTEGER PRIMARY KEY AUTOINCREMENT,
         customer_id INTEGER NOT NULL,
         plan_id TEXT NOT NULL,
         kind TEXT NOT NULL,
         status TEXT NOT NULL DEFAULT 'active',
         paid_minor INTEGER NOT NULL,
         currency TEXT NOT NULL,
         licence_limit INTEGER NOT NULL,
         term_days INTEGER,
         quota_gb REAL,
         traffic_total_gb REAL,
         validity_days INTEGER,
         allow_addons INTEGER NOT NULL DEFAULT 0,
         line_ids TEXT NOT NULL DEFAULT '[]',
         started_at TEXT NOT NULL,
         expires_at TEXT,
         anchor_day INTEGER,
         balance_gb REAL,
         remaining_gb REAL,
         last_settled_at TEXT,
         platform_customer_id INTEGER,
         code TEXT,
         created_at TEXT NOT NULL,
         updated_at TEXT NOT NULL
       )`,
      `CREATE INDEX IF NOT EXISTS idx_subs_customer
         ON platform_subscriptions (customer_id, status)`,
      `CREATE INDEX IF NOT EXISTS idx_subs_due
         ON platform_subscriptions (kind, status, last_settled_at)`,
      // 换购/结算台账：每一笔权益变化都留痕，客服对账只查这张表。
      `CREATE TABLE IF NOT EXISTS subscription_changes (
         id INTEGER PRIMARY KEY AUTOINCREMENT,
         at TEXT NOT NULL,
         customer_id INTEGER NOT NULL,
         from_subscription_id INTEGER,
         to_subscription_id INTEGER,
         action TEXT NOT NULL,
         paid_minor INTEGER,
         residual_minor INTEGER,
         payable_minor INTEGER,
         balance_before REAL,
         balance_after REAL,
         detail TEXT
       )`,
      `CREATE INDEX IF NOT EXISTS idx_changes_customer
         ON subscription_changes (customer_id, id)`,
    ],
  },
];

/** schema 指纹：迁移 id 序列（顺序敏感） */
export function schemaFingerprint(): string {
  return MIGRATIONS.map((m) => m.id).join(",");
}
