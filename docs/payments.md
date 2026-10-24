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

`methods` 可以是**单元素数组**：只支持一种支付方式的网关（如加密货币、单一通道）就配两条网关、各勾一个方式。
多渠道的网关（易支付/青蛙/亿宏/华俊/虎皮椒）则是一个凭据 + 一个渠道码参数，见 §5.1。


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

> 现状：`draft → live` 目前由后台「发布」按钮触发，**发布时只校验配置自洽**
> （驱动能力、映射能通过 `validateMapping`、易支付类必须有密钥、测试网关必须有白名单 + 环境开关）；
> “必须真收到一次钱才能发布”这道闸门还没做，见 §8 待做第 2 条。

### 4.0 在哪配：后台「支付」页

侧栏 `支付`（`web/src/pages/Gateways.tsx`）是**唯一能创建网关的地方**，接口是
`/api/admin/gateways*`（`src/admin/gateways.ts`）。列表列的是**网关**而不是支付方式：
名称、驱动、支持的方式、状态、优先级、有没有密钥、最近成功时间、`last_error`。

三条规则写在后端，不靠前端自觉：

1. `driver` 决定它**能卖哪些方式**（`DRIVER_METHODS`）—— 不允许“Stripe 卖支付宝”这种配置，
   否则显示名与真实能力会打架；
2. 密钥只接受明文 `secret` 字段，进来即加密入库，**任何响应都只回 `has_secret`**；
   `PATCH` 留空 = 不改，要清空用 `clear_secret`；
3. 没配 `PAYMENT_SECRET_KEY` 时**拒绝保存密钥**（`secret_key_missing`），不退化成存明文。

映射输入分两种口径：`epay_v1` 的 `mapping` 是**覆盖项**（与内置映射深合并，租户只写差异），
`generic_json_v1` 的 `mapping` 是**完整配置**（必须整体通过校验）。

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

### 5.1 三个**互相独立**的维度（不要用"协议族"含混过去）

比对多家时容易把不同层面的差异混成一团。真正要分的是这三条轴：

| 维度 | 有哪些取值 | 谁吸收这个差异 |
|---|---|---|
| **签名范式** | 排序拼接 + 摘要（易支付/青蛙/亿宏/华俊/虎皮椒）· RSA 双向（epayn）· HMAC 原始报文（Stripe）· 官方 API 验签（PayPal） | **决定要不要写 driver** |
| **协议形状** | 字段名、路径、请求体格式、成功码、回调判定 | **映射开关**（这些全归 `generic_json_v1`） |
| **渠道模型** | ① 一个凭据 + 渠道码参数 ② 一个凭据 = 一个渠道 | **数据配置**（网关行与 `methods`），不碰代码 |

#### 渠道模型的两种形状（**别按厂商名分，按"渠道放哪"分**）

| | 商户号 | 渠道怎么选 | 一个凭据卖几种 |
|---|---|---|---|
| 易支付 | `pid` | 参数 `type=alipay/wxpay` | 2 |
| 青蛙 | `mchId` | 参数 `code`（数字码 1888/1999） | 2 |
| 亿宏 | `userId` | 参数 `type`（数字码 180/210） | 2 |
| 华俊 | `mchId` | 参数 `wayCode`（数字码 901/902） | 2 |
| **虎皮椒** | `appid` | 参数 `type`：**空 = 支付宝**，`WAP` = 微信 H5，`JSAPI` = 微信小程序 | 2 |
| 加密货币类（CoinGate 等） | token | **没有渠道概念** | 1 |

两个容易搞错的点：

1. **"有渠道码"不是任何一家的特征 —— 五家全都有。** 差别只在编码方式：
   纯字符串（`alipay`/`wxpay`）、数字码（`1888`/`180`/`901`）、
   **三态且"支付宝 = 不传"**（虎皮椒）。
2. **"一个凭据一种渠道"是加密货币网关的特征**，不是虎皮椒的。
   （XArrPay 文档把 `appid` 称作"支付渠道 ID"，但同一份文档又说"支付宝不填 `type`" ——
   这两句只有在"一个 appid 可卖两种"时才自洽。原版虎皮椒确实是每渠道一个 appid。
   两种布局我们都要能表达：前者靠 `channel_codes`，后者靠"两条网关 + `methods` 单元素"。）

#### 由此新增的一个必需能力：**渠道码可以是空**

虎皮椒的支付宝 = "`type` 这个参数不出现"。所以 `channel_codes: {"alipay": "", "wechat": "WAP"}`
必须合法，且值为空时**整个参数不发**（不是发 `type=`）。否则签名会多算一个空字段、
或者对方把空串当成非法渠道。

#### 那虎皮椒到底算什么


它跟青蛙/亿宏/华俊**同样不是同族** —— 四家的字段集、成功码、回调判定**互不相同**。
它们唯一的共同点是**签名范式**相同（排序拼接 + 直接拼密钥 MD5）。所以：

- **"是不是同族"这个问法没用** —— 字段集从来没有两家一样；
- 该问的是：**签名能不能本地一次算完？**（能 → 映射，不能 → driver）
- 以及：**协议形状差异能不能用现有开关表达？**（不能 → 补开关，通常 1–3 个）

#### 虎皮椒 vs 易支付：逐字段差异

| | 易支付 V1 | 虎皮椒 |
|---|---|---|
| 签名字段 | `sign`（排除 `sign`,`sign_type`） | **`hash`**（排除 `hash`） |
| 商户号 | `pid` | `appid` |
| 金额 / 订单号 / 标题 | `money` / `out_trade_no` / `name` | `total_fee` / `trade_order_id` / `title` |
| **成功码** | `code == 1` | **`errcode == "0"`** |
| 收银台 | `payurl`（单一） | `url`（H5 跳转）+ `url_qrcode`（PC 扫码内容，自己出图） |
| 必填随机串 | 无 | **`nonce_str`**（防重放）+ 必填 `time` |
| 回调已付 | `trade_status=TRADE_SUCCESS` | **`status=OD`**（固定字面量） |
| 回调应答 | `success` | `success` / `成功` / `ok` 任一 |
| 查单 | `api.php?act=order` | **官方"开发中"，只能靠回调** |
| 响应验签 | 一般无 | 响应带 `hash`，可验 |

两个最危险的坑：

1. **状态码是另一套编码。** `code=1` 成功 vs `errcode=0` 成功 —— 数值相反、都是合法
   整数，写错时单测不报错，只有真收款才发现。所以判定**必须在映射里显式写死**。
2. **没有查单。** "回调只当触发器、以查单为真相"的兜底链路对它不可用 ⇒ 只能依赖回调
   重试，`live` 之前必须实测 `notify_url` 真的可达。


### 5.2 覆盖虎皮椒的 5 个开关（已实现）

| 开关 | 解决什么 |
|---|---|
| `sign.field` | 签名字段名不一定是 `sign`（虎皮椒：`hash`）；默认 `"sign"` |
| `fields.nonce` | `nonce_str` 每次请求重新生成 32 位 hex（防重放） |
| `channel_codes` 允许空串 | 渠道码为空时**整个参数不发**（虎皮椒：支付宝不传 `type`） |
| `query` 可选 | 没有查单接口时就不写；`hasQuery()` 为 false，cron 兜底跳过并告警 |
| `notify_amount_unit` / `query_amount_unit` | 金额单位可以**按方向不同**（下单按元、回调按分） |

这 5 个都是**可选字段 / 默认值不变**，所以已有四家的行为一个字都没改。
`test/payments/fixtures.ts` 里现在有五份夹具（含虎皮椒），跑的是同一份解释器。

> 易支付 V2（`epayn`）用 **RSA-SHA256 双向签名**，属于非对称签名，是另一档能力，
> 暂不支持（也不违反"签名本地一次算完"的判据，将来要支持时按 `sign.algo` 扩展即可）。

### 5.3 测试网关（`driver = "mock"`）

我们自带的一条网关：**不连任何真实渠道**，用来自测整条链路；租户在接真网关之
前也可以先拿它把业务跑一遍。

```
用户点「支付宝」 → 建订单 → pay_url = /pay/mock/<订单号>
                                    ↓
                演示页：渠道名 + 金额 + 示意码 + 「模拟支付成功」
                                    ↓ 点按钮
                服务端构造**带正确签名的回调 Request**
                                    ↓
                交给**真实的 notify 处理函数**（与真网关同一段代码）
                                    ↓
              订单 paid → 发权益 → App 看到已生效
```

关键实现选择：**不真发 HTTP 自调用**，而是在进程内构造 `Request` 喂给同一个回调
 handler。这样验签、金额核对、幂等、发权益走的都是**生产路径**，不依赖公网可达，
本地 `wrangler dev` 就能跑完整流程。

#### 两道闸门（缺一不可）

| 闸门 | 字段 / 开关 | 规则 |
|---|---|---|
| **① 环境总开关** | `env.ALLOW_MOCK_PAYMENTS` | 默认 `false`。为 false 时 mock 网关**不可创建/发布**，已存在的**不参与路由**。**租户业务正式上线时改回 false** —— 这就是"上线后关闭"的机制 |
| **② 客户白名单** | `payment_gateways.allowed_emails` | 只有名单内邮箱的客户能看到它提供的方式；**mock 网关白名单必须非空才能 `live`**（空名单 = 路由不可用，防御性兼双重） |

为什么两道都要：

- ① 防的是"忘了关"（上线后 mock 还存在，等于免费开通）；
- ② 防的是"上线前被真实用户白嫖"（闸门 ① 开着的时候，只有你指定的测试账号能用）。

#### 它不替代真实网关的测试支付

| | 验证什么 | 何时用 |
|---|---|---|
| mock 网关 | **我们自己的**链路：下单→页→回调→发货→App 生效 | 开发自测；租户上线前演练 |
| 真实网关的 ¥1 测试支付 | **对方**的凭据 / 签名 / 回调可达 | 每条真实网关 `draft → live` 前必做 |

#### 统计与对账

mock 订单的 `payment_method` **仍然是** `alipay` / `wechat`（否则测的就不是真实
路径），识别靠 `gateway_id → driver = 'mock'`：**收入统计与对账一律排除 mock**。

#### 演示页的自我约束

- 顶部横幅：**「演示模式 · 不会真实扣款」**；
- 二维码位置只放**不可扫的示意占位**，不放真实收款码；
- 按钮文案写「模拟支付成功」/「模拟支付失败」。



## 6. 驱动（driver）

| driver | 用什么 | 谁配 |
|---|---|---|
| `epay_v1` | 内置一份映射（`src/payments/builtin/epay.ts`） | 租户填 endpoint / pid / key |
| `generic_json_v1` | 映射解释器（`src/payments/mapping.ts`） | 租户填 `mapping`（可让 AI 生成草稿） |
| `stripe` / `paypal` | 独立薄 driver | 租户填密钥 |
| `manual` | 无协议，人工确认 | 租户填收款信息 |
| `mock` | **自带的测试网关**（见 §5.3） | 只需配白名单 + 打开环境开关 |

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
| `fields.*` | 参数名映射：`merchant` `order_no` `amount` `subject` `body` `notify_url` `return_url` `client_ip` `channel` `timestamp` `nonce` |
| `amount_unit` | **必填**：`yuan`（元，两位小数字符串）/ `cent`（整数分） |
| `notify_amount_unit` / `query_amount_unit` | 回调/查单的金额单位，缺省跟随 `amount_unit` |
| `timestamp_format` | `s` / `ms` / `ymdhms`（`YYYYMMDDHHmmss`，**北京时间**） |
| `constants` | 固定参数，如 `{"sign_type":"MD5"}` |
| `channel_codes` | 方式 → 渠道码：`{"alipay":"alipay","wechat":"wxpay"}`；**值为空串时不发该参数** |
| `sign.field` | 签名字段名，默认 `"sign"`（虎皮椒用 `"hash"`） |
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
| `query.method` / `path` / `format` | 查单请求形状（**整个 `query` 可以不写** = 没有查单接口） |
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

### 7.1 密钥怎么存

商户密钥存 `payment_gateways.secret_enc`，**不留明文**：

```
v1:<base64(iv(12B) || AES-GCM 密文+tag)>
```

- 主密钥来自 Worker secret **`PAYMENT_SECRET_KEY`**（任意长度口令，内部 SHA-256
  归一到 32 字节，不用记“必须 32 位”）；
- **没配主密钥就不允许用真实网关**：下单/回调会明确返回 `gateway_not_ready`，
  而不是退化存明文；
- 密文自带 `v1:` 版本前缀，将来换算法可以双读（`v2:` 新写、`v1:` 仍能解）；
- AES-GCM 是**认证加密**：密文改一个字节就解不开，换主密钥也解不开 —— 两种情况
  都是 `null`，绝不返回半截明文。

为什么必须加密：D1 的常规运维动作是 `wrangler d1 export`（备份/迁移/排障），
明文入库等于**每次备份都在泄露商户密钥**。

### 7.2 其它的线

- 回调必须验签；验签失败一律拒绝并记 `last_error`，**绝不发货**。
- 金额核对：回调金额必须等于 `orders.amount_minor`，不等则 400 + 告警；
  有查单接口的网关还要再查一次单，**验签通过但查单说未付 → 不认账**。
- 不存任何卡信息；PayPal / Stripe 走各自的托管收银台。

## 8. 进度

已完成：

1. `src/payments/sign.ts` —— 排序拼接签名（md5/sha256、`key_append`、排除集合与多集合验签）
2. `src/payments/mapping.ts` —— 映射解释器（含校验、取值、金额/时间戳换算、多字段择优）
3. `src/payments/builtin/epay.ts` —— 内置易支付映射
4. `test/payments/*` —— 五份协议的夹具（易支付/青蛙/亿宏/华俊/虎皮椒），同一份解释器全过（签名用 `node:crypto` 交叉验证）
5. 覆盖虎皮椒的 5 个开关：`sign.field` / `fields.nonce` / 空渠道码 / `query` 可选 / 分方向金额单位
6. **测试网关（mock）** 全链路：`GET /api/app/v1/payment-methods`、
   `POST /api/app/v1/orders`、`/pay/mock/:code` 演示页、`POST /api/pay/notify/:gatewayId`
   （所有网关共用的回调入口）、订单 `pending → active` + 订阅发放
7. 闸门集中在 `src/payments/gateways.ts`（status / methods / 白名单 / 环境开关）
8. **密钥加密**：`src/payments/secret.ts`（AES-GCM + `PAYMENT_SECRET_KEY`，`v1:` 前缀）
   —— 真实网关的 epay 路径已用加密密钥跑通（下单签名、回调验签、查单复核）
9. **后台「支付」页**：`src/admin/gateways.ts` + `web/src/pages/Gateways.tsx`
   （列表 / 新建草稿 / 编辑 / 发布 / 停用；密钥只写不读；映射可覆盖）

待做：

1. 真实网关的 ¥1 测试支付（`draft → live` 闸门：先真收到钱再允许发布）
2. cron 兜底扫 `pending`（`expires_at` 过期 + `hasQuery` 的网关才查单）
3. `stripe` / `paypal` 薄 driver
4. AI 生成映射草稿
5. 退款走网关（`refunds.channel_refund_id`）

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

