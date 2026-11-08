# App ⇄ CRM 契约 · 设计期演进记录

Last updated: 2026-10-29
Status: **`deprecated`**（设计期历史，留作考古；权威是契约正文 `clever-vpn-docs/docs/contracts/app-crm.md`）

> **2026-11-08 迁入本仓**（原 `clever-vpn-docs/docs/design/app-crm-history.md`）。
> 理由：它记的是这两个仓在设计期的取舍，只在本仓有用。

Last updated: 2026-10-31

> **这份文件不随契约发布。** 契约本身（[`contracts/app-crm.md`](../contracts/app-crm.md)）只描述
> "现在是什么"，这里记"当初为什么这样、又改过什么"。读者是维护者，不是租户或用户。
>
> 为什么不放进契约：CRM 与 App 都还没发布，v1–v22 从未对外存在过。把这些写进对外文档会让人
> 以为产品已经迭代了二十多版，也会让第一次拿到文档的人读一堆"已删除"。

## 一、版本演化（内部序号，未对外发布）

| 版本 | 日期 | 变更 |
|---|---|---|
| `1` | 2026-10-21 | 曾定"App 不直连 CRM，只走浏览器深链" |
| `2` | 2026-10-21 | **作废 v1**：注册/付费/取码全部在 App 内完成。App 是 CRM 的唯一终端客户端；许可仍只由 cf-api 签发 |
| `3` | 2026-10-21 | **作废 v2 的密码 + 双 token**：改邮箱验证码（无密码）+ 单 `session_token`（不透明，无硬过期，以撤销为准） |
| `4` | 2026-10-22 | **新增商店内购**：`apple_iap` / `google_play` 通道（`POST /orders/iap`、商店通知、Restore）；`web_checkout` 保留给官网构建 |
| `5` | 2026-10-22 | **删除用户取消接口**：订单状态只由 CRM 改变（回调/对账/超时作废）；App 只读 |
| `6` | 2026-10-22 | **拆分 channel / method / provider**：支付宝/微信由租户配置的服务商承接（缺省 qwgua），新增服务商不改 App/契约 |
| `7` | 2026-10-22 | **单币种**：初始化时定 `currency`（默认 CNY），不可变；金额用最小单位整数；IAP 不受影响 |
| `8` | 2026-10-22 | **套餐由租户定义**：`grant` + `quota_gb`（映射 `customers.quota`，平台每月重置）+ `mode:subscribe/topup` |
| `9` | 2026-10-22 | **客服入口 + 品牌官网**：`GET /support`（免登录）；游客结账先邮箱验证（`checkout/start|verify` → `checkout_token`），官网无登录态 |
| `10` | 2026-10-23 | **套餐模型收敛为 `kind` 三选一**（`period` / `traffic` / `addon`，作废 `mode`+`grant`+`quota_gb`）；**`customers.quota` 恒为 `NULL`**，额度重置改由 CRM 按用户锚点做；**新增 `POST /upgrade/quote`**（残值换购，唯一升级规则）；**销售策略 100% 在 CRM**，App 只渲染 `purchasable` / `reason` / `quote` |
| `11` | 2026-10-24 | **`/plans` 收紧为“一个字段回答一个问题”**：删 `purchasable` / `allow_addons`，改单一 `action`（`buy`/`renewal`/`upgrade`/`blocked`/`login_required`）+ `payable_minor` + `next_expires_at`；**升级判定改为按标价比较**（目标 `price_minor` 更高且应付 > 0），同档续费=全款顺延（不再走残值）；`POST /upgrade/quote` 改名 **`POST /quote`**（覆盖四种动作，带 `quoted_at`/`quote_ttl_s`）；`/subscription` **状态三拆**（`status` + `reason` + `status_text`）；`/orders` 去掉入参 `channel`、改 `payment_method` + `expected_payable_minor`，主键统一叫 `order_code` |
| `12` | 2026-10-25 | **官网成为与 App 对等的第二个客户端**：租户品牌站可持有登录态（httpOnly Cookie），与 App 共用同一套 `/auth`、同一张会话表、同一批业务接口；**删除 `public/checkout/*` 与 `checkout_token`**（官网“结账即注册”，走 `/auth/verify`）。**新增促销能力**（§2.9）：`promotion`（自动/带码）+ `referral`（关系）两层，**折扣与赠送分开记账**；`/plans` 加 `original_price_minor`/`promo_badge`，`/quote` 加 `promo_code`/`discount_minor`/`discount_label`，`/auth/verify` 加 `referral_code`，`/me` 加 `referral`，`/orders` 加 `origin` |
| `13` | 2026-10-25 | **勘误 v12 的落账单位**：cf-api 的 `traffic_balance` / `quota` 单位是**字节**（`1 GiB = 1024^3`，见 cf-api `bandwidth.ts` 的 `GIGA`），不是 GB。落账必须乘 `1024^3`，否则 100GB 会被写成 100 字节、用户立即断网。其余接口形状与 v12 一致 |
| `14` | 2026-10-25 | **新增 `GET /orders` 列表**（官网"我的"页收据用；只返回本人的单）。同时把"实现状态"行改为真实情况：CRM 已实现 v13 的全部形状，**未实现** `/orders/iap` 与商店服务端通知 |
| `23` | 2026-10-31 | **商店内购改为「一次性商品」+ 礼包改为「拉取」**（详见 §2.4.3、§2.9）：①内购商品类型 = Apple Non-Renewing / Consumable、Google 一次性商品 ⇒ **删除续订、宽限期、商店侧升降级、Restore Purchases**；到期日仍由 CRM 按 `term_days` 算；②Google 验证改 `purchases.products.get`，consume 由 **CRM 服务端**做（3 天不 consume 自动退款）；③金额记商店原币、不换算、不参与残值；内购渠道**没有促销**（价由商店定）；④礼包只能给**买过的人**领，`/me/gifts` 变成**货架**（含 `sold_out`）、新增领取端点、**删除载体套餐与 0 元订单**、过期用户领取 = 复活；⑤新增**推荐奖励卡**与领取端点；⑥明确**权限只由 CRM 决定**：App 不用 StoreKit 判断是否已购买 |
| `22` | 2026-10-29 | **审核后的收敛**（依据 `design/contract-review.md`）：①**删除 §2.7 客服入口**——客服地址改由 `app.json.links.support` 给，运行时不再问 CRM；②版本协商定义唯一判据 `min_app_contract`（低于它就降级为只读，不再"禁用购买"）；③`/plans` 示例对齐 v19 价格三兄弟；`/quote` 补 `promo_code` / `discount_*` / `applied_promotions`；④明确支付方式候选 = `plans[].payment_methods` ∩ `/payment-methods`；⑤商店：客户端只交凭据、事务号由 CRM 解析，`status` 可为 `pending`，Restore 走同一接口；⑥订单有效期只在 §2.4.1 定义一次（30 分钟）；⑦`provisioning` 期间不得显示"无订阅/去购买"；⑧§6 错误码改为按**用户动作**分三桶（`retryable` / `action_required` / `contact_support`），内部错误统一收敛为 `service_unavailable` | docs |
| `21` | 2026-10-29 | ①商店轨道改由**壳上报能力**决定（`bridge.capabilities().store`）—— 同一个安装包可能来自商店也可能来自侧载，不能再用"构建自己知道"；②新增 **§2.4.3.1 三条轨道只有一套收款规则**：*主动查询即真相*，网页回调 / ASSN / RTDN **一律只当触发器**，`apple_iap` / `google_play` 在 CRM 里就是"只查单的网关"（给出 endpoint / 密钥 / mapping 配置项），超时置 `expired`、迟到仍转 `paid`；③`/orders/iap` 的 `status` 明确为"CRM 查完后的状态" | docs + crm |
| `20` | 2026-10-29 | **支付概念收敛**：删除 `/plans[].channels`，改 `payment_methods`（网页收银台可用方式）+ `store_product_id`（KV，有几个平台给几个）；`GET /payment-methods` 删掉 `channel` 字段。新增 §2.4.0 支付词表：**payment_method 唯一可见，网关/驱动/渠道码永不下发，商店轨道只体现为字段存在性**。`/plans` 保持无状态（不传构建参数） |
| `19` | 2026-10-25 | **展示口径拆开**：`/plans` 新增 `promo_price_minor`（活动价，展示位专用）；`payable_minor` 收紧为"**这个人**要付多少"（只有 `audience=all` 的活动才在匿名时给值）。定价页只收**自动生效**的券（凭码券是站外渠道，`visible` 恒为 0）；自动券的 `badge_label` 必填；`auto_apply` 与发码互斥（`POST /promotions/{id}/codes` → `409 promotion_auto_apply`）；角标文案改为 `系统人群前缀 · 租户文案`，`specific` 永不公开 |
| `18` | 2026-10-25 | **码收敛到一张表**：删除 `promotions.code`，码只有 `promotion_codes`（一活动 0..N 个码；共享码 = 1 个码 + 可被多人用）。新增 `promotions.auto_apply`（优惠券"不用码就生效"改为显式声明，不再靠"code 为空"推断）。**每人每活动固定 1 次**，并新增 `redemptions UNIQUE (code_id, customer_id)`（同码同人一次）。后台不再手填码，只选"发不发 / 共享码还是 一码一人 / 数字"。**用户侧接口零变化** |
| `17` | 2026-10-25 | **批次码**：一个活动可生成 N 个码（一码一人），用量按码统计、可单独作废、可导出 CSV。`promotions.code` 继续作为**主码**；查找顺序是**先主码，再批次表**。**用户侧接口完全不变**（`promo_code` / `code` 里既能填主码也能填批次码） |
| `16` | 2026-10-25 | **新增兑换码**：`POST /redeem`（登录后输码换礼包权益）。码是**分发方式**不是第四类物件 —— 复用 `promotions.code`（全表唯一），**不做批次表**（一码一渠道 = 建多个活动）。新增**载体套餐** `plan_id`：客户没有订阅时用它 0 元开通（「发码领 7 天」就是这条路），有效期由礼包 `days` 决定。兑换失败一律 `200 + ok:false + reason`（与 `/quote` 同口径），猜码失败过频 429 |
| `15` | 2026-10-25 | **促销从"两层"改为"三类物件"**：新增**礼包** `kind = "gift"`（多奖励组合：天数 / 流量 / 重置本月），新增**人群维度** `audience`（取代 `first_purchase_only`）与**冷却** `cooldown_hours`。明确**不做**送设备数（平台侧 `licence_limit` 不可改）与送余额（无钱包）。兑换码推迟到 P3。**对客户端零新增接口** |

## 二、被删掉的功能与原因

### 客服入口（`GET /support`）—— 不再由 CRM 下发

v22 起删除。原 `GET /api/app/v1/support` 由 CRM 在运行时下发客服渠道（聊天/邮件/Telegram/微信），
现在**客服地址由 `app.json.links.support` 在构建时固定**（schema 见 `app-json.md` §1.3）：

- 用 CRM 的品牌必然定制 App（`app.json.crm.base` 已经绑定"这个 App 连哪个 CRM"），
  不存在"CRM 换了、App 不改"的场景，所以运行时下发没有存在理由；
- 客服入口恰恰在"登录不进去 / 服务不可用"时最需要 —— 编进包里才能离线可用；
- 租户想用 CRM 托管的聊天页，就把那个地址填进 `links.support`，协议上不经过 CRM。

`/support` 页面本身仍可以存在于 CRM 的官网上（那是 CRM 自己的页面，不属于本契约）。

## 三、正文里那些 `vNN 起` 标注去哪了

契约正文曾经散落几十处 `v19 起…` / `v22 起…` / `v23 改…`。它们的价值只在"改的那一刻"，
对读者是噪音 —— 2026-10-31 已全部改写为"现在是什么"。想知道"哪一版改的"时：

- `git log -S'<关键词>' -- docs/contracts/`；
- 或看本文件第一节。

## 四、首次公开发布前要做的

1. 契约版本归零：`Contract: 1`、`CRM_CONTRACT_VERSION=1`、`contract: 1`（`contracts/README.md`）、
   `app_contract` / `min_app_contract=1`（`GET /meta`）。
2. 本文件留在 `docs/design/`，**不进对外文档站**。
