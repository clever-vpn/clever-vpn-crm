# 表结构（Drizzle / D1）

Last updated: 2026-10-23

> 设计依据：[`domain.md`](domain.md)（六条不变量）。改表先改那边，再改本文件，最后改 schema。
> 实现：`src/db/schema.ts`；迁移产物：`migrations/*.sql`。

## 0. 约定

| 项 | 约定 | 理由 |
|---|---|---|
| 列名 | `snake_case` | 与 cf-api 一致，SQL 直查不用加引号 |
| 金额 | `INTEGER` 最小单位（分） | 浮点算钱迟早出错 |
| 布尔 | `INTEGER` 0/1 | SQLite 无 bool |
| 时间 | `TEXT` ISO-8601 UTC | 可直接字典序比较、可读 |
| 结构化 | `TEXT` 存 JSON | 快照/配置不需要被 JOIN |
| 系统列 | 前缀 `_` | 沿用 cf-api 习惯（如 `_fsm_status`） |
| 索引 | `idx_<表>_<用途>` | 统一命名便于排查慢查询 |

## 1. 工具链

```bash
npm run db:generate      # drizzle-kit generate → migrations/*.sql
```

- `drizzle.config.ts`：`dialect: sqlite`、`schema: ./src/db/schema.ts`、`out: ./migrations`。
- **不手写 SQL**：所有 DDL 由 schema 生成，保证代码与库一致。
- `migrations/meta/` 是 drizzle 的快照链，**必须提交**，否则下次生成会全量重建。

### 应用方式（与 cf-api 的差异）

cf-api 用 `wrangler d1 migrations apply`（`migrations_dir`）。CRM **不能**这么做：
托管模式下 Worker 是按 release 字节上传到 dispatch namespace，没有 CLI 可跑，
所以迁移必须随代码走、由 Worker 启动时自应用（现有 `src/db.ts` 的机制）。
两种方式的差异只在前端入口，不改 SQL 本身。

> ⏳ 待办：把现有 `src/migrations.ts`（手写 SQL）替换为「导入 drizzle 生成的
> SQL + `_migrations` 记录表」的加载器。这一步单独 PR，避免与建表混在一起。

## 2. 表清单

### 2.1 身份

| 表 | 用途 | 关键列 |
|---|---|---|
| `admin_users` | 管理员（单账号） | `email` unique、`password_hash`、`totp_*`、`failed_attempts`/`locked_until` |
| `admin_sessions` | 后台会话（cookie） | `id` = sha256(token)、`pending`（2FA 挑战票） |
| `audit_log` | 审计 | `at`、`actor`、`action`、`target`、`detail` |
| `customers` | **客户身份**（不含权益） | `email` unique、`cf_customer_id`（cf-api 行 id） |
| `email_codes` | 邮箱验证码（只存哈希） | `email` PK、`purpose`、`expires_at`、`attempts` |
| `app_sessions` | App 会话（Bearer） | `id` = sha256(token)、`revoked_at` |

### 2.2 商品与权益

| 表 | 用途 | 关键列 |
|---|---|---|
| `plans` | 可售商品定义 | `kind`(period/traffic/addon)、`price_minor`、`visibility`(public/hidden)、`status`(draft/active/retired)、`supersedes_id` |
| `platform_subscriptions` | **订阅**（销售事实 + 快照） | `order_id`、`kind`、`quota_gb`、`balance_gb`（结转）、`anchor_day`、`params_version`（写冲突检测）、`revoked_at` |
| `subscription_changes` | 换购/结算台账 | `action`、`residual_minor`、`payable_minor`、`balance_*` |

### 2.3 钱

| 表 | 用途 | 关键列 |
|---|---|---|
| `orders` | **订单**（一次收款） | `code` unique、`plan_snapshot`（JSON 快照）、`amount_minor`、`source`(purchase/gift/manual)、`channel`、`status`、`refunded_minor`、`voided_at`、`refund_mode`、`provision_*` |
| `refunds` | 退款**明细**（可多次部分退） | `order_id`、`amount_minor`、`mode`、`operator`、`channel_refund_id`、`status` |
| `adjustments` | 管理员**调整**（非售卖） | `field`、`before_value`、`after_value`、`reason`、`operator`、`platform_applied_at` |
| `payment_channels` | 支付渠道配置 | `type`、`enabled`、`fee_bps`、`config`（加密 JSON）、`webhook_path` |

### 2.4 订单状态与来源

```
status: pending → paid → provisioning → active
                              ↘ closed（超时/取消）
        paid/provisioning → refunded（可能同时 voided）
source: purchase（自助） | gift（赠送） | manual（后台补单）
```

## 3. 迁移历史

| 文件 | 内容 |
|---|---|
| `0000_baseline.sql` | 现有全部表（与 `src/migrations.ts` 等价）—— **已存在的库不应执行**，见 §4 |
| `0001_orders_adjustments_channels.sql` | 新增 `orders` / `refunds` / `adjustments` / `payment_channels`；`customers.cf_customer_id`、`plans.visibility`、`platform_subscriptions` 四列 |

## 4. 升级路径（重要）

`0000_baseline.sql` 是 `CREATE TABLE`（无 `IF NOT EXISTS`），因为它是给**全新库**用的。
已存在的库（本地 dev、任何已部署的租户）**只应执行 0001**。

落地加载器时的规则：

1. 建 `_migrations(id TEXT PRIMARY KEY, applied_at TEXT)` 记录表；
2. 若 `_migrations` 为空 **且** 探测到 `admin_users` 已存在 → 说明是老库，
   把 `0000_baseline` **标记为已应用**（不执行），只跑后续迁移；
3. 全新库 → 按顺序全部执行；
4. 每条迁移执行后写入 `_migrations`，天然只跑一次（不依赖 `IF NOT EXISTS`）。

## 5. 已知取舍

- **`orders.plan_snapshot` 用 JSON 而不是子表**：快照只读、不需要 JOIN、字段会随业务演进，
  子表反而要跟着改 DDL。
- **`orders.refunded_minor` 是缓存和**：真相在 `refunds` 明细；两者不一致时以明细重算。
- **`platform_subscriptions.params_version`**：D1 没有行锁，靠"读版本 → 写前比对"
  避免结算与后台改动互相覆盖（domain.md I3）。
- **`customers` 与 cf-api 是弱引用**：`cf_customer_id` 可能为空（尚未绑定），
  不做外键约束（D1 跨库无外键）。
