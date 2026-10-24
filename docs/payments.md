# 支付（收款）

> 本文是 CRM **支付域的唯一出处**：词表、表结构、状态机、网关配置与驱动契约。
> 钱怎么算在 [`plans.md`](plans.md)，东西是什么在 [`domain.md`](domain.md)，
> 表清单在 [`schema.md`](schema.md)。

## 0. 一句话

**用户只选"支付方式"；服务商是谁、走哪条网关、单号多少，全部是内部实现。**

## 1. 词表（只有 6 个词）

| 词 | 字段 | 含义 | 用户可见 |
|---|---|---|---|
| **支付方式** | `orders.payment_method` | 用户选择的那个按钮：`alipay` / `wechat` / `paypal` / `stripe` / `transfer` | ✅ **唯一可见** |
| **服务商** | `payment_gateways.provider` | 谁在收钱：青蛙 `qwgua` / 亿宏 `yihong` / 华俊 `huajun` / `stripe` / `paypal` / `manual` | ❌ |
| **服务商类型** | `payment_gateways.provider_kind` | `aggregator`（聚合，名字无意义）/ `brand`（品牌，名字就是方式）/ `manual`（线下） | 间接（决定显示名） |
| **网关** | `payment_gateways` 一行 | 一条能收钱的配置（凭据 + 支持的方式 + 优先级 + 状态） | ❌ |
| **订单** | `orders` 一行 | **一次支付尝试**的全部证据 | 只见单号 |
| **售卖渠道** | `plans.sales_channels` | 在哪儿卖：`web_checkout` / `apple_iap` / `google_play` | ✅ 间接 |

**不要再用"渠道 channel"指支付。** 这个词已经被"售卖渠道"占用，混用会让每张图都要解释一遍。

### 1.1 显示名规则（`provider_kind` 唯一的作用）

| 类型 | App 里看到 | 租户要做什么 |
|---|---|---|
| `brand`（Stripe / PayPal） | 「PayPal」「Stripe」—— 品牌即方式，**不再细分** | 填密钥即可，无选择 |
| `aggregator`（青蛙/亿宏/华俊…） | 「支付宝」「微信支付」—— **聚合商的名字永远不出现** | 勾选它覆盖了哪几个方式 |
| `manual`（对公转账） | 「银行转账」+ 后台人工确认 | 填收款信息 |

> 所以一个租户可以同时接 3 家聚合商，用户那边仍然只有「支付宝 / 微信」两个按钮。

## 2. 为什么没有 `payment_attempts` 表

第三方收银台的**回调只带回我们自己下发的单号**。这推出一条硬规则：

> **单号创建后不可修改，且永远唯一对应一行订单。**

因此"换一次支付"必须"换一行"：

```
用户点「支付宝」  → 插一行 orders（pending + 新单号）→ 返回 pay_url
用户又点一次      → 再插一行（旧的标 expired）
```

`orders` 这一行就已经是"那一次尝试"的全部证据（单号、报文、金额、网关、超时），
再拆一张 attempts 表只会多一次 join、多一个状态机，没有任何新信息。

## 3. 状态机

```
pending ──回调+查单金额一致──▶ paid ──▶ provisioning ──▶ active
   │                              │
   │超时/明确失败                 └─▶ refunded（走 refunds 表）
   ▼
expired ──钱其实到了（cron 查单）──▶ paid
```

| 状态 | 含义 |
|---|---|
| `pending` | 已下单，等钱 |
| `paid` | 钱确认到账（**只由 `queryCharge` 判定**，回调只当触发器） |
| `provisioning` | 钱已收，正在发权益（失败可重试，**绝不回退**） |
| `active` | 权益已生效 |
| `expired` | 没付成（超时 / 服务商明确失败），原因记 `note` / `raw_create` |
| `closed` | 订阅周期自然结束 |
| `refunded` | 已退款（`refunds` 记明细） |

### 3.1 三条铁律

1. **回调不判定已付。** 验签 → 定位订单 → `queryCharge` 拿权威状态。防伪造，也防
   "回调说 3、查单说 1"的语义分裂。
2. **钱到了必须记账，发不发货另算。** `expired` 的订单收到钱照样转 `paid`，
   不能因为"用户已经点过新的"就把钱丢掉。
3. **发放失败 ≠ 支付失败。** 支付失败可以"当作没订阅再来一次"；**发放失败必须重试补发**
   （`provision_attempts` / `provision_error`），否则就是"收了钱没给货"。

### 3.2 重复付款：不设特殊状态

用户不小心付两次 → 两笔 `paid` → **两笔都发货**（周期套餐自然叠加）。

- 方向是安全的：最坏是"多卖一份"，不是"少给一次"；
- 用户来投诉时，用现成的 `refunds.mode = refund_and_void` 退一笔并扣回权益；
- 所以**不需要** `duplicate` 状态、不需要"重复判定"逻辑、不需要人工队列。

前提：我们的权益**可叠加、可回退**。将来若出现一次性不可逆商品，再单独议。

### 3.3 防双击（体验，不是正确性）

同一客户 + 同一套餐，60 秒内已有一笔未过期的 `pending` → 直接返回它的 `pay_url`，
不新建。就算这层失效，最坏结果也只是上一条（多卖一份，可退）。

## 4. 网关配置与发布闸门

```
draft ──测试支付真收到钱──▶ live ──▶ disabled
```

- **只有 `status = 'live'` 参与路由**，`draft` 在 App 里完全不存在；
- 发布前必须做一次**真实测试支付**：`orders` 里插一条 `plan_id IS NULL` 的单，
  走完 `createCharge → notify → queryCharge`，**不发权益**；
- 面板展示结果：金额、`provider_trade_no`、耗时；失败则摊开 `raw_create` / `raw_notify`。

这条闸门挡掉三类最常见事故：**签名算错、金额单位错（元/分）、`notify_url` 不可达**。

### 4.1 路由与降级

```
method = alipay
  → 取所有 status='live' 且 methods 含 alipay 的网关，按 priority 升序
  → 依次 createCharge，第一个成功即用
  → 全部失败：502 + 告警
```

降级对用户无感（还在支付页）。**唯一要求：每次尝试用新单号**，绝不复用旧单号给第二家。

## 5. 服务商对照

| | 青蛙 `qwgua` | 亿宏 `yihong` | 华俊 `huajun` | Stripe | PayPal | 手动 |
|---|---|---|---|---|---|---|
| 类型 | aggregator | aggregator | aggregator | brand | brand | manual |
| 方式 | 支付宝 / 微信 | 支付宝 / 微信 | 支付宝 / 微信 | card（含 Alipay/WeChat 境外） | paypal | transfer |
| 金额单位 | 元（2 位小数） | 元 | 元 | 分（整数） | 元 | — |
| 签名 | MD5（参数排序 + key） | MD5 | MD5 / RSA | 平台 SDK 验签 | 平台 SDK 验签 | — |
| 回调应答 | `success` | `success` | `SUCCESS` | 2xx | 2xx | — |
| 查单 | 有 | 有 | 有 | 有 | 有 | 人工 |

> 差异全部收在 driver 里，**不进数据库配置**：状态码语义、签名算法这类东西写成配置，
> 等于把 bug 交给租户去调。

## 6. 驱动契约

```ts
interface GatewayDriver {
  createCharge(gw: Gateway, order: Order, opts: { notifyUrl: string; returnUrl: string }):
    Promise<{ providerOrderNo: string; payUrl: string; raw: string }>;
  verifyNotify(gw: Gateway, req: Request, raw: string): Promise<{ ok: boolean; providerOrderNo?: string }>;
  parseNotify(gw: Gateway, raw: string): Promise<{ providerOrderNo: string; amountMinor: number; providerTradeNo?: string }>;
  queryCharge(gw: Gateway, providerOrderNo: string):
    Promise<{ status: "paid" | "unpaid" | "closed"; amountMinor?: number; providerTradeNo?: string }>;
  notifyReply(): Response;   // 各家写法不同（success / SUCCESS / 空 200）
}
```

已定：`epay_v1`（易支付协议族，覆盖绝大多数聚合商）、`generic_json_v1`（自定义）、
`stripe`、`paypal`、`manual`。

### 6.1 自定义映射（只给 `generic_json_v1`）

租户贴一份厂商文档，我们生成并**存进 `payment_gateways.mapping`**（JSON）。
默认值覆盖 ~80% 的易支付变种，租户只需改差异项：

| 键 | 作用 | 缺省 |
|---|---|---|
| `create.method` / `create.path` | 下单请求 | `POST` / 文档给的路径 |
| `create.format` | `form` / `json` | `form` |
| `fields.*` | 参数名映射：`merchant` / `order_no` / `amount` / `subject` / `notify_url` / `return_url` / `client_ip` / `channel` / `timestamp` | 易支付通用名 |
| `amount_unit` | **必填**：`yuan` / `cent` | 无（必须显式声明） |
| `sign.algo` / `sign.key_append` / `sign.separator` / `sign.exclude` / `sign.upper` | 签名怎么算 | `md5` / `key=xxx` / `&key=` / `["sign","sign_type"]` / `false` |
| `timestamp_format` | `s` / `ms` / `ymdhms` | `s` |
| `constants` | 固定参数（如 `pid`、`type`） | `{}` |
| `channel_codes` | 方式 → 厂商渠道码，如 `{alipay:"alipay",wechat:"wxpay"}` | 同名 |
| `response.ok.path` / `.equals` | 怎么判断下单成功 | 见模板 |
| `response.pay_url` / `.provider_order_no` | 从响应里取哪两个值 | 见模板 |
| `notify.order_no` / `notify.amount` / `notify.reply` | 回调取单号、金额、应答原文 | 见模板 |
| `query.path` / `query.fields` / `query.paid_when.path` / `.equals` | 怎么查单、怎么判已付 | 见模板 |

**AI 只做草稿**：生成后必须由"测试支付"实测通过才能 `live`。生成时永远不会带上密钥
（密钥在 `secret_enc`，不进 prompt）。

## 7. 安全

- 密钥存 `secret_enc`（AES-GCM，主密钥在 Worker secret `PAYMENT_SECRET_KEY`）；
  明文密钥**不入库、不进日志、不进任何 API 响应**。
- 回调必须验签；验签失败一律拒绝并记审计，**绝不发货**。
- 金额三处核对：下单时 / 回调时 / 查单时，与 `orders.amount_minor` 比对。
- 不存任何卡信息；PayPal / Stripe 走各自的托管收银台。

## 8. 未实现（按顺序）

1. 驱动：`epay_v1` + `sign.ts`（带四家的签名测试向量）
2. `generic_json_v1` 解释器 + 后台网关表单
3. 测试支付流程（`draft → live` 闸门）
4. 回调路由 + `queryCharge` + cron 兜底扫 `pending`
5. AI 生成映射草稿
6. 退款走网关（`refunds.channel_refund_id`）
