# CRM ⇄ cf-api 契约（草案 v0）

> 状态：**草案**。cf-api 侧能力以实际实现为准，落地前需逐条核对（标记见"状态"列）。
> 版本：`CRM_CONTRACT_VERSION=1`。兼容策略：**只加不删**；破坏性变更升版本并保留旧版本至少一个发布周期。

## 0. 原则

1. CRM 是**可选组件**：cf-api 不认识 CRM，只提供通用原语（租户 API Token、账号、激活码、许可）。
2. CRM **只走公开接口**：托管形态与自托管形态使用同一套端点、同一个租户 Token，没有内部捷径。
3. CRM **不碰资金**：支付由租户的支付服务商直连，CRM 只记录"已到账"事实。
4. CRM **只存最小数据**：终端用户账号 + 激活码 + 订阅状态；cf-api 侧只存与许可相关的信息。

## 1. 认证

| 项 | 约定 | 状态 |
|---|---|---|
| 方案 | HTTP Header `Authorization: Bearer cv_api_<blob>`（租户 API Token） | ✅ cf-api 已有 `apiAuth` |
| 作用域 | 仅租户自身的数据（网关按 token 内混淆的 tenantId 路由） | ✅ |
| 轮换 | 支持轮换旧 token；旧 token 有失效窗口 | ⬜ 待确认 |
| 权限最小集 | 账号读写、激活码签发、许可只读 | ⬜ 待实现（当前可能过宽） |

## 2. 账号（终端用户，租户内）

| 能力 | 端点（拟） | 说明 | 状态 |
|---|---|---|---|
| 创建 | `POST /api/v2/accounts` | 只传最小字段：email、外部 id（CRM 侧主键） | ⬜ 核对是否允许 tenant 角色创建 |
| 查询 | `GET /api/v2/accounts/{id}` | 用于对账 | ⬜ |
| 更新 | `PATCH /api/v2/accounts/{id}` | 限额、备注等 | ⬜ |

## 3. 激活码（**唯一的强耦合点**）

App 用激活码向 cf-api 换取设备许可，因此这条语义必须在 cf-api 侧定义清楚：

| 语义 | 要求 | 状态 |
|---|---|---|
| 生成 | 服务端生成，不可预测（非自增/非时间戳） | ⬜ |
| 作用域 | 绑定租户（token → tenantId），跨租户不可用 | ✅ 反解含 tenantId |
| 单次使用 | 首次兑换后标记 `used`，不可重复兑换 | ⬜ **待实现** |
| 设备绑定 | 记录兑换时的设备标识；可解绑/换绑策略由租户配置 | ⬜ |
| 有效期 | `expires_at`；过期不可兑换 | ⬜ |
| 额度（可选） | 一码多设备 / 一台设备多码等策略 | ⬜ |
| 吊销 | 退款/风控时可吊销未兑换的码 | ⬜ |
| 幂等签发 | 同一 `request_id` 重复调用返回同一个码 | ⬜ |
| 事件 | 兑换成功 → webhook 通知 CRM（可选） | ⬜ |

接口（拟）：

```
POST /api/v2/activation-codes        { request_id, account_id, expires_at?, meta? }
POST /api/v2/activation-codes/{code}/revoke
GET  /api/v2/activation-codes?account_id=…
```

## 4. 订阅与许可（只读）

| 能力 | 端点（拟） | 用途 | 状态 |
|---|---|---|---|
| 许可列表 | `GET /api/v2/licences?account_id=…` | CRM 展示"我的设备/有效期" | ⬜ 核对 |
| 订阅状态 | `GET /api/v2/subscriptions?account_id=…` | 续费提醒 | ⬜ 可能需新增 |

## 5. Webhook（cf-api → CRM）

| 事件 | 载荷 | 签名 |
|---|---|---|
| `licence.expiring` | account_id、licence_id、expires_at | `X-CRM-Signature: sha256=…`（HMAC-SHA256，密钥由租户配置） |
| `activation_code.redeemed` | code、account_id、device_id、at | 同上 |
| `subscription.suspended` | account_id、reason | 同上 |

要求：CRM 侧必须**幂等**处理（事件 id 去重）；cf-api 侧至少重试 3 次，指数退避。

## 6. 版本协商

`GET {CF_API_BASE}/api/v2/platform/meta`（拟）返回 `{ contract: 1, min_crm: "1.0" }`；
CRM 启动时校验自己的 `CRM_CONTRACT_VERSION` 是否被支持，不支持则拒绝启动并给出提示。
