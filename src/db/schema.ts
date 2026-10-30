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
import { sql } from "drizzle-orm";
import { index, integer, real, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";

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
 * 与 cf-api 的关联挂在 `platform_subscriptions.platform_customer_id` 上（那里才是
 * "这份权益对应谁"），这里不重复存。
 */
export const customers = sqliteTable(
  "customers",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    email: text("email").notNull().unique(),
    password_hash: text("password_hash"),
    display_name: text("display_name"),
    status: text("status").notNull().default("active"),
    /**
     * 这个用户自己的邀请码（**懒生成**：第一次被要就发一张，之后不变）。
     * NULL = 还没生成过。它是"关系层"的唯一入口，与促销折扣无关。
     */
    referral_code: text("referral_code"),
    created_at: text("created_at").notNull(),
  },
  (t) => [
    // 允许 NULL（未生成），但一旦生成必须全局唯一：撞码 = 归因到错的人
    uniqueIndex("uq_customers_referral_code").on(t.referral_code),
  ],
);

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
 * 套餐 = 可售商品定义 —— **可变目录**（目录可以改，成交事实不能改）。
 *
 * 改价 / 改权益直接改这一行即可，**历史不会受污染**，因为事实已经各自冻结：
 *   - `orders.plan_snapshot`：下单瞬间的完整套餐定义；
 *   - `platform_subscriptions.*`：订阅的权益参数与实付价。
 * 所以这里**不需要版本链 / 克隆**：`plan_id` 长期稳定，收入统计可直接 `GROUP BY plan_id`。
 *
 * `status`：`draft` 未上架 / `active` 在售 / `retired` 已下架。
 * retirement **只影响能否再卖**，不影响已售（订阅用自己的快照）。
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
    line_ids: text("line_ids").notNull().default("[]"),
    up_mbps: integer("up_mbps"),
    down_mbps: integer("down_mbps"),
    /**
     * **售卖渠道** JSON：`[{channel:"web_checkout",methods:["alipay"]}]`。
     *
     * 回答的是"在哪儿卖"（自有收银台 / App Store / Google Play），
     * 与"用什么付钱"（`orders.payment_method`）是两个问题 —— 所以不要叫 `channels`。
     */
    sales_channels: text("sales_channels").notNull().default("[]"),
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
     * **不放这里**，那是交易事实，落 `orders.provider_trade_no`。
     */
    store_product_id: text("store_product_id").notNull().default("{}"),
    sort_order: integer("sort_order").notNull().default(0),
    /** draft | active | retired */
    status: text("status").notNull().default("draft"),
    /** public | hidden */
    visibility: text("visibility").notNull().default("public"),
    /**
     * **免费试用套餐**（`1` / `0`）。
     *
     * 全库**最多一个**（`uq_plans_trial` 部分唯一索引）—— 它就是"注册后自动开通"的那份权益。
     * 既然是赠送而不是商品，它必须 `price_minor = 0` 且 `visibility = 'hidden'`：
     * 不会出现在 `/plans`，也不能被 `POST /orders` 直接买（那是白嫆入口）。
     * App 需要知道"能不能免费试用"就问 `GET /trial`，不要从价格里猜。
     */
    trial: integer("trial").notNull().default(0),
    retired_at: text("retired_at"),
    created_at: text("created_at").notNull(),
    updated_at: text("updated_at").notNull(),
  },
  (t) => [
    index("idx_plans_status").on(t.status, t.sort_order),
    // 只允许一个试用套餐（SQLite 部分唯一索引）
    uniqueIndex("uq_plans_trial").on(t.trial).where(sql`${t.trial} = 1`),
  ],
);

/**
 * 订阅 = **这一份权益现在的完整快照**（域模型见 domain.md §1）。
 *
 * 定位三句话：
 *   - 存"这份权益是什么规则 + 还剩多少 + 在平台上对应谁"；
 *   - **不存**钱（`orders`）、历史（`subscription_changes`）、身份（`customers`）、
 *     商品定义（`plans`）；
 *   - **一个客户最多一行**（`uq_subs_customer`），新购/续费/升级都是"算出新快照
 *     → 覆盖这一行"，所以 `kind` 只可能是 `period` / `traffic`
 *     （加量包不产生订阅行，它只往 `period_extra_gb` 里加数）。
 *
 * 状态不落库：到期看 `expires_at`、用完看额度；`hold*` 只表达"人的意图"。
 *
 * **列名带类型前缀**（`period_*` / `traffic_*`）：只给"单一 kind 专有"的列加，
 * 两种都用的（`expires_at` / `licence_limit` / `line_ids`）不加。
 */
export const platformSubscriptions = sqliteTable(
  "platform_subscriptions",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    customer_id: integer("customer_id").notNull(),
    /**
     * **最初**让这份权益生效的订单（domain.md I1「权益必须有来源」）。
     *
     * 只在 `action = 'new'` 时写入；续费/加量/升级**不覆盖**它 ——
     * 那些订单的归属看 `subscription_changes.detail.order_id`。
     */
    order_id: integer("order_id"),
    plan_id: text("plan_id").notNull(),
    kind: text("kind").notNull(),
    /**
     * 手工控制位：`none` / `frozen` / `revoked`。
     * **状态是算出来的**（domain.md §1.3）：到期看 `expires_at`，用完看额度；
     * 这一列只表达“人的意图”（管理员冻结 / 退款作废）。
     */
    hold: text("hold").notNull().default("none"),
    hold_reason: text("hold_reason"),
    hold_at: text("hold_at"),
    /**
     * 这份权益的**成交价**（不是账户余额、不是累计付款）。唯一用途是算残值：
     * `residual = paid_minor × 剩余比例`。
     *
     * ⚠️ 加量包/赠送**不得覆盖它** —— 否则残值基准被拉低（那笔钱记在
     * `orders` 与 `subscription_changes` 里）。
     */
    paid_minor: integer("paid_minor").notNull(),
    /** 成交币种。**仅快照**，不参与任何计算（我们单币种） */
    currency: text("currency").notNull(),
    licence_limit: integer("licence_limit").notNull(),

    // ── period 专有 ──
    /** period：计费天数（残值按小时比例折算的依据） */
    period_term_days: integer("period_term_days"),
    /** period：每月额度（来自 `plans.monthly_quota_gb`），按 `period_anchor_day` 重置 */
    period_quota_gb: real("period_quota_gb"),
    /** period：月度重置锚点（1–28，按购买日封顶），cron 据此重置额度 */
    period_anchor_day: integer("period_anchor_day"),
    /**
     * period：**额外流量池**（GB）。三个来源：加量包、礼包赠送、邀请奖励。
     *
     * - 不随月度重置清零；与 `period_quota_gb` 一起被消耗；
     * - 月底用 `min(池子, 平台剩余)` 反推还剩多少 —— **本月没用完的额度不结转**；
     * - 它是 GB 数量，升级时原样搬到新订阅，**不折钱**。
     */
    period_extra_gb: real("period_extra_gb"),
    /** period：上次月结时间（结算 cron 的幂等依据，也用于跳过漏跑的周期） */
    period_settled_at: text("period_settled_at"),

    // ── traffic 专有 ──    /** traffic：流量套餐总量（残值按"剩余/总量"算比例） */
    traffic_total_gb: real("traffic_total_gb"),
    /**
     * traffic：剩余量 —— **缓存**，不是权威值。真实剩余在 cf-api，它随用户使用减少。
     *
     * - 比 `traffic_synced_at` 新过 TTL（15 分钟）后视为过期，需要重新同步；
     * - **任何写平台的操作（如加量包）必须先强制同步**，否则会把用户已用掉的流量还回去；
     * - `null` = 从未同步（≠ 0，不能当"用完"）。
     */
    traffic_remaining_gb: real("traffic_remaining_gb"),
    /** traffic：上面那个缓存最后一次与 cf-api 同步的时间（TTL 判据） */
    traffic_synced_at: text("traffic_synced_at"),
    /** traffic：流量包有效期（天）。仅快照，续费时以套餐当时的值为准 */
    traffic_validity_days: integer("traffic_validity_days"),

    // ── 两种 kind 共用 ──
    line_ids: text("line_ids").notNull().default("[]"),
    /** 这份权益的开始时间；`new` / `upgrade` 时重置，`renewal` / `addon` 不变 */
    started_at: text("started_at").notNull(),
    /** 到期时间；`null` = 永久 / 不限期 */
    expires_at: text("expires_at"),
    /** cf-api 侧的客户 id（落账后回填；未落账 = null，订单会停在 provisioning） */
    platform_customer_id: integer("platform_customer_id"),
    /** cf-api 侧的激活码；`licence_limit` 变化时置 null 等重新落账（旧码立即失效） */
    activation_code: text("activation_code"),
    /**
     * 快照：这份权益是不是**试用**（来自 `plans.trial`）。
     * 不靠"去查套餐"判断 —— 套餐以后被改/被删都不该让历史变准。
     * 它只影响给用户看的文案（`statusOf`），不影响能不能连（那是 cf-api 的事）。
     */
    trial: integer("trial").notNull().default(0),
    created_at: text("created_at").notNull(),
    updated_at: text("updated_at").notNull(),
  },
  (t) => [
    // I7：一个客户最多一行（历史留在 orders / subscription_changes）
    uniqueIndex("uq_subs_customer").on(t.customer_id),
    index("idx_subs_due").on(t.kind, t.period_settled_at),
    index("idx_subs_order").on(t.order_id),
  ],
);

/** 权益变更台账：每一笔变化都留痕，客服对账与退款回滚只查这张表 */
export const subscriptionChanges = sqliteTable(
  "subscription_changes",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    at: text("at").notNull(),
    customer_id: integer("customer_id").notNull(),
    /** 被改的那一行订阅（单行模型下，一个客户就一个 id） */
    subscription_id: integer("subscription_id").notNull(),
    /** new | renewal | upgrade | addon | settle | hold */
    action: text("action").notNull(),
    paid_minor: integer("paid_minor"),
    residual_minor: integer("residual_minor"),
    payable_minor: integer("payable_minor"),
    // 单行模型下“改之前”会被覆盖掉，所以 before / after 必须落在这里：
    // 退款模式 A 回滚到购买前状态的唯一依据（domain.md §1.2）。
    kind_before: text("kind_before"),
    kind_after: text("kind_after"),
    plan_before: text("plan_before"),
    plan_after: text("plan_after"),
    expires_before: text("expires_before"),
    expires_after: text("expires_after"),
    /** `period_extra_gb` 的前后值（只有 period 有） */
    period_extra_before: real("period_extra_before"),
    period_extra_after: real("period_extra_after"),
    detail: text("detail"),
  },
  (t) => [index("idx_changes_customer").on(t.customer_id, t.id)],
);

// ─────────────────────────────────────────────────────────────
// 钱
// ─────────────────────────────────────────────────────────────

/**
 * 订单 = 一次**收款**的商业事实（domain.md §1，细则见 `docs/payments.md`）。
 *
 * ⚠️ 粒度是"**一次支付尝试**"，不是"一次购买意图"：用户点一次「支付」就落一行。
 * 原因是第三方收银台的回调**只带我们下发的那个单号** —— 单号必须永远唯一对应一行，
 * 所以"换一个单号"就必然"换一行"。旧的未付款订单转 `expired`；它的钱晚到了，
 * 照样能凭单号找回并转 `paid`（钱到了必须记账，发不发货另算）。
 *
 * 因此**没有** `payment_attempts` 表：这一行就是那次尝试的全部证据。
 *
 * 关键字段：
 *   - `plan_snapshot`：下单瞬间的套餐快照（改价不影响历史，I2）
 *   - `source`：purchase（自助）/ gift（赠送）/ manual（后台补单）
 *   - `payment_method`：用户看到并选择的方式（`alipay` / `wechat` / …）
 *   - `provider_order_no`：发给服务商的单号，**创建后不可改**（回调靠它定位）
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
    /**
     * 促销减免（分）。`amount_minor` 已经是**减免后**的实收，两者不是兄弟关系：
     * `amount_minor = 标价 − discount_minor − 换购残值`。
     * 折扣与赠送分开记账（promotion.md §4）：这里只记“少收的钱”，不记“送的天数”。
     */
    discount_minor: integer("discount_minor").notNull().default(0),
    /** 命中的促销活动；NULL = 没用到任何促销 */
    promotion_id: integer("promotion_id"),
    /** 命中的批次码（`promotion_codes.id`）；主码 / 无码时为 NULL */
    code_id: integer("code_id"),
    currency: text("currency").notNull().default("CNY"),
    /** purchase | gift | manual */
    source: text("source").notNull().default("purchase"),
    /**
     * 支付方式 —— **用户可见的唯一支付概念**：`alipay` | `wechat` | `paypal` |
     * `stripe` | `transfer` | `manual` | `gift`。
     * 具体走哪家服务商/哪条网关（`gateway_id`）对用户不可见。
     */
    payment_method: text("payment_method").notNull(),
    /**
     * 从哪个壳进来的：`web`（品牌官网）/ `app`（原生客户端）。
     * **只做入口统计** —— 与 `payment_method`（钱在哪里付）正交，别混用。
     */
    entry: text("entry"),
    /** 实际使用的网关（`payment_gateways.id`）；手工补单/赠送/内购为空 */
    gateway_id: integer("gateway_id"),
    /**
     * 我方下发给服务商的单号（回调里带回来的就是它）。
     * **创建后永不修改** —— 改了旧单号的回调就找不到家。
     */
    provider_order_no: text("provider_order_no").unique(),
    /** 服务商侧流水号（退款、对账用） */
    provider_trade_no: text("provider_trade_no"),
    /** 收银台地址：未过期可直接复用，客服排查也看它 */
    pay_url: text("pay_url"),
    /** 创建请求 / 回调的原始报文 —— 出问题时唯一的证据 */
    raw_create: text("raw_create"),
    raw_notify: text("raw_notify"),
    /** 支付超时；过期后不再等回调，但查到钱仍会转 paid */
    expires_at: text("expires_at"),
    /** pending | paid | provisioning | active | expired | closed | refunded */
    status: text("status").notNull().default("pending"),
    /** 生效后回填 */
    subscription_id: integer("subscription_id"),
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
    /** 兜底 cron 扫 `pending` + 按网关看健康度 */
    index("idx_orders_gateway").on(t.gateway_id, t.status),
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
    /** 语义字段：`days` | `gb`（增量）｜ `licence_limit` | `line_ids`（绝对值） */
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

// ─────────────────────────────────────────────────────────────
// 促销（`docs/promotion.md`，对外承诺见 `app-crm.md` §2.9）
// ─────────────────────────────────────────────────────────────

/**
 * 促销活动 = **规则层**。一个活动一行；`code` 为空表示"自动生效"。
 *
 * 只有两种收益：`amount`（减 N 分）、`percent`（减 N%）。
 * 不在这里存"送几天/送几 GB"—— 那是奖励侧的事（`referrer_reward_type`），
 * **折扣与赠送必须分开记账**（promotion.md §4 不变量 1）。
 */
export const promotions = sqliteTable(
  "promotions",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    /**
     * 优惠券是否「不用码就生效」（契约 §2.9.7）。
     *
     * 以前靠 `code IS NULL` 推断，但码搬进 `promotion_codes` 之后
     * 所有活动都“没有 code”了，必须显式声明。礼包 / 邀请恒为 0。
     */
    auto_apply: integer("auto_apply").notNull().default(0),
    /** 后台可见名称，不下发给用户 */
    name: text("name").notNull(),
    /** coupon（改金额） | gift（改权益） | referral（关系）—— 见 `app-crm.md` §2.9 */
    kind: text("kind").notNull().default("coupon"),
    /**
     * coupon 才有：amount（分） | percent（1–100，表示减掉的百分比）。
     * gift / referral 不靠它，但列是 NOT NULL，一律写 `amount` + 0。
     */
    benefit_type: text("benefit_type").notNull(),
    benefit_value: integer("benefit_value").notNull(),
    /**
     * kind=gift 的奖励项（JSON）：`{days, gb}`，可组合。
     * **两个维度互相独立**（天数只改到期日、GB 只改流量），且只在订阅本身有这项权益时
     * 生效 —— 无限期不收天数、不限量不收 GB。
     * **只改权益不改金额** —— 所以与 benefit_* 是两套账。
     * 刻意没有 device_limit：平台侧 `licence_limit` 建客户时固定、不可改。
     */
    rewards_json: text("rewards_json").notNull().default("{}"),
    /** 门槛：折扣前金额低于这个数就不适用（百分比券会击穿低价套餐，必须有） */
    min_subtotal_minor: integer("min_subtotal_minor").notNull().default(0),
    /** JSON 数组：`["period"]`；空数组 = 不限 */
    limit_plan_kinds: text("limit_plan_kinds").notNull().default("[]"),
    /** JSON 数组：指定套餐 id；空数组 = 不限 */
    limit_plan_ids: text("limit_plan_ids").notNull().default("[]"),
    /**
     * 人群：all | new | existing | expiring | expired | specific（契约 §2.9.6）。
     * 取代早期的 boolean `first_purchase_only` —— 布尔表达不了「老客 / 快到期」。
     */
    audience: text("audience").notNull().default("all"),
    /** audience=expiring 时必填：到期前 N 天内（1–90） */
    audience_days: integer("audience_days"),
    /** 注册后 N 天内可用；NULL = 不限 */
    new_user_within_days: integer("new_user_within_days"),
    starts_at: text("starts_at"),
    ends_at: text("ends_at"),
    /** 全站总次数上限；NULL = 不限 */
    max_uses: integer("max_uses"),
    /** 每人最多用几次（0 = 谁都不能用，等于下线） */
    max_uses_per_customer: integer("max_uses_per_customer").notNull().default(1),
    /** 同一客户同一活动两次核销的最小间隔（小时）；NULL = 不限 */
    cooldown_hours: integer("cooldown_hours"),
    /**
     * 载体套餐（契约 §2.9.7）：礼包发给**没有订阅**的客户时，用它 0 元开通。
     * 必须是 `visibility='hidden'` 的套餐 —— 套餐给“是什么包”，礼包的 `rewards.days`
     * 给“送多久”。有订阅时这个字段被忽略。
     */
    plan_id: text("plan_id"),
    /** 角标文案，如"限时 8 折"；NULL = 列表页不展示 */
    badge_label: text("badge_label"),
    /** 是否公开展示（0 = 定向活动，只能靠码命中） */
    visible: integer("visible").notNull().default(1),
    /** kind=referral：给推荐人的奖励类型 days | gb | none */
    referrer_reward_type: text("referrer_reward_type"),
    referrer_reward_value: real("referrer_reward_value"),
    /** draft | active | ended */
    status: text("status").notNull().default("draft"),
    created_at: text("created_at").notNull(),
    updated_at: text("updated_at").notNull(),
  },
  (t) => [index("idx_promotions_status").on(t.status, t.kind)],
);

/**
 * 「只给这几个客户」的名单（`audience = 'specific'` 时生效）。
 *
 * 单独建表而不是在活动上塞 JSON 数组：名单可能上千人，JSON 塞不下也没法索引，
 * 而这里的查询永远是「这个活动 + 这个客户」，一个复合主键就够。
 */
export const promotionTargets = sqliteTable(
  "promotion_targets",
  {
    promotion_id: integer("promotion_id").notNull(),
    customer_id: integer("customer_id").notNull(),
    created_at: text("created_at").notNull(),
  },
  (t) => [
    uniqueIndex("uq_promotion_targets").on(t.promotion_id, t.customer_id),
    index("idx_promotion_targets_customer").on(t.customer_id),
  ],
);

/**
 * 邀请关系 = **关系层**（唯一归因来源）。 *
 * 一人只能被邀请一次（`uq_referrals_customer`）。这里**不存钱**：
 * 奖励明细落 `redemptions`，本表只回答"谁拉了谁"。
 */
export const referrals = sqliteTable(
  "referrals",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    /** 被邀请人 */
    customer_id: integer("customer_id").notNull(),
    referrer_id: integer("referrer_id").notNull(),
    /** 绑定那一刻命中的活动（可空：先绑关系，后上活动） */
    promotion_id: integer("promotion_id"),
    /** 绑定用的码（留证） */
    code: text("code").notNull(),
    /** 推荐人奖励发放时间；NULL = 还没发（通常是好友还没付首单） */
    rewarded_at: text("rewarded_at"),
    /** 实际发出的奖励：days | gb | none；NULL = 还没发 */
    reward_type: text("reward_type"),
    reward_value: real("reward_value"),
    created_at: text("created_at").notNull(),
  },
  (t) => [
    uniqueIndex("uq_referrals_customer").on(t.customer_id),
    index("idx_referrals_referrer").on(t.referrer_id),
  ],
);

/**
 * 核销台账：谁在**哪一笔已支付的订单**上用了什么活动。
 *
 * 铁律：**支付成功才写**（promotion.md §7.3）。下单只校验不扣减，
 * 否则未付款的订单会把名额占光 —— 那正是 XBoard 的漏洞。
 * `(promotion_id, order_id)` 唯一 ⇒ 回调重放也不会重复核销或重复发奖励。
 */
export const redemptions = sqliteTable(
  "redemptions",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    promotion_id: integer("promotion_id").notNull(),
    customer_id: integer("customer_id").notNull(),
    order_id: integer("order_id").notNull(),
    /** 用的是哪个批次码（`promotion_codes.id`）；用主码或系统发放时为 NULL */
    code_id: integer("code_id"),
    /** 这一单减免了多少（分）；纯赠送型记 0 */
    discount_minor: integer("discount_minor").notNull().default(0),
    /** 这次核销顺带发放了什么（如推荐人奖励），JSON */
    granted_json: text("granted_json"),
    created_at: text("created_at").notNull(),
  },
  (t) => [
    uniqueIndex("uq_redemptions_order_promo").on(t.promotion_id, t.order_id),
    index("idx_redemptions_customer").on(t.customer_id),
    index("idx_redemptions_promotion").on(t.promotion_id),
    // 批次码的用量 = 数这里有多少行；不另存 used_count，避免两份数对不上
    index("idx_redemptions_code").on(t.code_id),
    // 同一个码，同一个人只能核销一次（码级去重，比"每人每活动 1 次"更贴语义）。
    // 自动发放时 code_id 为 NULL，SQLite 的唯一索引允许多个 NULL ⇒ 不影响那种情况。
    uniqueIndex("uq_redemptions_code_customer").on(t.code_id, t.customer_id),
  ],
);

/**
 * 批次码（契约 §2.9.7）：一个活动下可以生成 N 个码，一码一人。
 *
 * 为什么需要这张表（而不是多加几个 `promotions.code`）：
 * 一码一人 / 按码统计用量 / 单独作废某个码 —— 这些都要求码本身是一行数据。
 * `promotions.code` 继续作为“主码”（单码活动），两者共存：
 * 查找时**先看主码，再看这张表**。
 *
 * 用量不存 `used_count`，而是数 `redemptions.code_id` —— 单一事实来源。
 */
export const promotionCodes = sqliteTable(
  "promotion_codes",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    promotion_id: integer("promotion_id").notNull(),
    code: text("code").notNull().unique(),
    /** 同一次生成的批次（导出 / 整批作废用） */
    batch_id: text("batch_id"),
    /** 这个码能用几次（一码一人 = 1） */
    max_uses: integer("max_uses").notNull().default(1),
    /** active | revoked */
    status: text("status").notNull().default("active"),
    /** 码自己的过期时间（NULL = 跟随活动） */
    expires_at: text("expires_at"),
    /** 备注：发给谁 / 哪个渠道 */
    note: text("note"),
    created_at: text("created_at").notNull(),
  },
  (t) => [
    index("idx_promotion_codes_promotion").on(t.promotion_id),
    index("idx_promotion_codes_batch").on(t.batch_id),
  ],
);

/**
 * 支付网关 = **一条能收钱的配置**（`docs/payments.md`）。
 *
 * 三个词分清楚：
 *   - **支付方式** `payment_method`（用户视角：支付宝/微信/PayPal/Stripe）—— 存在订单上；
 *   - **服务商** 用户既看不到也不需要知道：租户配几条网关，就有几家服务商；
 *   - **网关** 就是这一行，可以同方式多条按 `priority` 兜底。
 *
 * `driver` 决定"怎么和它说话"，同时也决定 App 里怎么显示（不需要再单独存一个
 * 类型字段 —— 能推导的东西不存第二份）：
 *   - `epay_v1`：易支付协议族（内置一份映射，租户只填 endpoint/pid/key）；
 *   - `generic_json_v1`：任意私有协议（租户/AI 填 `mapping`）；
 *   - `stripe` / `paypal`：品牌 PSP，独立薄 driver（OAuth/二次 capture 不属于映射）；
 *   - `manual`：对公转账，人工确认；
 *   - `mock`：**自带的测试网关**（`docs/payments.md` §5.3），不连真实渠道，
 *     有**两道闸门**：`env.ALLOW_MOCK_PAYMENTS` 与 `allowed_emails`。
 *
 * 判据（`docs/payments.md` §6）：**签名能在本地一次算完 → 映射；否则 → driver**。
 *
 * 不变量：**只有 `status = 'live'` 才参与路由**；`live` 之前必须用真实测试支付
 * （`orders` 里 `plan_id IS NULL` 的那条）验证过签名与回调。
 */
export const paymentGateways = sqliteTable(
  "payment_gateways",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    /** epay_v1 | generic_json_v1 | stripe | paypal | manual */
    driver: text("driver").notNull(),
    /** 后台显示名（例："支付宝-主号"）—— **永远不会出现在用户界面** */
    name: text("name").notNull(),
    /** 收银台 / API 根地址 */
    endpoint: text("endpoint"),
    /** 商户号 / app_id / client_id */
    merchant_id: text("merchant_id"),
    /**
     * 加密后的密钥（AES-GCM，主密钥在 Worker secret `PAYMENT_SECRET_KEY`）。
     * 明文密钥**不入库、不进日志、不进任何 API 响应**。
     */
    secret_enc: text("secret_enc"),
    /** 这条网关支持的支付方式：`["alipay","wechat"]` */
    methods: text("methods").notNull().default("[]"),
    /** 自定义协议映射 JSON —— 只有 `custom`（generic_json_v1）需要 */
    mapping: text("mapping"),
    /** 同一方式多条网关时，数字小的先试；失败自动降级到下一 条 */
    priority: integer("priority").notNull().default(100),
    /** draft | live | disabled */
    status: text("status").notNull().default("draft"),
    /**
     * 客户白名单（JSON 数组，邮箱小写）。`null` / 空数组 = **不限**。
     *
     * 两个用途：
     *   1. `driver = 'mock'` 时**必须非空**才能 `live` —— 否则等于向所有真实用户
     *      免费开通（两道闸门的第二道，见 `docs/payments.md` §5.3）；
     *   2. 真实网关的**灰度发布**：新渠道先只给几个老用户体验。
     */
    allowed_emails: text("allowed_emails"),
    currency: text("currency").notNull().default("CNY"),
    /** 最近一次成功的测试支付（`orders.id`，那条订单 `plan_id IS NULL`） */
    last_test_order_id: integer("last_test_order_id"),
    last_ok_at: text("last_ok_at"),
    last_error: text("last_error"),
    created_at: text("created_at").notNull(),
    updated_at: text("updated_at").notNull(),
  },
  (t) => [index("idx_gateways_route").on(t.status, t.priority)],
);

// ─────────────────────────────────────────────────────────────
// 类型导出
// ─────────────────────────────────────────────────────────────

export type Order = typeof orders.$inferSelect;
export type NewOrder = typeof orders.$inferInsert;
export type Refund = typeof refunds.$inferSelect;
export type Adjustment = typeof adjustments.$inferSelect;
export type PaymentGateway = typeof paymentGateways.$inferSelect;
export type SubscriptionRow = typeof platformSubscriptions.$inferSelect;
export type PlanRow = typeof plans.$inferSelect;
export type Customer = typeof customers.$inferSelect;
export type PromotionRow = typeof promotions.$inferSelect;
export type ReferralRow = typeof referrals.$inferSelect;
export type RedemptionRow = typeof redemptions.$inferSelect;
export type PromotionTargetRow = typeof promotionTargets.$inferSelect;
export type PromotionCodeRow = typeof promotionCodes.$inferSelect;
