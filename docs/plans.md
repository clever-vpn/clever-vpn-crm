# 套餐模型与换购规则

Last updated: 2026-10-23

> 权威契约在 [`clever-vpn-docs` `app-crm.md` §2.4.7 / §2.4.8](https://github.com/clever-vpn/clever-vpn-docs/blob/main/docs/contracts/app-crm.md)。
> 本文只讲**本仓库怎么实现**，不复制契约正文。
> 实体定义（客户 / 订单 / 订阅 / 退款）见 [`domain.md`](domain.md)。

## 一句话

**所有销售策略都在 CRM，App 里没有一行价格或资格判断。**
改价、上下架、换规则 = 改 `plans` 表 + 重新发布，**App 不用发版**。

## 1. 只有三种套餐

| `kind` | 卖给谁 | 落到 cf-api |
|---|---|---|
| `period` | 主订阅：按时间，含月度额度 | `expire_date = today + term_days`；**`quota = NULL`**；`traffic_balance = monthly_quota_gb` |
| `traffic` | 主订阅：一次性流量 | `expire_date = today + validity_days`（空=永久）；**`quota = NULL`**；`traffic_balance = traffic_gb` |
| `addon` | 附加包：只能挂 `period` | `traffic_balance += traffic_gb`，不动到期日 |

不允许租户自由拼「时长 × 流量 × 设备 × 速率 × 叠加」——组合维度一多，
「这单到底怎么算」就会变成客服问题，App 也没法稳定渲染。要卖 3 个月就建一个 `term_days=90` 的套餐。

### 为什么 `quota` 恒为 `NULL`

平台的月度重置边界是**记账自然月**：10 号买的用户永远拿不到完整的 30 天额度，
和「每月 100GB」这句话对不上。所以重置权收归 CRM，按**每个用户的购买锚点**结算
（`traffic_balance` 是唯一账本）。代价是要跑一个每小时一次的幂等结算任务（⬜ 待实现）。

`traffic_balance = NULL` 就是**不限量**：cf-api 对 `NULL` 直接不计费
（`packages/tenant/src/modules/customers/bandwidth.ts:263`），不需要额外标志位。

## 2. 一个用户同时只有一个主订阅

| 当前状态 | 买 `period` | 买 `traffic` | 买 `addon` |
|---|---|---|---|
| 无主订阅 / 已到期 / 流量用尽 | ✅ | ✅ | ❌ |
| `period` 生效中 | ✅ 续费或升档 | ❌ | ✅（`allow_addons` 且非不限量） |
| `traffic` 生效中 | ❌ | ✅ 换更大包 | ❌ |

- **不支持降档**：换购后应付 < 0 一律拒绝（否则等于返现）。
- **不跨 `kind` 换购**：想要另一种，等当前订阅结束再买。
- 同档续费也走换购 —— 残值直接抵扣，等于「提前续费不亏」，不需要单独的续费规则。

## 3. 残值换购（唯一升级规则）

$$\text{残值} = \text{实付价} \times \text{剩余比例}, \qquad \text{应付} = \text{新套餐价} - \text{残值}$$

| `kind` | 剩余比例 | 精度 |
|---|---|---|
| `period` | `剩余小时 / (term_days × 24)` | 按**小时** |
| `traffic` | `剩余 GB / traffic_gb` | 按 GB |

- **实付价**，不是目录价（促销价买的不按原价折）。用目录价折算会被促销套利。
- 新订阅**从今天起算**，剩余时间不叠加。
- 加购包余额**原样搬过去**，不折算。
- 商店通道（`apple_iap` / `google_play`）的升级由商店自己做 proration，不参与残值换购。

实现：`src/plans/quote.ts`（纯函数，39 个单测在 `test/plans.test.ts`）。

## 4. 数据模型

```sql
plans (id, name, kind, price_minor, currency, licence_limit,
       term_days, monthly_quota_gb, traffic_gb, validity_days, allow_addons,
       line_ids JSON, up_mbps, down_mbps, channels JSON, store_product_id JSON,
       sort_order, status, supersedes_id, retired_at, created_at, updated_at)
```

- `status`：`draft` → `active` → `retired`。
- **`active` 的行不可原地修改**（历史订单要能追溯当时的规则）。
  改价/改内容：`POST /plans/:id/clone` 生成 `supersedes_id` 指向旧行的新草稿 → 发布 → 下线旧行。
- `line_ids`：空数组 = 不限线路。它只是**展示层过滤**（App 与 `/api/v3/key-lines` 取交集），
  不是权限边界——真要做「这个套餐不能连那条线路」得改 cf-api。

### 4.1 商店商品 ID（`channels` + `store_product_id`）

一个套餐可以在多个渠道卖，`channels` 列出渠道，`store_product_id` 存各商店的商品 ID：

```jsonc
{
  "channels": ["web_checkout", "apple_iap", "google_play"],
  "store_product_id": { "apple": "vpn.period.100g.month", "google": "vpn_period_100g_month" }
}
```

| 渠道 | 在哪卖 | 需要商品 ID |
|---|---|---|
| `web_checkout` | 自有收银台（`payment_channels` 决定具体支付方式） | 不需要 |
| `apple_iap` | App 内购买（App Store） | 需要 `apple` |
| `google_play` | App 内购买（Google Play） | 需要 `google` |

**ID 由我们定义，平台不会自动生成。** 流程是：

1. 先到 App Store Connect / Play Console 把商品建好；
2. 把建好的 ID **原样抄进**这里（`validatePlan` 会校验：选了哪个商店通道就必须填对应的键）；
3. 发布前确认商品在商店侧是**可购买状态**（Apple `Ready to Submit` 之后还需随版本提交；
   Play 的 base plan 必须**激活**，否则客户端查不到）。

两者**不能通用**——是不同的商品注册表，同一个字符串在两边没有任何关联：

| | Apple | Google |
|---|---|---|
| 创建位置 | App 内购买项目 | 订阅（含 base plan / offer） |
| 唯一性 | 本 App 内唯一 | 本 App 内唯一 |
| 允许字符 | 惯例用反向域名：`vpn.period.100g.month` | 只能**小写字母/数字/`.`/`_`**，不能有连字符 |
| 能否改名 | **不能**（只能新建） | **不能**（只能停用后新建） |
| 升降级 | 同一 Subscription Group 内由系统接管 | 同一订阅下的 base plan / offer 由系统接管 |

三条实践结论：

- **起名一次到位**（`vpn.period.100g.month` 这类「规格」命名，别把价格写进去），
  因为两端都不能改名。
- 只在一边建了商品、另一边也填了同样的字符串 ⇒ 用户在缺的那一端购买会拿到
  「商品不存在」，且报错发生在客户端，后台看不到。
- 交易标识（Apple `transactionId`、Google `purchaseToken` / `GPA.…`）是**付款时平台生成的**，
  不进这张表，落 `orders.external_id` 用于对账；回调里**以服务端查到的商品 ID 为准**，
  不信客户端上报，否则改本地包就能买任意套餐。

## 5. 后台入口

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/api/admin/plans` | 全部套餐（含历史版本） |
| POST | `/api/admin/plans` | 新建（一律 `draft`） |
| PATCH | `/api/admin/plans/:id` | 只能改草稿 |
| POST | `/api/admin/plans/:id/clone` | 克隆为下一版本草稿 |
| POST | `/api/admin/plans/:id/publish` | 发布 |
| POST | `/api/admin/plans/:id/retire` | 下线 |
| POST | `/api/admin/plans/preview` | **干跑**：返回落账控制参数 + 换购报价，不写库 |

`preview` 调的是服务端同一份计算，用来回答「这个套餐发布后，用户实际被写成什么」。

## 6. 订阅与结算（已实现）

`platform_subscriptions` 一行 = 一次成交的**规则快照**（`paid_minor`、`quota_gb`、`term_days`、
`anchor_day`、`balance_gb`）；之后改套餐不影响已经卖出去的订阅。

结算不变量：

$$R = P + B, \qquad B' = \min(B, R), \qquad R' = P + B'$$

`R` = 平台余额、`P` = 本月额度、`B` = 加购包余额。等价于"按已用量扣包"，但**不需要记录已用量**。

- 触发：`crons = ["17 * * * *"]`（`src/index.ts` 的 `scheduled`），幂等——`settle()` 只看 `last_settled_at`。
- 漏跑几个月：只结算一次并把锚点推到最近一期，**不重放**（中间用量已经滚进 R 了，重放等于凭空发额度）。
- 平台写入失败：`last_settled_at` 不动，下一小时自动重试（不会出现"CRM 以为重置了、平台还是旧余额"）。
- 本地试跑：`POST /api/admin/subscriptions/settle {"dry_run": true}` —— 默认就是 dry-run，
  打印"会写成什么"而不写库。

## 7. 后台补充端点

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/api/admin/customers` | 客户列表（本地联调用；正式由 App 登录创建） |
| POST | `/api/admin/customers` | `{email, display_name?}` 建客户 |
| GET | `/api/admin/subscriptions?customer_id=` | 某客户的订阅历史 |
| POST | `/api/admin/subscriptions` | `{customer_id, plan_id, paid_minor?, now?}` **手工开通**（本地/补单） |
| POST | `/api/admin/subscriptions/settle` | `{customer_id?, dry_run?}` 跑结算（默认 dry-run） |

## 8. 待办

- [ ] 对外 `POST /api/app/v1/upgrade/quote`（复用 `quotePurchase()`）
- [ ] 下单/换购时调 cf-api（软删旧客户 → 同 `auth_id` 建新 → 写控制参数 + 存 `platform_customer_id`/`code`）
- [ ] App 端登录（邮箱验证码 + `session_token`）与 `/plans`（带 `purchasable`/`reason`）
- [ ] 读 cf-api `lines` 填充线路选择器
- [ ] 支付（网页收银台 + 商店内购）
