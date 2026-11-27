# CRM ⇄ cf-api 契约（指针）

Last updated: 2026-11-26

**契约正文不在本仓库。** 权威源：

- [`clever-vpn-docs/docs/contracts/services/cf-api/crm.md`](https://github.com/clever-vpn/clever-vpn-docs/blob/main/docs/contracts/services/cf-api/crm.md)
  —— 认证、`customers` 字段与可写性、激活码语义、错误码、限流、缺口清单。
- [`clever-vpn-docs/docs/contracts/services/crm/clients.md`](https://github.com/clever-vpn/clever-vpn-docs/blob/main/docs/contracts/services/crm/clients.md)
  —— 终端客户端（App + Site）与 CRM 的协议：注册/付费/取码（`/api/app/v1`，✅），许可仍只由 cf-api 签发。
- [`clever-vpn-docs/docs/contracts/README.md`](https://github.com/clever-vpn/clever-vpn-docs/blob/main/docs/contracts/README.md)
  —— 状态图例与版本策略（API 路径版本：路径内只加不改）。

本仓库**不复制契约正文**：两处维护必然漂移。这里只记录"实现侧须知"。

## 实现侧须知

| 项 | 值 |
|---|---|
| 契约版本 | 终端 API 的版本 = 路径 `/api/app/v1`（只加不改）；`GET /__version` 只回 `crm_version`，不参与协商；`/meta.crm_id` 是实例 UUID（构建期门禁用） |
| 客户端 | **终端客户端（App + Site）调同一批 `/api/app/v1`**；只用 `Authorization: Bearer`，不用 Cookie |
| Studio 绑定（App） | `POST /api/studio/app-bind`：只认 `Authorization: Bearer aacc_…`（CRM 入场时签，14 天，标签 `app-access/v1`，只对这个端点有效），验签 + `aud` + **tenant 一致**后写 `settings.app.repo` / `app.bound_at`。契约：[`services/crm/app-studio.md`](https://github.com/clever-vpn/clever-vpn-docs/blob/main/docs/contracts/services/crm/app-studio.md) §3.2；身份基底 `studio-identity.md` §2.1.2 |
| 终端接口 | `/api/app/v1/*`（✅ 登录/套餐/报价/下单/订阅/邀请/礼包/时间线已实现）；契约见 `clients`（`clients.md`），版本由路径承载 |
| 用户视角视图 | **全部「CRM 出文案/形式、客户端只渲染」**：`GET /me/timeline`（`title`/`delta_text`/`tone`；`settle`/`hold` 不进）、`GET /orders`（`title`/`amount_text`/`status_text`/`tag`/`tag_tone`/`next_poll_after_ms`）、`GET /me/gifts`（`state`/`status_text`/`rewards_text`/`claimable`/`claim_action`/`empty_text`）、`POST /me/gifts/{id}/claim`（`ok`/`state`/`result_text`）、`GET /subscription`（`status`/`reason`/`status_text`/`tag`/`tag_tone`/`next_reset_at`/`code`） |
| 站点 / 官网 | Site 与 App 共用同一批端点（Bearer + localStorage）；没有 `GET /support`，客服地址由 `app.json.links.support` 构建期固定 |
| 兑换码 | `POST /api/app/v1/redeem`：登录后输码换礼包权益；失败一律 `200 + ok:false + state + result_text`，猜码过频 `429`（统一信封）；与礼包/奖励卡领取同形 |
| 促销 | 三类物件：优惠券（金额）+ 礼包（权益）+ 邀请（关系），见 [promotion.md](promotion.md)；✅ 已实现（`/plans` 角标、`/quote` 折扣、`/auth/verify` 邀请码、`/me.referral`、支付成功才核销、礼包发放 / 人群六值 / 冷却 / 到期挽回定时任务） |
| 套餐 | **`kind` 三选一**（`period` / `traffic` / `addon`），见 [plans.md](plans.md)；**销售策略全在 CRM**，App 只渲染 |
| 币种 | **单币种**，初始化时设定（默认 `CNY`），之后不可改；金额一律用最小单位整数（分） |
| 平台基址 | `CF_API_BASE`，默认 `https://api.clever-vpn.org` |
| 租户 Token | 存本租户 D1 的 `cf_api` 单行（`token_enc`，AES-GCM 密文）；后台「设置 → cf-api 对接」维护。**不是** Worker secret，禁止落日志 |
| 可用的平台资源 | **`customers`（读写）+ `lines`（只读，字段白名单，不暴露 `upstream`）** |
| 激活码 | 就是 `customers.code`（16 位），建客户时自动生成，不可重发/吊销；**不是秘密，但不得展示/记录/进 URL**；`/subscription` 恒返回，App 只用于取许可，Site 由 SDK 丢弃 |
| 设备额度 | `customers.licence_limit`：创建时必填 1–3，创建后固定（平台硬校验 ⬜，CRM 需先自行拦截） |
| 换套餐 | 删旧客户 → 用**同一 `auth_id`** 建新客户（得到新 `code`）；流量余量/已用额度不继承。**已实现**：`licence_limit` 变化时才删旧建新（它是计费依据，平台不允许改） |
| 落账 | `src/platform/provision.ts`：订阅快照 → 控制参数；**流量单位是字节**（`1 GiB = 1024³`），`quota` 恒 `NULL`（月度重置归 CRM）。**按动作分档**（`domain.md` I8）：新购/升级全量、续订 period 只写 `expire_date`、续订 traffic / 加量包只写 `traffic_balance`；动作存 `orders.provision_action`，cron 重试用同一种写法。失败停在 `orders.status='provisioning'`（✅） |
| 平台客户被删 | 小概率运维事故（cf-api 没有 undelete）。**只认 404**：用户重登时 `/auth/verify` 自检，发现客户不在了就按当前订阅**全量重建**（登录绝不因此失败）；新码由随后的 `/subscription` 取；后台另有 `POST /api/admin/customers/:id/provision`「重新落账」。超时 / 429 / 5xx **不重建**。重建必然换码 ⇒ 设备要重新取许可 |
| 线路权益 | 套餐 `line_ids` → 落账写 `customers.line_ids`（`[]` ⇒ `null` = 全部线路）。cf-api 在 `key-lines` / `app-licences` 强制（`crm-api.md` §5.2.1）。后台可对单个客户覆盖（`POST /api/admin/customers/:id/lines`），写订阅快照 |
| 支付方式 | App 只认 **`payment_method`**（`alipay` / `wechat` / `paypal` / `stripe`）；服务商与网关都在 CRM 内部，**不进任何 App 响应**（见 [payments.md](payments.md)） |
| 设备列表 | 平台侧不可读（`licences` 未开 `apiAccess`，⬜）⇒ 本地记录不能声称与平台一致 |
| 控制参数 | `customers` 的 create/update 参数，由租户与 CRM 设定；平台只按它们判定能否使用 |
| 计划 / 套餐 | **CRM 自己的概念**，平台没有；平台只看到 `licence_limit`（1–3）等参数 |

## CRM 侧必须履行的义务

1. **去重**：平台没有 `request_id`，幂等键是 `auth_id = crm:<customer_id>`（**已按
   `filters[auth_id][$eq]` 查**，不按 email——`customers.email` 无唯一约束，面板手工建的行
   `auth_id` 是 `auto:<uuid>`，按 email 认回会接管别人的客户）。平台侧 `auth_id`
   **未删除行唯一**（契约 §7.1 ✅），重复创建返回 `409 auth_id_conflict`，重试路径按
   `auth_id` 取回即可。
2. **退避**：平台按租户限流 60 次/60 s，429 无 `Retry-After`。当前实现是"落账失败留在
   `provisioning` + cron 每小时重试"，**没有**逐次指数退避与令牌桶（⬜）。
3. **不需要事件**：客户生命周期由本 CRM 管理（创建/删除/改参数都是自己发起），平台的
   `customer_created` / `customer_deleted` 对 CRM 只是回声。轮询仅用于"平台面板被直接操作"
   的例外，默认 5 分钟按 `_updated_at` 增量拉取。
4. **不可写字段**：`PATCH` 对白名单外字段**静默丢弃**（仍返回 200）⇒ 成功判据是
   HTTP 状态 + 返回行，不是"字段变了"。
5. **激活码不是秘密，但不得展示**：`/api/app/v1/subscription` 对任何会话都返回；
   不得出现在界面/订单页/邮件/短信/客服模板里，日志只允许出现掩码尾号。
6. **登录只回身份**：`verify` 只返回 `{session_token, user}`；权益与激活码由 `GET /subscription` 取（App 登录后立即拉一次）。
   无密码（邮箱验证码）、单个不透明 `session_token`（无硬过期，以撤销为准）。
   登录不依赖 cf-api；退出登录清本地 token 与本地 code 副本，**不**冻结客户。
   报文与时序以 `clients` 契约为准，此处不复述。
7. **控制参数由租户/CRM 设定**：平台不根据套餐/订单推断任何参数。具体值怎么得出
   （算法或人工）是 CRM 内部实现；写入走 `POST`/`PATCH`，平台只负责按值判定。

## 历史草案的修正（勿再按旧稿实现）

旧版 `docs/contract.md` 曾假设：独立 `activation-codes` 资源、码单次使用、
`/api/v2/accounts`、`/api/v2/platform/meta`、Webhook。核对 cf-api 实现后**均不成立**：

| 旧假设 | 实际情况 |
|---|---|
| `POST /api/v2/accounts` | 不存在；是 `/api/v1/customers` |
| 独立签发激活码 + 吊销端点 | 不存在；码 = `customers.code`，随客户创建/删除 |
| 码单次使用 | 不成立：一码多设备，额度由 `licence_limit` 控制，超限复用最旧 |
| `GET /api/v2/licences` 可用 | 403（未开 `apiAccess`） |
| Webhook + `X-CRM-Signature` | 未实现 |
| `GET /platform/meta` 版本协商 | 未实现 |

新增能力一律先改 `clever-vpn-docs` 的契约，再改这里。

