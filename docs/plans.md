# 套餐模型：续订与升级规则

Last updated: 2026-10-24

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
（`traffic_balance` 是唯一账本）。代价是要跑一个每小时一次的幂等结算任务（✅ 已实现，见 §6）。

`traffic_balance = NULL` 就是**不限量**：cf-api 对 `NULL` 直接不计费
（`packages/tenant/src/modules/customers/bandwidth.ts:263`），不需要额外标志位。

## 2. 一个用户同时只有一个主订阅

订阅只有**一行**（`UNIQUE(customer_id)`，见 `domain.md` §1.2）。有了主订阅之后，能做的
只剩下**续订**和**升级**：

| 当前状态 | 买同一个套餐 | 买**标价更高**的套餐 | 买**标价相同/更低**的 | 买 `addon` |
|---|---|---|---|---|
| 无主订阅 / 已 `inactive` | `buy` | `buy` | `buy` | `blocked`（先有周期套餐） |
| 生效中（`period` / `traffic`） | **`renewal`**（全款、顺延） | **`upgrade`**（残值抵扣） | `blocked`（不支持降档） | **`period` 就能买**（`buy`，不限量除外） |

- **续订不选计划**：App 上就一个“续订 ¥X / N 天”按钮，用户不用挑。
- **升级只认标价**：`目标 price_minor > 当前套餐 price_minor`，且 `应付 = 新价 − 残值 > 0`。
  两条都要：只看残值会让“便宜的套餐也叫升级”，只看标价会“升级还倒找钱”。
- **升级可以跨 `kind`**（周期 ⇄ 流量都行），因为残值是“实付价 × 剩余比例”，与量纲无关。
- **加购包不折钱**：`addon` 是纯 GB 余额，升级时原样搬到新订阅。
- **加购没有开关**：只要有一份生效中的周期套餐就能买加量包（它不产生第二份订阅，
  只往 `period_extra_gb` 上加 GB）；唯一例外是不限量套餐——加了对用户没有任何作用。
- **加量包可买时 `action` 就是 `buy`**：它的交易行为恒为“按标价加流量”，不需要单独一格
  （`kind === "addon"` 已经说明它是什么）。

## 3. 残值换购（**只用于升级**）

$$\text{残值} = \text{实付价} \times \text{剩余比例}, \qquad \text{应付} = \text{新套餐价} - \text{残值} > 0$$

| `kind` | 剩余比例 | 精度 |
|---|---|---|
| `period` | `剩余小时 / (term_days × 24)` | 按**小时** |
| `traffic` | `剩余 GB / traffic_gb` | 按 GB |

- **实付价**，不是目录价（促销价买的不按原价折）。用目录价折算会被促销套利。
- **续订不走残值**：续订是“按当前计划再来一份”，付全款，
  `到期日 = max(现在, 原到期日) + 期限`。用户不亏（时间照加），但也不残值抵扣 ——
  两种口径只能选一个，我们选“一眼能看懂的顺延”。
- **升级时新订阅从今天起算**：旧的剩余时间 / 流量已经折成钱，不再叠加。
- **加购包余额原样搬过去**，不折算（它是 GB，不是钱）。
- 商店通道（`apple_iap` / `google_play`）的升级由商店自己做 proration，不参与残值抵扣。

实现：`src/plans/quote.ts`（纯函数，单测在 `test/plans.test.ts`）。
App 只读 `/plans[].action`（`buy` / `renewal` / `upgrade` / `blocked` / `login_required`）
与 `payable_minor` 渲染按钮；升级的应付必须点开走 `POST /quote`（列表不带残值），
**App 不做任何计算**。契约正文在 `clever-vpn-docs` `app-crm.md` §2.4.7 / §2.4.8。

## 4. 数据模型

```sql
plans (id, name, kind, price_minor, currency, licence_limit,
       term_days, monthly_quota_gb, traffic_gb, validity_days,
       line_ids JSON, up_mbps, down_mbps, sales_channels JSON, store_product_id JSON,
       sort_order, status, visibility, retired_at, created_at, updated_at)
```

`plans` 是**可变目录**，不是不可变的历史表：

- `status`：`draft`（未上架）→ `active`（在售）→ `retired`（已下架）。
- **任何状态都能原地改**（`PATCH /api/admin/plans/:id`）。改价、改额度、改线路直接改这一行，
  **只影响之后的新购买**；已卖出的订阅用自己的快照（`platform_subscriptions`），不受影响。
- 历史为什么安全：成交事实各自冻结 —— `orders.plan_snapshot`（下单瞬间的完整套餐定义）
  与订阅行上的权益列。`plan_id` 因此**长期稳定**，收入统计可以直接 `GROUP BY plan_id`。
- `id` 不可改（订单与订阅都指着它）；`status` / `retired_at` 只能由 `publish` / `retire` 改，
  不能用一次 `PATCH` 绕过状态机。
- `retire` **只断绝「还能再卖」**，不会让老用户掉线，也不影响他们升级（升级报价读订阅快照）。
- `line_ids`：空数组 = 不限线路。它只是**展示层过滤**（App 与 `/api/v3/key-lines` 取交集），
  不是权限边界——真要做「这个套餐不能连那条线路」得改 cf-api。

### 4.1 商店商品 ID（`sales_channels` + `store_product_id`）

一个套餐可以在多个渠道卖，`sales_channels` 列出渠道，`store_product_id` 存各商店的商品 ID。

> `sales_channels` 回答"**在哪儿卖**"；"用什么付钱"是 `orders.payment_method`。
> 支付侧的词表见 [`payments.md`](payments.md)。

```jsonc
{
  "sales_channels": ["web_checkout", "apple_iap", "google_play"],
  "store_product_id": { "apple": "vpn.period.100g.month", "google": "vpn_period_100g_month" }
}
```

| 渠道 | 在哪卖 | 需要商品 ID |
|---|---|---|
| `web_checkout` | 自有收银台（具体能用哪些支付方式由 `payment_gateways` 决定） | 不需要 |
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
| GET | `/api/admin/plans` | 全部套餐（含已下架） |
| POST | `/api/admin/plans` | 新建（一律 `draft`） |
| PATCH | `/api/admin/plans/:id` | 修改（**任何状态**；不能改 `id`/`status`） |
| POST | `/api/admin/plans/:id/publish` | 发布（`draft` → `active`） |
| POST | `/api/admin/plans/:id/retire` | 下架（→ `retired`，只影响能否再卖） |
| POST | `/api/admin/plans/preview` | **干跑**：返回落账控制参数 + 升级报价，不写库 |

`preview` 调的是服务端同一份计算，用来回答「这个套餐发布后，用户实际被写成什么」。

## 6. 订阅与结算（已实现）

`platform_subscriptions` 一行 = 一次成交的**规则快照**（`paid_minor`、`period_quota_gb`、
`period_term_days`、`period_anchor_day`、`period_extra_gb`）；之后改套餐不影响已经卖出去的订阅。

结算不变量：

$$R = P + B, \qquad B' = \min(B, R), \qquad R' = P + B'$$

`R` = 平台余额、`P` = 本月额度（`period_quota_gb`）、`B` = 额外流量池（`period_extra_gb`）。
等价于"按已用量扣包"，但**不需要记录已用量**。本月没用完的额度**不结转**（只看池子）。

- 触发：`crons = ["17 * * * *"]`（`src/index.ts` 的 `scheduled`），幂等——`settle()` 只看 `period_settled_at`。
- **单位**：`settle()` 内部全程用 **GB**；回写 cf-api 时乘 `1024³`（平台存的是字节）。
  读写都经过 `src/platform/client.ts`，换算只在这一层发生。
- **读不到平台余额就跳过本轮**：绝不能拿 `period_quota_gb` 兜底（那等于凭空造额度）；
  `failed` 会记一条错误，下一小时重试。
- 还没落账的订阅（无 `platform_customer_id`）直接跳过，交给 `retryProvisioning`。
- 漏跑几个月：只结算一次并把锚点推到最近一期，**不重放**（中间用量已经滚进 R 了，重放等于凭空发额度）。
- 平台写入失败：`period_settled_at` 不动，下一小时自动重试（不会出现"CRM 以为重置了、平台还是旧余额"）。
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

- [x] 对外 `POST /api/app/v1/quote`（复用 `quotePurchase()`，带 `quote_ttl_s`）
- [x] 下单 / 续订 / 升级时调 cf-api（软删旧客户 → 同 `auth_id` 建新 → 写控制参数 + 存 `platform_customer_id`/`code`）
  —— 实现见 `src/platform/{client,provision}.ts`，失败停在 `provisioning`，cron 每小时重试
- [x] App 端登录（邮箱验证码 + `session_token`）与 `/plans`（每项只带一个 `action`）
- [ ] 读 cf-api `lines` 填充线路选择器
- [ ] 支付（网页收银台 + 商店内购）
