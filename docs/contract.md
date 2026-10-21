# CRM ⇄ cf-api 契约（指针）

Last updated: 2026-10-21

**契约正文不在本仓库。** 权威源：

- [`clever-vpn-docs/docs/contracts/crm-api.md`](https://github.com/clever-vpn/clever-vpn-docs/blob/main/docs/contracts/crm-api.md)
  —— 认证、`customers` 字段与可写性、激活码语义、错误码、限流、缺口清单。
- [`clever-vpn-docs/docs/contracts/app-crm.md`](https://github.com/clever-vpn/clever-vpn-docs/blob/main/docs/contracts/app-crm.md)
  —— App 是 CRM 的终端客户端：注册/付费/取码都在 App 内（`/api/app/v1`，⬜），许可仍只由 cf-api 签发。
- [`clever-vpn-docs/docs/contracts/README.md`](https://github.com/clever-vpn/clever-vpn-docs/blob/main/docs/contracts/README.md)
  —— 状态图例与版本策略（`contract: 1`，只加不删）。

本仓库**不复制契约正文**：两处维护必然漂移。这里只记录"实现侧须知"。

## 实现侧须知

| 项 | 值 |
|---|---|
| 契约版本 | `CRM_CONTRACT_VERSION`（默认 `1`），由 `GET /__version` 回显 |
| App 端接口 | `/api/app/v1/*`（⬜ 未实现）；契约见 `app-crm.md`，`app_contract: 2` |
| 平台基址 | `CF_API_BASE`，默认 `https://api.clever-vpn.org` |
| 租户 Token | `CF_API_TOKEN`（`cv_api_…`，只放 `wrangler secret`，禁止落库/落日志） |
| 可用的平台资源 | **只有 `customers`**（`/api/v1/customers` CRUD）；其余模块 403 |
| 激活码 | 就是 `customers.code`（16 位），建客户时自动生成，不可重发/吊销；**用户不可见**，随登录态下发（`platform_token`） |
| 设备额度 | `customers.licence_limit`：创建时必填 1–3，创建后固定（平台硬校验 ⬜，CRM 需先自行拦截） |
| 设备列表 | 平台侧不可读（`licences` 未开 `apiAccess`，⬜）⇒ 本地记录不能声称与平台一致 |
| 控制参数 | `customers` 的 create/update 参数，由租户与 CRM 设定；平台只按它们判定能否使用 |
| 计划 / 套餐 | **CRM 自己的概念**，平台没有；平台只看到 `licence_limit`（1–3）等参数 |

## CRM 侧必须履行的义务

1. **去重**：平台没有 `request_id`，`email` 也没有唯一约束 ⇒ 建号前先按
   `filters[email][$eq]` 查；本地对 email 加唯一索引。
2. **退避**：平台按租户限流 60 次/60 s，429 无 `Retry-After` ⇒ 令牌桶 + 指数退避，
   4xx 不重试，401 告警（token 失效）。
3. **不需要事件**：客户生命周期由本 CRM 管理（创建/删除/改参数都是自己发起），平台的
   `customer_created` / `customer_deleted` 对 CRM 只是回声。轮询仅用于"平台面板被直接操作"
   的例外，默认 5 分钟按 `_updated_at` 增量拉取。
4. **不可写字段**：`PATCH` 对白名单外字段**静默丢弃**（仍返回 200）⇒ 成功判据是
   HTTP 状态 + 返回行，不是"字段变了"。
5. **激活码对终端用户不可见**：只经 `/api/app/v1/subscription` 交给已登录的 App；
   不得出现在订单页/邮件/短信/客服模板里，日志只允许出现掩码尾号。
6. **登录态 = 两把 token**：登录/注册/刷新响应必须携带 `platform` 快照（= 激活码，用户不可见）；
   登录不得因 cf-api 故障而失败；退出登录只清本地两把 token，**不**冻结客户。
   报文与时序以 `app-crm.md` §2.6 为准，此处不复述。
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

