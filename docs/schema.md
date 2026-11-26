# 表结构（Drizzle / D1）

Last updated: 2026-11-26

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
npm run db:embed        # 把 migrations/ 内嵌进 Worker（分片门禁的期望值）
npm run db:embed:check  # 只校验生成文件是否最新（CI 跑这个，不写文件）
```

| 目录 | 用途 | 入库 | 谁生成 / 谁应用 |
|---|---|---|---|
| `migrations/` | **生产链**：追加式、不可变的历史 | ✅ | `drizzle-kit generate` → 应用方见下方「应用方式」（自部署=CI，分片=shard 门禁） |
| `migrations-dev/` | **开发链**：全量 schema + dev 种子 | ❌（gitignore） | `scripts/reset-db.sh` 每次重建 |

两套是**同一份 schema**的两种形态：生产链是"从零到今的每一步"，开发链是"现在长什么样"。
开发时可以随便重置，因为 dev 链每次都从 `src/db/schema.ts` 重新生成。

- `drizzle.config.ts`：`dialect: sqlite`、`schema: ./src/db/schema.ts`、`out: ./migrations`。
- **不手写 SQL**：所有 DDL 由 schema 生成。
- `migrations/meta/` 是 drizzle 的快照链，**必须提交**，否则下次生成会全量重建。
- `wrangler.jsonc` 里 `migrations_dir` = `migrations-dev`（本地）；CI 渲染配置时
  改回 `migrations`（`scripts/render-config.mjs`），所以部署永远用生产链。

### 基线（2026-11-21 压缩）

CRM 尚未正式发布，历史上有 19 个递增迁移（`0000_baseline` + 18 个 drizzle 自动命名）。
2026-11-21 一次性压成**一条基线** `migrations/0000_baseline.sql`（从 `src/db/schema.ts`
全量生成），旧 tag `v0.1.0/v0.1.1` 一并删除。

之后所有变更都在它之上 `npm run db:generate -- --name <语义名>` 追加，**不要改已发布的文件**。
`npm run check:migrations` 的"不可变"段以**最近一次 tag** 为界：没有 tag 时允许重写整条链。

### 应用方式

| 环境 | 谁执行 | 怎么做 |
|---|---|---|
| 本地开发 | 你 | `npm run db:reset`（或 `db:migrate:local`） |
| 自部署（`MODE=single`） | **GitHub Actions** | deploy.yml 里的「应用数据库迁移」步骤：`wrangler d1 migrations apply DB --remote`，**在 `wrangler deploy` 之前**。整个库只有一个 + 部署唯一路径是 CI ⇒ 失败要在 CI 里红叉，而不是等用户访问时 500 |
| 托管分片（`MODE=multi`） | **CRM shard 自己** | `src/db/schema-guard.ts`：租户**第一次请求**时按需补齐（一个文件一个 `batch`，DDL 与台账同批）；库比代码新 ⇒ 503 `schema_ahead` |

两种模式的分工是**有意的**：自部署一个库、一次部署；托管一片几百上千个库，逐库扫既慢
又与发布耦合。谁持有这个库的绑定，谁就在它被访问时执行 —— 这是同一条理由的两面。

`src/db.ts` 只剩一次**只读探测**（核心表不存在就报错提示去跑迁移），它是兜底，不是
迁移判据：判据只有一处，即租户库的 `d1_migrations` 台账 + 内嵌 bundle 的文件名集合。

### dev 种子

`scripts/reset-db.sh` 里的 `dev_seed()` 维护，重置后直接可用：

- 管理员：`ops@example.com` / `crm-admin-2026`
- 套餐：周期 / 流量 / 加量（**没有"礼品包"**：赠送一律走礼包核销或调整权益，不靠 0 元套餐）
- 2 个客户、1 个订阅、1 张购买单 + 1 张 0 元赠单

## 2. 表清单

### 2.1 身份

| 表 | 用途 | 关键列 |
|---|---|---|
| `admin_users` | 管理员（单账号） | `email` unique、`password_hash`、`totp_*`、`failed_attempts`/`locked_until` |
| `admin_sessions` | 后台会话（cookie） | `id` = sha256(token)、`pending`（2FA 挑战票） |
| `audit_log` | 审计 | `at`、`actor`、`action`、`target`、`detail` |
| `customers` | **客户身份**（不含权益） | `email` unique、`referral_code`、`marketing_opt_out`（退订营销通知；验证码不受影响）；与 cf-api 的关联在 `platform_subscriptions.platform_customer_id` |
| `email_codes` | 邮箱验证码（只存哈希） | `email` PK、`purpose`、`expires_at`、`attempts` |
| `app_sessions` | App 会话（Bearer） | `id` = sha256(token)、`revoked_at` |

### 2.2 商品与权益

| 表 | 用途 | 关键列 |
|---|---|---|
| `promotions` | 促销活动 / 礼包规则（`kind`=coupon/gift/referral） | `rewards_json`、`audience`、`plan_id`（载体套餐）、`notify`（领取后是否发收据，默认 0）、`visible`（是否在货架上公开） |
| `plans` | 可售商品定义（**可变目录**，历史靠快照） | `kind`(period/traffic/addon)、`price_minor`、`visibility`(public/hidden)、`status`(draft/active/retired)、`trial`（免费试用，全库最多一个）、`retired_at` |
| `platform_subscriptions` | **订阅**（当前权益，**一个客户一行**：`uq_subs_customer`） | `kind`、`order_id`、`period_quota_gb`/`period_extra_gb`/`period_anchor_day`/`period_settled_at`（period 专有）、`traffic_total_gb`/`traffic_remaining_gb`/`traffic_synced_at`/`traffic_validity_days`（traffic 专有）、`expires_at`、`hold`/`hold_reason`（手工控制位）、`activation_code`、`trial`（快照：这份权益是不是试用） |
| `redemptions` | **核销台账**（谁在哪个活动上用掉了一次名额；`(promotion_id, customer_id)` 唯一 = 每人每活动 1 次） | `order_id`（有值 = 支付时核销的券；**NULL = 礼包**，本来就没有订单）、`settled_at`（**NULL = 占位中**：已占下这次核销，还没发完；超 5 分钟可被接管）、`code_id`、`granted_json`（实际生效）、`promotion_snapshot`（当时的名称/角标/配置） |
| `notices` | **通知队列**（= 邮件队列 = 站内消息）：`(kind, customer_id, ref_id)` 唯一 = 同一次领取只通知一次 | `kind`(gift_granted=收据)、`ref_id`（核销行 id）、`title`/`body`（创建时定稿）、`action_url`、`status`(pending/sent/failed/suppressed/skipped)、`attempts`、`next_attempt_at` |
| `settings` | 运行期配置（键值对）：`mail_daily_quota` / `mail_soft_ratio` | `key` PK、`value`、`updated_at` |
| `domain_checks` | 自定义域名最近一次「状态检查」的结论（DNS/HEAD 检查在 CRM，cf-api 不存） | `hostname` PK、`status`、`checked_at` |
| `subscription_changes` | 权益变更台账（**单行模型的历史全在这里**） | `action`(new/renewal/upgrade/addon/settle/hold/gift)、`paid_minor`、`residual_minor`、`payable_minor`、`kind_before`/`kind_after`、`plan_before`/`plan_after`、`expires_before`/`expires_after`、`period_extra_before`/`period_extra_after` |

### 2.3 钱

| 表 | 用途 | 关键列 |
|---|---|---|
| `orders` | **订单 = 一次支付尝试**（见 [`payments.md`](payments.md) §2） | `code` unique、`plan_snapshot`（JSON 快照）、`amount_minor`/`currency`（CRM 账本）、`provider_amount_minor`/`provider_currency`/`fx_rate`（实际扣款与汇率快照）、`source`(purchase/gift/manual/test/mock)、`payment_method`、`gateway_id`、`provider_order_no` unique、`provider_trade_no`、`pay_url`、`expires_at`、`raw_create`/`raw_notify`、`next_poll_at`/`poll_attempts`、`return_poll_at`（回跳页查询冷却）、`status`、`refunded_minor`、`voided_at`、`provision_action`（落账写法）、`provision_*` |
| `refunds` | 退款**明细**（可多次部分退） | `order_id`、`amount_minor`、`mode`、`operator`、`channel_refund_id`、`status` |
| `adjustments` | 管理员**调整**（非售卖） | `field`、`before_value`、`after_value`、`reason`、`operator`、`platform_applied_at` |
| `payment_gateways` | **支付网关配置**（一条 = 一份能收钱的凭据） | `driver`(epay_v1/generic_json_v1/stripe/paypal/manual)、`paypal_env`（sandbox/live；仅 PayPal，新建默认 sandbox；旧 null 按 sandbox）、`methods`、`channel_codes`（账户通道号，实例值）、`mapping`（协议类型）、`priority`、`status`(draft/live/disabled/deleted)、`currency`（网关币种）、`fx_rate`（1 网关币种 = X CNY）、`secret_enc`（API 密钥）、`webhook_enc`（Stripe signing secret / PayPal webhook id）、`test_amount_minor`、`test_create_ok_at`/`test_query_ok_at`/`test_callback_ok_at`、`test_require_callback`、`tested_config_hash`、`last_test_order_id` |

> **没有 `payment_attempts` 表**：订单本身就是那次尝试的证据。理由见 `payments.md` §2。

### 2.4 订单状态与来源

```
status: pending → paid → provisioning → active
                     ↘ expired（超时/明确失败；钱晚到仍可转 paid）
        paid → refunded（可能同时 voided）
        周期到期 → closed
source: purchase（自助） | gift（赠送） | manual（后台补单） | test（网关测试，不发权益） | mock（租户测试网关，走完整履约） | sandbox（PayPal Sandbox，走完整履约）
```

### 2.5 容易混的字段（`platform_subscriptions`）

列名带**类型前缀** (`period_*` / `traffic_*`) 就是为了让这张表不再靠猜：

| 字段 | 属于 | 它回答什么 | **不是** |
|---|---|---|---|
| `period_quota_gb` | period | 每月额度 P —— 月结时**重置回这个数** | 不是"还剩多少" |
| `period_extra_gb` | period | 额外流量池 B（加量包 + 礼包赠送 + 邀请），**不随月度重置清零** | 不是月度额度，也不是"结转"——本月没用的额度会消失 |
| `period_anchor_day` | period | 月结锚点日（1–28，取购买日、超过 28 归 28） | — |
| `period_settled_at` | period | 上次月结时间（`settle()` 的幂等依据） | 不是到期时间 |
| `traffic_total_gb` | traffic | 整包容量（残值的分母） | 不是剩余 |
| `traffic_remaining_gb` | **两种都有** | 平台真实剩余（GB）—— **缓存**，随用户使用下降 | ⚠️ 不是权威值；`null` = 从未同步，**不等于 0**（不能当"用完"） |
| `traffic_synced_at` | **两种都有** | 上面那个缓存最后一次与 cf-api 对齐的时间 | TTL 过 15 分钟视为过期 |
| `traffic_validity_days` | traffic | 有效期天数快照 | 仅快照，续费看套餐当时的值 |
| `paid_minor` | — | 这份权益的**成交价**（残值 = `paid_minor × 剩余比例`） | ⚠️ 不是累计付款：加量包/赠送**不得覆盖它** |
| `order_id` | — | **最初**让权益生效的那笔订单（I1） | 只在 `action='new'` 写；续费/升级/加量不覆盖（去 `subscription_changes` 查） |
| `hold` / `hold_reason` | — | **人的意图**（冻结 / 作废） | 不是状态：状态由 `expires_at` + 余量算出来，不落库 |
| `currency` | — | 套餐成交币种（CRM 账本） | 不是网关扣款币种；网关币种/汇率在 `payment_gateways` 与 `orders.provider_*` |
| `activation_code` | — | cf-api 激活码 | 设备数变了会被置空等重新落账（旧码立即失效） |

**"还剩多少"的统一口径**（对外 API 的 `remaining_gb`）：

- traffic：`traffic_remaining_gb`
- period：`traffic_remaining_gb` 优先（真值）；还没同步过就退化成 `period_quota_gb + period_extra_gb`
  —— 即"这个周期最多还能用多少"，宁可多显示，也不误报"已用完"。

**什么时候必须回源平台**（不能吃 15 分钟缓存）：任何**写平台余额**的操作（加量包落账、改额度、
月结）。用旧缓存会把用户已经用掉的流量又还回去。

## 3. 迁移历史

| 文件 | 内容 |
|---|---|
| `0000_baseline.sql` | 全部现有表（从 `src/db/schema.ts` 全量生成） |
| `0001_wonderful_sheva_callister.sql` | 新增 `domain_checks`（自定义域名状态检查缓存） |
| `0002_true_menace.sql` | `orders.return_poll_at`（回跳页查询冷却）、`payment_gateways.webhook_enc`（Stripe signing secret / PayPal webhook id） |
| `0003_instance_channel_codes.sql` | `payment_gateways.channel_codes`（账户通道号）；把 mapping 里的通道号搬到实例，并清理 mapping 中 `channel_codes`/`exclude_variants`/`pay_url_force_https` |
| `0004_polite_meggan.sql` | 网关测试/费率字段（`fx_rate`、`test_amount_minor`、测试状态、`tested_config_hash`）；订单 provider 金额/币种/汇率 |
| `0005_right_ser_duncan.sql` | `payment_gateways.test_require_callback`（测试是否必须验证通知） |
| `0006_vengeful_stryfe.sql` | `payment_gateways.paypal_env`（PayPal 每网关 sandbox/live；新建默认 sandbox） |

**追加式迁移。** 改表继续 `npm run db:generate` 追加，不要改已提交的历史；一旦打了 `v*` tag，
`check:migrations` 会以最近一次 release tag 强制不可变。

## 4. 升级路径（重要）

三种库，三种处置。**没有"自动猜历史"这条路。**

### 4.1 托管分片（`MODE=multi`）

| 库的状态 | 门禁的判断 | 处置 |
|---|---|---|
| 空库（池里新建 / 清空重开后） | 台账不存在 ⇒ 视为空集 | 第一次请求里 `batch` 跑完整条链 |
| 台账 = 这条链的前缀 | 缺几个文件 | 一个文件一个 `batch` 补齐；已记账的不动 |
| 台账里有代码不认识的名字 | **库比代码新** | **503 `schema_ahead`**，不服务、不撞表 |

> 压基线（2026-11-21）**之前**建过的库，台账是旧的 19 条 —— 按集合判据就是"领先"，
> 会被拒绝服务。CRM 尚未发布，这些库一律**清空重开**（回收 / 重新开通 / 删库重建），
> **不写兼容补丁**：猜"那 19 条大概是哪些文件"等于给每个库写一段一次性历史，猜错的
> 代价是数据，而不是一个报错。

### 4.2 自部署（`MODE=single`）

- **全新库**：`wrangler d1 migrations apply` 按顺序跑完所有迁移。
- **表已存在但台账为空的老库**：`0000_baseline.sql` 会重复建表失败。一次性处置：

```bash
# 以远程库为例；本地库去掉 --remote
npx wrangler d1 execute clever-vpn-crm --remote --command \
  "CREATE TABLE IF NOT EXISTS d1_migrations (id INTEGER PRIMARY KEY, name TEXT UNIQUE, applied_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP NOT NULL);
   INSERT OR IGNORE INTO d1_migrations (name) VALUES ('0000_baseline.sql');"
```

  之后正常 `migrations apply`，只会跑增量。

### 4.3 本地库

直接 `npm run db:reset`（删 `.wrangler/state/v3/d1` 重建），不需要上面的手工步骤。

## 5. 已知取舍

- **`orders.plan_snapshot` 用 JSON 而不是子表**：快照只读、不需要 JOIN、字段会随业务演进，
  子表反而要跟着改 DDL。
- **`orders.refunded_minor` 是缓存和**：真相在 `refunds` 明细；两者不一致时以明细重算。
- **`orders.provision_action`（`new|renewal|upgrade|addon`）**：落账写哪些字段由它决定
  （`domain.md` I8）。它必须随订单持久化——cron 重试只看得到订单，重试用了另一种写法就会
  把平台余额写成满额。存量单为 `NULL`，按 `new` 处理。
- **`customers` 与 cf-api 是弱引用**：`platform_subscriptions.platform_customer_id` 可能为空
  （尚未落账），不做外键约束（D1 跨库无外键）。平台侧被删后由登录自检 / 后台按钮重建。
