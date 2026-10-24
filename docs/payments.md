# 支付（收款）

> 本文是 CRM **支付域的唯一出处**：词表、表结构、状态机、网关配置与驱动契约。
> 钱怎么算在 [`plans.md`](plans.md)，东西是什么在 [`domain.md`](domain.md)，
> 表清单在 [`schema.md`](schema.md)。

## 0. 一句话

**用户只选"支付方式"；服务商是谁、走哪条网关、单号多少，全部是内部实现。**

## 1. 词表（只有 5 个词）

| 词 | 字段 | 含义 | 用户可见 |
|---|---|---|---|
| **支付方式** | `orders.payment_method` | 用户选择的那个按钮：`alipay` / `wechat` / `paypal` / `stripe` / `transfer` | ✅ **唯一可见** |
| **驱动** | `payment_gateways.driver` | 怎么和这家说话：`epay_v1` / `generic_json_v1` / `stripe` / `paypal` / `manual` | 间接（决定显示名） |
| **网关** | `payment_gateways` 一行 | 一条能收钱的配置（凭据 + 支持的方式 + 优先级 + 状态） | ❌ |
| **订单** | `orders` 一行 | **一次支付尝试**的全部证据 | 只见单号 |
| **售卖渠道** | `plans.sales_channels` | 在哪儿卖：`web_checkout` / `apple_iap` / `google_play` | ✅ 间接 |

两个刻意的取舍：

1. **没有"服务商"这个概念字段。** 租户配几条网关，就有几家服务商；能推导的东西不存第二份。
2. **没有"聚合商 vs 品牌"这个字段。** 它由 `driver` 决定（见下），少一个租户能填错的选项。

**不要再用"渠道 channel"指支付。** 这个词已经被"售卖渠道"占用，混用会让每张图都要解释一遍。

### 1.1 显示名规则（由 `driver` 推导，不单独存）

| `driver` | App 里看到 | 租户要做什么 |
|---|---|---|
| `epay_v1` | 「支付宝」「微信支付」—— **聚合商/易支付站点的名字永远不出现** | 填 endpoint / pid / key，勾方式 |
| `generic_json_v1` | 同上（由 `methods` 决定） | 填映射（贴文档 → AI 生成草稿） |
| `stripe` / `paypal` | 「Stripe」「PayPal」—— 品牌即方式，**不再细分卡种** | 填密钥 |
| `manual` | 「银行转账」+ 后台人工确认 | 填收款信息 |

> 所以一个租户可以同时接 3 家易支付站点做兜底，用户那边仍然只有「支付宝 / 微信」两个按钮。


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

## 5. 协议形状对照（为什么映射够用）

国内聚合支付的**主干完全一样**，差异只在几个开关上。下表是四份实测过的协议
（易支付取自 SSPanel 实现；另外三家只作 `test/payments/fixtures.ts` 的夹具，
**产品不内置任何一家**）：

| | 易支付（SSPanel） | 青蛙 | 亿宏 | 华俊 |
|---|---|---|---|---|
| 下单 | POST **form** `/mapi.php` | POST **JSON** `/pay/create` | POST **form** | POST **JSON** |
| 金额单位 | 元 | 元 | 元 | **分** |
| 时间戳 | 无 | `YYYYMMDDHHmmss`(UTC+8) | 无 | **13 位毫秒** |
| 密钥拼接 | `body + key` | `body + key` | `body + key` | **`body + "&key=" + key`** |
| 排除字段 | `sign`,`sign_type` | `sign` | `sign`,`format`,`attach` | `sign` |
| 下单成功 | `code=1` | `code=200` | `code=200` | `code=0` |
| 收银台 | `payurl` | `data.payUrl` | `datas.url`（http→https） | `data.payUrl` |
| 回调用法 | GET 查询串 | POST JSON | POST form | POST JSON |
| **已付判定** | `trade_status=TRADE_SUCCESS` | `status=3` | **回调 `status=1`／查单 `status=3`** | `state=1` |
| 应答原文 | `success` | `success` | 自有 | `SUCCESS`/`OK` |

结论：**一个解释器 + 十几个开关就能覆盖全部四家**（`test/payments/mapping.test.ts`
里四份夹具跑的是同一份代码）。这就是 `generic_json_v1` 的存在理由。

### 5.1 另一类协议族：虎皮椒（XunHuPay）

虎皮椒和易支付**不是同一个族** —— 签名算法一致（ASCII 升序 + 直接拼 AppSecret + MD5），
但**状态码、渠道模型、查单能力**都不同：

| | 易支付 V1 | 虎皮椒 |
|---|---|---|
| 签名字段 | `sign`（排除 `sign`,`sign_type`） | **`hash`**（排除 `hash`） |
| 商户号 | `pid` | `appid` |
| 金额 / 订单号 / 标题 | `money` / `out_trade_no` / `name` | `total_fee` / `trade_order_id` / `title` |
| **成功码** | `code == 1` | **`errcode == "0"`** |
| 收银台 | `payurl`（单一） | `url`（H5 跳转）+ `url_qrcode`（PC 扫码内容，自己出图） |
| **渠道** | 参数 `type=alipay/wxpay` | **没有渠道参数**：一个 `appid` 绑一个通道，换 appid 才换渠道 |
| 必填随机串 | 无 | **`nonce_str`**（防重放）+ 必填 `time` |
| 回调已付 | `trade_status=TRADE_SUCCESS` | **`status=OD`**（固定字面量） |
| 回调应答 | `success` | `success` / `成功` / `ok` 任一 |
| 查单 | `api.php?act=order` | **官方"开发中"，只能靠回调** |
| 响应验签 | 一般无 | 响应带 `hash`，可验 |

真正"本质"的三点：

1. **状态码是另一套编码。** `code=1` 成功 vs `errcode=0` 成功 —— 数值相反、都是合法
   整数，写错时单测不报错，只有真收款才发现。所以这类判定**必须在映射里显式写死**，
   不许有"默认值"。
2. **渠道是"账号"不是"参数"。** 虎皮椒没有 `type`，"一个网关同时支持支付宝+微信"这个
   假设不成立 ⇒ 每个渠道一条网关（`methods` 只能有一个值）。
3. **没有查单。** "回调只当触发器、以查单为真相"的兜底链路对它不可用 ⇒ 只能依赖回调
   重试，`live` 之前必须实测 `notify_url` 真的可达。

### 5.2 让映射覆盖虎皮椒还缺 4 个小开关（都不改变模型）

| 缺口 | 补法 |
|---|---|
| 签名字段名不一定是 `sign` | `sign.field`（默认 `"sign"`，可设 `"hash"`） |
| `nonce_str` 每次必须随机 | `fields.nonce` + 模板变量 `{nonce}` |
| 有些网关**没有查单接口** | `query` 改为可选；为空时禁用 cron 兜底，并在面板上明确提示"只能靠回调" |
| 金额单位可能**按方向不同** | 下单按元、回调按分（XArrPay 原生协议就是这样）⇒ `notify_amount_unit` / `query_amount_unit`，缺省跟随 `amount_unit` |

> 易支付 V2（`epayn`）用 **RSA-SHA256 双向签名**，属于非对称签名，是另一档能力，
> 暂不支持（也不违反"签名本地一次算完"的判据，将来要支持时按 `sign.algo` 扩展即可）。


## 6. 驱动（driver）

| driver | 用什么 | 谁配 |
|---|---|---|
| `epay_v1` | 内置一份映射（`src/payments/builtin/epay.ts`） | 租户填 endpoint / pid / key |
| `generic_json_v1` | 映射解释器（`src/payments/mapping.ts`） | 租户填 `mapping`（可让 AI 生成草稿） |
| `stripe` / `paypal` | 独立薄 driver | 租户填密钥 |
| `manual` | 无协议，人工确认 | 租户填收款信息 |

**`epay_v1` 就是 `generic_json_v1` + 一份常量**，不是第二套实现 —— 只有一条代码
路径要测。变种差异（路径、渠道码、`&key=` 拼接）通过面板上的「高级：覆盖映射」
改名，不用发版。

### 6.1 判据：什么时候写 driver，什么时候写映射

> **签名能在本地一次算完 → 映射；需要换 token、二次 capture、或回调官方 API 验签 → driver。**

按这条，Stripe / PayPal **不进映射**：

| | 卡在哪 |
|---|---|
| Stripe | 回调签名是 `HMAC-SHA256(secret, "{t}.{rawBody}")` + 5 分钟容差 —— 不是"排序拼接"；下单参数是嵌套方括号键 |
| PayPal | **两步 OAuth2**（先换 token）、必须**二次 capture**、回调要**调官方 API** 验签 |

硬塞进来需要给映射加 `auth.oauth2` / `body_shape` / `sign.hmac_raw` / `verify.remote` /
`capture_step` 五个概念 —— 那就不是"配置表"而是半个 DSL，租户看不懂、AI 生成不可靠。
两家薄 driver 各 ~100 行且几乎不改，更划算。

反向的例子也成立：**CoinGate** 那类（header 认证 + 扁平 JSON + 无本地签名 + 靠查单
定论）**不需要专门 driver**，就是 `generic_json_v1`。

### 6.2 映射规范（`generic_json_v1`）

存进 `payment_gateways.mapping`（JSON）。字段名全部小写下划线，未知键直接报错。

| 键 | 说明 |
|---|---|
| `create.method` / `create.path` / `create.format` | 下单请求：`POST`/`GET`、路径、`form`/`json` |
| `fields.*` | 参数名映射：`merchant` `order_no` `amount` `subject` `body` `notify_url` `return_url` `client_ip` `channel` `timestamp` |
| `amount_unit` | **必填**：`yuan`（元，两位小数字符串）/ `cent`（整数分） |
| `timestamp_format` | `s` / `ms` / `ymdhms`（`YYYYMMDDHHmmss`，**北京时间**） |
| `constants` | 固定参数，如 `{"sign_type":"MD5"}` |
| `channel_codes` | 方式 → 渠道码：`{"alipay":"alipay","wechat":"wxpay"}` |
| `sign.algo` | `md5` / `sha256` |
| `sign.key_append` | 密钥前的拼接串：`""`（直接拼）或 `"&key="` |
| `sign.exclude` | 不参与签名的字段，默认 `["sign"]` |
| `sign.exclude_variants` | **仅验签**用的替代排除集合（最多 3 组），用于"文档没写清回调带不带 `attach`" |
| `sign.upper` / `sign.encode` | 大写输出 / 对值做 URL 编码，默认 `false` |
| `auth.header` / `auth.value` | 认证头，值里 `{key}` 会替换成密钥（如 `{"header":"Authorization","value":"Token {key}"}`） |
| `response.ok` | 下单成功判定：`{path, equals}` 或 `{path, in:[…]}` |
| `response.pay_url` / `pay_url_from` | 收银台地址（单个字段 / 依次取第一个非空） |
| `response.pay_url_force_https` | 文档给 http 但实际必须 https 时置 `true` |
| `response.message` / `trade_no` / `expires_at` | 错误信息、服务商流水号、收银台过期时间（原文存） |
| `notify.method` / `notify.format` | 回调是 `GET` 还是 `POST`，body 是 `form` 还是 `json` |
| `notify.order_no` / `trade_no` / `amount` | 回调里这些值的字段名 |
| `notify.paid_when` | 回调"已付款"判定（**与查单分开配**，亿宏就是两套码） |
| `notify.reply` | 应答原文，**必须逐字一致**（写错会被无限重发） |
| `query.method` / `path` / `format` | 查单请求形状 |
| `query.fields` | 查单参数，值支持 `{merchant}` `{secret}` `{order_no}` `{amount}` `{channel}` `{timestamp}` |
| `query.sign` | `"same"`（与下单同套签名）/ `"none"`（易支付查单自带 key，不签名） |
| `query.ok` / `paid_when` | 查单成功 / 已付判定 |
| `query.terminal_when` | 明确终态（失败/过期/撤销）：命中即收尾，不再重试 |
| `query.amount` / `trade_no` / `message` | 查单返回的金额、流水号、错误信息 |

示例（虚构网关 `acme-pay`，演示最常见的组合）：

```jsonc
{
  "create": { "method": "POST", "path": "/pay/create", "format": "json" },
  "fields": {
    "merchant": "mchId", "order_no": "outTradeNo", "amount": "amount",
    "subject": "subject", "notify_url": "notifyUrl", "return_url": "returnUrl",
    "client_ip": "clientIp", "channel": "wayCode", "timestamp": "reqTime"
  },
  "amount_unit": "cent",
  "timestamp_format": "ms",
  "channel_codes": { "alipay": 901, "wechat": 902 },
  "sign": { "algo": "md5", "key_append": "&key=", "exclude": ["sign"] },
  "response": { "ok": { "path": "code", "equals": 0 },
                "message": "message",
                "pay_url": "data.payUrl",
                "trade_no": "data.tradeNo" },
  "notify": { "method": "POST", "format": "json",
              "order_no": "outTradeNo", "trade_no": "tradeNo", "amount": "amount",
              "paid_when": { "path": "state", "equals": 1 },
              "reply": "SUCCESS" },
  "query": { "method": "POST", "format": "json", "path": "/pay/query",
             "fields": { "mchId": "{merchant}", "outTradeNo": "{order_no}", "reqTime": "{timestamp}" },
             "ok": { "path": "code", "equals": 0 },
             "paid_when": { "path": "data.state", "equals": 1 },
             "terminal_when": { "path": "data.state", "in": [2, 3, 4] },
             "amount": "data.amount" }
}
```

### 6.3 映射的边界（有意不做）

只有两件事：**取值 + 比对 + 拼参数 + 算签名**。没有表达式、没有脚本、没有正则替换、
没有状态跳转。所有判定一律 `{path, equals|in}` 三件套 —— 这是"租户能看懂、AI 生成
可靠、测试可穷举"的前提。

一条已知取舍：**不校验下单/查单响应的签名**（有的网关只对 `data` 签名）。传输由 TLS
保证，且最终以**查单**为准；**回调签名仍然必须校验**，那是安全边界。

**AI 只做草稿**：生成后必须由"测试支付"实测通过才能 `live`。生成时永远不会带上密钥
（密钥在 `secret_enc`，不进 prompt）。


## 7. 安全

- 密钥存 `secret_enc`（AES-GCM，主密钥在 Worker secret `PAYMENT_SECRET_KEY`）；
  明文密钥**不入库、不进日志、不进任何 API 响应**。
- 回调必须验签；验签失败一律拒绝并记审计，**绝不发货**。
- 金额三处核对：下单时 / 回调时 / 查单时，与 `orders.amount_minor` 比对。
- 不存任何卡信息；PayPal / Stripe 走各自的托管收银台。

## 8. 进度

已完成：

1. `src/payments/sign.ts` —— 排序拼接签名（md5/sha256、`key_append`、排除集合与多集合验签）
2. `src/payments/mapping.ts` —— 映射解释器（含校验、取值、金额/时间戳换算、多字段择优）
3. `src/payments/builtin/epay.ts` —— 内置易支付映射
4. `test/payments/*` —— 四份协议的夹具，同一份解释器全过（签名用 `node:crypto` 交叉验证）

待做：

1. 网关配置的后台表单 + 「高级：覆盖映射」入口
2. 测试支付流程（`draft → live` 闸门）
3. 回调路由 + `queryCharge` + cron 兜底扫 `pending`
4. 密钥加密（`secret_enc`，AES-GCM + `PAYMENT_SECRET_KEY`）
5. `stripe` / `paypal` 薄 driver
6. AI 生成映射草稿
7. 退款走网关（`refunds.channel_refund_id`）
8. §5.2 的四个小开关（`sign.field` / `{nonce}` / `query` 可选 / 分方向金额单位）

## 9. 参考

核对字段、金额单位与状态码时，优先看这几处（都是可以直接对照的规范）：

- **XArrPay 商户 API 总览** —— 协议清单、统一签名算法、**金额单位的方向差异**、订单状态码：
  <https://docs.xarr.cn/merchant/api/>
- **易支付协议 V1** —— 与 SSPanel `Epay*` 实现一致，可作为 `epay_v1` 的对照：
  <https://docs.xarr.cn/merchant/api/epay.html>
- **虎皮椒协议** —— `hash` 签名、`errcode=0`、`status=OD`、无查单：
  <https://docs.xarr.cn/merchant/api/xunhupay.html>
- **易支付 V2（epayn）** —— RSA-SHA256 双向签名（暂不支持）：
  <https://docs.xarr.cn/merchant/api/epayn.html>
- **亿宏数码 API 文档** —— 本仓库 `clever-vpn-cf-api/docs/亿宏数码API接口文档.html`
  （回调 `status=1` / 查单 `status=3` 两套语义的出处）

> 注意：这类文档描述的是**聚合商自己的网关**，各家下游的 `submit.php` / `mapi.php`
> 仍可能有细微差异（路径、渠道码、`&key=` 拼接）。所以 `epay_v1` 必须允许"高级覆盖"，
> 且 `live` 之前必须真收一次钱。

