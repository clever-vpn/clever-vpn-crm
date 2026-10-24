/**
 * CRM 数据库 schema（Cloudflare D1 / SQLite）
 *
 * 约定（与 cf-api `packages/platform` 一致）：
 *   - 列名 snake_case；金额一律 **INTEGER 最小货币单位**（分），不要 REAL；
 *   - 布尔用 INTEGER 0/1；时间用 TEXT（ISO-8601 UTC 字符串，可直接字典序比较）；
 *   - 结构化数据（快照 / 配置）用 TEXT 存 JSON，不建子表；
 *   - 内部/系统列以 `_` 开头（沿用 cf-api 习惯）。
 *
 * 设计依据：`docs/domain.md`（六条不变量）。改表先改那边。
 *
 * 生成迁移：`npm run db:generate` → `migrations/*.sql`（开发库走 `migrations-dev/`，见 `docs/schema.md`）
 * 应用迁移：本地 `npm run db:migrate:local`；线上由 `deploy.yml` 在部署前
 * 执行 `wrangler d1 migrations apply --remote`。**Worker 不做自迁移** —— 缺表时
 * `src/db.ts` 会直接报错并提示跑哪条命令。
 */
import { index, integer, real, sqliteTable, text } from "drizzle-orm/sqlite-core";

// ─────────────────────────────────────────────────────────────
// 身份
// ─────────────────────────────────────────────────────────────

/** 管理员（单账号；需要多人时加 role 列即可） */
export const adminUsers = sqliteTable("admin_users", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  email: text("email").notNull().unique(),
  password_hash: text("password_hash").notNull(),
  totp_secret: text("totp_secret"),
  totp_enabled: integer("totp_enabled").notNull().default(0),
  failed_attempts: integer("failed_attempts").notNull().default(0),
  locked_until: text("locked_until"),
  created_at: text("created_at").notNull(),
  updated_at: text("updated_at").notNull(),
});

/** 后台会话：`id` = sha256(token)；pending=1 表示"密码已过、还差 2FA"的挑战票 */
export const adminSessions = sqliteTable(
  "admin_sessions",
  {
    id: text("id").primaryKey(),
    user_id: integer("user_id").notNull(),
    pending: integer("pending").notNull().default(0),
    created_at: text("created_at").notNull(),
    last_used_at: text("last_used_at").notNull(),
    ip: text("ip"),
    user_agent: text("user_agent"),
  },
  (t) => [index("idx_admin_sessions_user").on(t.user_id)],
);

export const auditLog = sqliteTable(
  "audit_log",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    at: text("at").notNull(),
    actor: text("actor").notNull(),
    action: text("action").notNull(),
    target: text("target"),
    detail: text("detail"),
  },
  (t) => [index("idx_audit_log_at").on(t.at)],
);

/**
 * 客户：**身份**，不含任何权益（见 domain.md §1）。
 *
 * `cf_customer_id` 是 cf-api 侧的行 id —— cf-api 才是"能不能用"的真相；
 * 本地这行只负责身份与聚合查询。
 */
export const customers = sqliteTable("customers", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  email: text("email").notNull().unique(),
  password_hash: text("password_hash"),
  display_name: text("display_name"),
  status: text("status").notNull().default("active"),
  /** cf-api `customers.id`；首次安装/绑定后回填 */
  cf_customer_id: integer("cf_customer_id"),
  created_at: text("created_at").notNull(),
});

/** 邮箱验证码：只存哈希，一次一用（按 email 做冷却/次数校验） */
export const emailCodes = sqliteTable("email_codes", {
  email: text("email").primaryKey(),
  code_hash: text("code_hash").notNull(),
  purpose: text("purpose").notNull().default("login"),
  sent_at: text("sent_at").notNull(),
  expires_at: text("expires_at").notNull(),
  attempts: integer("attempts").notNull().default(0),
});

/** App 会话：`id` = sha256(token)，明文只存在客户端安全存储 */
export const appSessions = sqliteTable(
  "app_sessions",
  {
    id: text("id").primaryKey(),
    customer_id: integer("customer_id").notNull(),
    created_at: text("created_at").notNull(),
    last_used_at: text("last_used_at").notNull(),
    revoked_at: text("revoked_at"),
    app_id: text("app_id"),
    ip: text("ip"),
    user_agent: text("user_agent"),
  },
  (t) => [index("idx_app_sessions_customer").on(t.customer_id)],
);

// ─────────────────────────────────────────────────────────────
// 商品与权益
// ─────────────────────────────────────────────────────────────

/**
 * 套餐 = 可售商品定义（**会改价、会下线，所以订单/订阅都存快照**）。
 *
 * `visibility`：`public` 上架可见；`hidden` 仅后台可见 —— **礼品包就是 price=0 的
 * hidden 套餐**（见 domain.md §5），不要为"赠送"再造一个概念。
 */
export const plans = sqliteTable(
  "plans",
  {
    id: text("id").primaryKey(),
    name: text("name").notNull(),
    /** period | traffic | addon */
    kind: text("kind").notNull(),
    price_minor: integer("price_minor").notNull(),
    currency: text("currency").notNull(),
    licence_limit: integer("licence_limit").notNull(),
    term_days: integer("term_days"),
    monthly_quota_gb: real("monthly_quota_gb"),
    traffic_gb: real("traffic_gb"),
    validity_days: integer("validity_days"),
    allow_addons: integer("allow_addons").notNull().default(0),
    line_ids: text("line_ids").notNull().default("[]"),
    up_mbps: integer("up_mbps"),
    down_mbps: integer("down_mbps"),
    /** 渠道 JSON：`web_checkout` | `apple_iap` | `google_play` */
    channels: text("channels").notNull().default("[]"),
    /**
     * 商店商品 ID：`{"apple"?: string, "google"?: string}`。
     *
     * **由管理员手工定义**，平台不会自动生成 —— 先到 App Store Connect /
     * Play Console 各建一次商品，再把 ID 抄进来（见 `docs/plans.md` §4.1）。
     *   - 两端**不可互换**：是不同的商品注册表，需要各自创建、各自激活；
     *   - 创建后**不可改名**（改 = 新建商品），所以第一次就要起对；
     *   - Apple 区分大小写；Google 只允许小写字母/数字/`.`/`_`。
     *
     * 平台在付款时生成的交易标识（Apple `transactionId` / Google `purchaseToken`）
     * **不放这里**，那是交易事实，落 `orders.external_id`。
     */
    store_product_id: text("store_product_id").notNull().default("{}"),
    sort_order: integer("sort_order").notNull().default(0),
    /** draft | active | retired */
    status: text("status").notNull().default("draft"),
    /** public | hidden */
    visibility: text("visibility").notNull().default("public"),
    supersedes_id: text("supersedes_id"),
    retired_at: text("retired_at"),
    created_at: text("created_at").notNull(),
    updated_at: text("updated_at").notNull(),
  },
  (t) => [index("idx_plans_status").on(t.status, t.sort_order)],
);

/**
 * 订阅 = 一次购买产生的**使用权**（销售事实：套餐快照 + 实付价已冻结）。
 *
 * 同一用户同一时刻只有一个 active 主订阅（period / traffic）；
 * addon 单独一行但不占主位。
 *
 * `params_version` 用于**写冲突检测**（domain.md I3）：CRM 侧改参数前先读、
 * 写回时比对，冲突就重算，避免与后台其它操作互相覆盖。
 */
export const platformSubscriptions = sqliteTable(
  "platform_subscriptions",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    customer_id: integer("customer_id").notNull(),
    /** 来源订单（赠送/补单也有订单，见 domain.md I1） */
    order_id: integer("order_id"),
    plan_id: text("plan_id").notNull(),
    kind: text("kind").notNull(),
    /** active | expired | revoked | pending */
    status: text("status").notNull().default("active"),
    paid_minor: integer("paid_minor").notNull(),
    currency: text("currency").notNull(),
    licence_limit: integer("licence_limit").notNull(),
    term_days: integer("term_days"),
    quota_gb: real("quota_gb"),
    traffic_total_gb: real("traffic_total_gb"),
    validity_days: integer("validity_days"),
    allow_addons: integer("allow_addons").notNull().default(0),
    line_ids: text("line_ids").notNull().default("[]"),
    started_at: text("started_at").notNull(),
    expires_at: text("expires_at"),
    /** 重置锚点（1–28，按购买日封顶），cron 据此重置 */
    anchor_day: integer("anchor_day"),
    /** 结转 / 加购的累积余额（跨期不清零） */
    balance_gb: real("balance_gb"),
    remaining_gb: real("remaining_gb"),
    last_settled_at: text("last_settled_at"),
    platform_customer_id: integer("platform_customer_id"),
    code: text("code"),
    params_version: integer("params_version").notNull().default(0),
    revoked_at: text("revoked_at"),
    revoke_reason: text("revoke_reason"),
    created_at: text("created_at").notNull(),
    updated_at: text("updated_at").notNull(),
  },
  (t) => [
    index("idx_subs_customer").on(t.customer_id, t.status),
    index("idx_subs_due").on(t.kind, t.status, t.last_settled_at),
    index("idx_subs_order").on(t.order_id),
  ],
);

/** 换购 / 结算台账：每一笔权益变化都留痕，客服对账只查这张表 */
export const subscriptionChanges = sqliteTable(
  "subscription_changes",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    at: text("at").notNull(),
    customer_id: integer("customer_id").notNull(),
    from_subscription_id: integer("from_subscription_id"),
    to_subscription_id: integer("to_subscription_id"),
    /** upgrade | settle | addon | revoke */
    action: text("action").notNull(),
    paid_minor: integer("paid_minor"),
    residual_minor: integer("residual_minor"),
    payable_minor: integer("payable_minor"),
    balance_before: real("balance_before"),
    balance_after: real("balance_after"),
    detail: text("detail"),
  },
  (t) => [index("idx_changes_customer").on(t.customer_id, t.id)],
);

// ─────────────────────────────────────────────────────────────
// 钱
// ─────────────────────────────────────────────────────────────

/**
 * 订单 = 一次**收款**的商业事实（domain.md §1）。
 *
 * 关键字段：
 *   - `plan_snapshot`：下单瞬间的套餐快照（改价不影响历史，I2）
 *   - `source`：purchase（自助）/ gift（赠送）/ manual（后台补单）
 *   - `refunded_minor`：已退金额缓存（明细在 `refunds`）
 *   - `voided_at`：作废时间（退款模式 A）
 */
export const orders = sqliteTable(
  "orders",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    /** 人类可读单号，如 ORD-20261023-0001 */
    code: text("code").notNull().unique(),
    customer_id: integer("customer_id").notNull(),
    plan_id: text("plan_id").notNull(),
    /** period | traffic | addon（冗余，便于报表不分表） */
    kind: text("kind").notNull(),
    /** 套餐快照 JSON（价格/额度/有效期/线路，全部冻结） */
    plan_snapshot: text("plan_snapshot").notNull(),
    amount_minor: integer("amount_minor").notNull(),
    currency: text("currency").notNull().default("CNY"),
    /** purchase | gift | manual */
    source: text("source").notNull().default("purchase"),
    /** manual | alipay | wechat | stripe | usdt | gift */
    channel: text("channel").notNull(),
    /** pending | paid | provisioning | active | closed | refunded */
    status: text("status").notNull().default("pending"),
    /** 生效后回填 */
    subscription_id: integer("subscription_id"),
    /** 渠道流水号（对账用） */
    external_id: text("external_id"),
    refunded_minor: integer("refunded_minor").notNull().default(0),
    voided_at: text("voided_at"),
    /** refund_and_void | refund_only */
    refund_mode: text("refund_mode"),
    refund_reason: text("refund_reason"),
    paid_at: text("paid_at"),
    provisioned_at: text("provisioned_at"),
    provision_attempts: integer("provision_attempts").notNull().default(0),
    provision_error: text("provision_error"),
    note: text("note"),
    /** 后台操作人（自助下单为空） */
    operator: text("operator"),
    created_at: text("created_at").notNull(),
    updated_at: text("updated_at").notNull(),
  },
  (t) => [
    index("idx_orders_customer").on(t.customer_id, t.id),
    index("idx_orders_status").on(t.status, t.created_at),
    index("idx_orders_external").on(t.channel, t.external_id),
  ],
);

/**
 * 退款明细：一张订单可以退多次（部分退款），`orders.refunded_minor` 是缓存和。
 * 每次退款都独立留痕，便于对账与审计。
 */
export const refunds = sqliteTable(
  "refunds",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    order_id: integer("order_id").notNull(),
    amount_minor: integer("amount_minor").notNull(),
    /** refund_and_void | refund_only */
    mode: text("mode").notNull(),
    reason: text("reason"),
    operator: text("operator").notNull(),
    at: text("at").notNull(),
    /** 渠道退款单号 */
    channel_refund_id: text("channel_refund_id"),
    /** pending | done | failed */
    status: text("status").notNull().default("done"),
  },
  (t) => [index("idx_refunds_order").on(t.order_id, t.id)],
);

/**
 * 管理员调整：**不产生售卖、只是修正**的权益变更（domain.md §1 / I1）。
 *
 * 例：补 20GB、延 3 天、改设备数。以 `field/before/after` 存差分，
 * `platform_applied_at` 记录是否已投影到 cf-api（失败可重试）。
 */
export const adjustments = sqliteTable(
  "adjustments",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    customer_id: integer("customer_id").notNull(),
    subscription_id: integer("subscription_id"),
    at: text("at").notNull(),
    /** traffic_balance | expire_date | licence_limit | line_ids */
    field: text("field").notNull(),
    delta: text("delta"),
    before_value: text("before_value"),
    after_value: text("after_value"),
    reason: text("reason").notNull(),
    operator: text("operator").notNull(),
    platform_applied_at: text("platform_applied_at"),
    platform_error: text("platform_error"),
  },
  (t) => [
    index("idx_adjustments_customer").on(t.customer_id, t.id),
    index("idx_adjustments_sub").on(t.subscription_id, t.id),
  ],
);

/**
 * 支付渠道配置（domain.md §9）。
 *
 * `config` 存加密 JSON（密钥/商户号/webhook secret）；CRM 只做配置 + 验签 + 记账，
 * **不存任何卡信息**。`manual`（对公转账）与 `gift`（赠送）复用同一条确认流程。
 */
export const paymentChannels = sqliteTable(
  "payment_channels",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    /** manual | alipay | wechat | stripe | usdt */
    type: text("type").notNull(),
    name: text("name").notNull(),
    enabled: integer("enabled").notNull().default(1),
    currency: text("currency").notNull().default("CNY"),
    /** 静态费率（万分比），用于净收入统计 */
    fee_bps: integer("fee_bps").notNull().default(0),
    config: text("config").notNull().default("{}"),
    webhook_path: text("webhook_path"),
    sort_order: integer("sort_order").notNull().default(0),
    created_at: text("created_at").notNull(),
    updated_at: text("updated_at").notNull(),
  },
  (t) => [index("idx_channels_type").on(t.type)],
);

// ─────────────────────────────────────────────────────────────
// 类型导出
// ─────────────────────────────────────────────────────────────

export type Order = typeof orders.$inferSelect;
export type NewOrder = typeof orders.$inferInsert;
export type Refund = typeof refunds.$inferSelect;
export type Adjustment = typeof adjustments.$inferSelect;
export type PaymentChannel = typeof paymentChannels.$inferSelect;
export type SubscriptionRow = typeof platformSubscriptions.$inferSelect;
export type PlanRow = typeof plans.$inferSelect;
export type Customer = typeof customers.$inferSelect;
