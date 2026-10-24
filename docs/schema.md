# 表结构（Drizzle / D1）

Last updated: 2026-10-24

> 设计依据：[`domain.md`](domain.md)（六条不变量）。改表先改那边，再改本文件，最后改 schema。
> 实现：`src/db/schema.ts`；生产迁移：`migrations/`；开发链：`migrations-dev/`（gitignore）。

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

## 1. 工具链与两套迁移目录

```bash
npm run db:generate     # drizzle-kit generate → migrations/（生产链）
npm run db:reset        # 重建 dev 链 + 重置本地库 + 应用（开发日常用这个）
npm run db:migrate:local  # 应用 dev 链（不清库）
npm run check:migrations  # 迁移链自检（结构 / 不可变 / 漂移）
```

| 目录 | 用途 | 入库 | 谁生成 / 谁应用 |
|---|---|---|---|
| `migrations/` | **生产链**：追加式、不可变的历史 | ✅ | `drizzle-kit generate` → CI 应用 |
| `migrations-dev/` | **开发链**：全量 schema + dev 种子 | ❌（gitignore） | `scripts/reset-db.sh` 每次重建 |

两套是**同一份 schema**的两种形态：生产链是"从零到今的每一步"，开发链是"现在长什么样"。
开发时可以随便重置，因为 dev 链每次都从 `src/db/schema.ts` 重新生成。

- `drizzle.config.ts`：`dialect: sqlite`、`schema: ./src/db/schema.ts`、`out: ./migrations`。
- **不手写 SQL**：所有 DDL 由 schema 生成。
- `migrations/meta/` 是 drizzle 的快照链，**必须提交**，否则下次生成会全量重建。
- `wrangler.jsonc` 里 `migrations_dir` = `migrations-dev`（本地）；CI 渲染配置时
  改回 `migrations`（`scripts/render-config.mjs`），所以部署永远用生产链。

### 应用方式

| 环境 | 谁执行 | 命令 |
|---|---|---|
| 本地开发 | 你 | `npm run db:reset`（或 `db:migrate:local`） |
| 线上/自托管 | **GitHub Actions** | deploy.yml 里的「应用数据库迁移」步骤：`wrangler d1 migrations apply DB --remote`，**在 `wrangler deploy` 之前** |

Worker 自己**不再执行任何 DDL**（`src/db.ts` 只做一次只读探测：核心表不存在就报错，
提示去跑迁移）。理由：部署唯一路径是 CI，迁移失败要在 CI 里红叉，而不是等用户访问时 500。

### dev 种子

`scripts/reset-db.sh` 里的 `dev_seed()` 维护，重置后直接可用：

- 管理员：`ops@example.com` / `crm-admin-2026`
- 套餐：周期 / 流量 / 加量 + 一个礼品包（`price=0` 且 `visibility=hidden`）
- 2 个客户、1 个订阅、1 张购买单 + 1 张 0 元赠单

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
| `plans` | 可售商品定义（**可变目录**，历史靠快照） | `kind`(period/traffic/addon)、`price_minor`、`visibility`(public/hidden)、`status`(draft/active/retired)、`retired_at` |
| `platform_subscriptions` | **订阅**（当前权益，**一个客户一行**：`uq_subs_customer`） | `kind`、`quota_gb`、`balance_gb`（结转）、`anchor_day`、`expires_at`、`hold`/`hold_reason`（手工控制位）、`params_version` |
| `subscription_changes` | 权益变更台账（**单行模型的历史全在这里**） | `action`(new/renewal/upgrade/addon/settle/hold)、`paid_minor`、`residual_minor`、`payable_minor`、`kind_before`/`kind_after`、`plan_before`/`plan_after`、`expires_before`/`expires_after`、`balance_before`/`balance_after` |

### 2.3 钱

| 表 | 用途 | 关键列 |
|---|---|---|
| `orders` | **订单 = 一次支付尝试**（见 [`payments.md`](payments.md) §2） | `code` unique、`plan_snapshot`（JSON 快照）、`amount_minor`、`source`(purchase/gift/manual)、`payment_method`、`gateway_id`、`provider_order_no` unique、`provider_trade_no`、`pay_url`、`expires_at`、`raw_create`/`raw_notify`、`status`、`refunded_minor`、`voided_at`、`provision_*` |
| `refunds` | 退款**明细**（可多次部分退） | `order_id`、`amount_minor`、`mode`、`operator`、`channel_refund_id`、`status` |
| `adjustments` | 管理员**调整**（非售卖） | `field`、`before_value`、`after_value`、`reason`、`operator`、`platform_applied_at` |
| `payment_gateways` | **支付网关配置**（一条 = 一份能收钱的凭据） | `driver`(epay_v1/generic_json_v1/stripe/paypal/manual)、`methods`、`mapping`、`priority`、`status`(draft/live/disabled)、`secret_enc`、`last_test_order_id` |

> **没有 `payment_attempts` 表**：订单本身就是那次尝试的证据。理由见 `payments.md` §2。

### 2.4 订单状态与来源

```
status: pending → paid → provisioning → active
                     ↘ expired（超时/明确失败；钱晚到仍可转 paid）
        paid → refunded（可能同时 voided）
        周期到期 → closed
source: purchase（自助） | gift（赠送） | manual（后台补单）
```

## 3. 迁移历史

| 文件 | 内容 |
|---|---|
| `0000_baseline.sql` | 全部现有表（从 `src/db/schema.ts` 全量生成） |

**尚未发布，所以迁移链只有一条 baseline。** 改表就直接改 schema 并重生成 baseline；
一旦打了 `v*` tag，就变成追加式：已发布的迁移不能再改（`check:migrations` 以最近一次
release tag 为基线强制这一点），只能新增下一条。

## 4. 升级路径（重要）

- **全新库**：`wrangler d1 migrations apply` 会按顺序跑完所有迁移。
- **已存在的老库**（`d1_migrations` 为空但表已存在）：`0000_baseline.sql` 会重复建表失败。
  处置方式（一次性）：

  ```bash
  # 以远程库为例；本地库去掉 --remote
  npx wrangler d1 execute clever-vpn-crm --remote --command \
    "CREATE TABLE IF NOT EXISTS d1_migrations (id INTEGER PRIMARY KEY, name TEXT UNIQUE, applied_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP NOT NULL);
     INSERT OR IGNORE INTO d1_migrations (name) VALUES ('0000_baseline.sql');"
  ```

  之后正常 `migrations apply`，只会跑增量。
- **本地库**：直接 `npm run db:reset`（删 `.wrangler/state/v3/d1` 重建），不需要上面的手工步骤。

## 5. 已知取舍

- **`orders.plan_snapshot` 用 JSON 而不是子表**：快照只读、不需要 JOIN、字段会随业务演进，
  子表反而要跟着改 DDL。
- **`orders.refunded_minor` 是缓存和**：真相在 `refunds` 明细；两者不一致时以明细重算。
- **`platform_subscriptions.params_version`**：D1 没有行锁，靠"读版本 → 写前比对"
  避免结算与后台改动互相覆盖（domain.md I3）。
- **`customers` 与 cf-api 是弱引用**：`cf_customer_id` 可能为空（尚未绑定），
  不做外键约束（D1 跨库无外键）。
