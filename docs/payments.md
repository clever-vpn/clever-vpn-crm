# 支付（收款）

> 本文是 CRM **支付域的唯一出处**：词表、表结构、状态机、网关配置与驱动契约。
> 钱怎么算在 [`plans.md`](plans.md)，东西是什么在 [`domain.md`](domain.md)，
> 表清单在 [`schema.md`](schema.md)。

## 0. 一句话

（商店内购 Apple / Google 是**同一套查单框架的另外两个 driver**，见 [§10](#10-商店内购apple-app-store--google-play)。）

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

用户不小心付两次 → 两笔 `paid` → **两笔都发放**。

- 同一张订单收两次回调：幂等（订单已 `active` 就跳过），**不会重复发**；
- 两张不同订单：就是两次**续订**，到期日**累加**（`max(现在, 原到期日) + 期限` 算两次），
  **不是**并存两份订阅 —— 订阅只有一行（`domain.md` §1.2）；
- 方向是安全的：最坏是“多卖一份”，不是“少给一次”；
- 用户来投诉时，用现成的 `refunds.mode = refund_and_void` 退一笔并扣回权益；
- 所以**不需要** `duplicate` 状态、不需要“重复判定”逻辑、不需要人工队列。

前提：我们的权益**可累加、可回退**。将来若出现一次性不可逆商品，再单独议。

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

**主动查单**（`src/payments/poll.ts`，v20）：

- 一个 cron 时钟（`*/2`）里跑，取数条件 = `pending` + 创建超过 20 秒 + 到点该查。
- **按订单年龄退避**，不是死查：

  | 年龄 | 间隔 | 说明 |
  |---|---|---|
  | 0–10 min | 2 min | 用户正盯着页面，最可能刚付完 |
  | 10–30 min | 5 min | 还在收银台犹豫的人 |
  | 30–60 min | 10 min | 非典型付款，只有零星延迟回调 |
  | ≥ 60 min | **停** | 置 `expired`，不再主动问网关 |

  一单约 12 次查询（死查 2 分钟 = 30 次），省下的是**网关的 QPS**。
- **过期即停**：`expired` 之后只有两条路 —— ① 回调（`settlePaidOrder` 接受
  `pending|expired`，钱晚到照样记账）；② 后台「查一次」
  （`POST /api/admin/orders/{code}/poll`，客服手动，走同一段判据）。
- **用户请求不打网关**：`GET /orders/:code` 只读我们自己的库。否则 100 个人同时刷新
  就等于 100 次/5 秒的查单风暴。
- `orders.next_poll_at` / `poll_attempts` 落库：改曲线不影响存量单，后台也能看到
  "这单我们确认过几次"。

待做：

1. 真实网关的 ¥1 测试支付（`draft → live` 闸门：先真收到钱再允许发布）
2. `stripe` / `paypal` 薄 driver
3. AI 生成映射草稿
4. 退款走网关（`refunds.channel_refund_id`）

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


## 10. 商店内购（Apple App Store / Google Play）

> **状态：需求讨论中（2026-10-31），未实现。** 本节先定"要什么、边界在哪"，
> 具体 driver 与字段等结论落地后再写。

### 10.0 一句话

商店内购**不是第三种网关协议**，而是**同一条"查单定论"轨道的两个新 driver**：
没有 `create`，只有 `query` + `notify`（`poll.ts` 已经按这个形状预留了位置）。

但**有三件事是 Web 收单里根本不存在的**，它们才是真正的需求：

1. **谁先动手**：Web 是我们建单→用户付；IAP 是用户在商店里付完→来找我们认领。
2. **钱和我们的单怎么对上**：Apple 不会回传我们的单号，只有 `appAccountToken` 能对上。
3. **我们欠商店一个动作**：Google 一次性商品 3 天不 `acknowledge` 会**自动退款**。

### 10.1 两次收单，形状完全不同

| | Web 收银台（epay / stripe / paypal） | 商店内购（Apple / Google） |
|---|---|---|
| 谁收钱 | 网关/服务商，钱进我们的商户号 | **商店**，钱先进商店，月中结算给我们 |
| 有没有"下单" | 有（`create` → `pay_url`） | **没有**（支付在客户端由 StoreKit / Play Billing 发起） |
| 靠什么把回调对到订单 | 我们下发的 `provider_order_no`（原样回传） | **`appAccountToken`**（Apple）/ **`obfuscatedAccountId`**（Google） |
| 通知内容 | 通常已含单号 + 金额 | 只有 `transactionId` / `purchaseToken`（金额要再查） |
| 权威来源 | 查单接口 | **查商店 API**（通知只是线索） |
| 价格谁定 | 我们（`plans.price_minor`） | **商店**（App Store Connect / Play Console 的价目表） |
| 退款谁发起 | 我们 | **用户找商店**，我们只能收通知 |
| 订阅续期 | 我们（`renewal`） | **商店**，我们只是跟随 |

**为什么必须在 App 里用商店支付**：Apple / Google 都禁止在 App 内引导去站外付款
（anti-steering）。反过来，Web 上也**不能用** IAP。所以这不是"可选的支付方式"，
而是**渠道决定的**——这正是 `plans.sales_channels`（`web_checkout` / `apple_iap` /
`google_iap`）存在的理由。

### 10.2 关联键：让"钱"能对上"我们的单"

Apple 的通知里**没有我们的单号**（除非我们用 `appAccountToken` 主动塞进去）。
所以：

| | 关联键 | 怎么来 | 约束 |
|---|---|---|---|
| Apple | `appAccountToken` | **我们生成一个 UUID**，随购买一起传给 StoreKit | 必须是 UUID；**支付后不可改** |
| Google | `obfuscatedAccountId` | 同一个 UUID 传给 Billing | ≤ 64 字符，稳定不变 |

规则：

- 订单在**发起购买之前**就存在，并把这个 UUID 写在该订单上（`app_account_token`）——
  它是"这笔钱属于哪一单/哪个人"的唯一凭据。
- 认领时**两边都要校验**：商店回传的 token 必须等于订单上的；否则拒绝（防串单/伪造）。
- 同时反向也要能查：**`productId` → `plan_id`**。现在 `plans.store_product_id` 是
  JSON（`{apple, google}`），认领时按 `productId` 反查套餐，需要一条索引视图。

### 10.3 真理来源：**通知是线索，查询是结论**

这条与仓库现有原则完全一致（`poll.ts`：主动查单才是判据），只是"查的对象"变了：

| | 通知 | 查询（结论） |
|---|---|---|
| Apple | App Store Server Notifications **V2**（`signedPayload` = JWS，需验签 + 校验 `bundleId` / `environment`） | App Store Server API `GET /inApps/v1/transactions/{transactionId}`；订阅态用 `/inApps/v1/subscriptions/{originalTransactionId}` |
| Google | **RTDN**（Pub/Sub push，payload 只有 `purchaseToken` + 事件类型，需校验 OIDC token / 共享密钥） | Play Developer API `purchases.subscriptionsv2.get` / `purchases.products.get` |

查的时机有**三个**，缺一不可：

1. **App 回传时**（用户刚付完）—— 同步查一次，让他立刻能用，不等通知；
2. **通知到达时** —— 只当作"有变化了"的信号，仍以查询结果为准；
3. **cron 定期对账** —— 续订、漏通知、掉单。**这是"最终结果"的真正含义**：
   不只是一次收款，而是**每次续费都要能自己查回来**。

### 10.4 我们欠商店的动作（漏了会丢钱）

两个平台的义务**不一样**，这一点常被忽略：

| | 谁做 | 不做的后果 |
|---|---|---|
| Apple `Transaction.finish()` | **客户端**（服务端没有对应 API） | 同一笔交易会被反复投递 ⇒ 认领必须幂等 |
| Google `purchases.*.acknowledge` / `consume` | **服务端**（我们） | **3 天后自动退款**（用户白嫖） |

推论：

- Google 的 ack 必须放在**认领成功之后**（权益落库 → 再 ack），
  且失败要能重试；不能"记个日志就算了"。
- Apple 侧我们要做的是：**把"可以 finish 了"这个结论同步返回给 App**，
  让它在拿到权益后自己 finish。
- 两者都要求**认领接口幂等**（App 会重试、通知会重投）。

### 10.5 价格与币种以商店为准 —— 促销在 IAP 上基本失效

| 项 | Web | IAP |
|---|---|---|
| 金额来源 | 我们算（含促销） | **商店返回**（Google 是 `micros` + `currencyCode`） |
| `expected_payable_minor` 校验 | 有意义 | **不适用**（客户端决定不了价格） |
| 优惠券 / 礼包 | 生效 | **不生效**——价格是商店定的，我们改不了 |
| 想打折只能 | 我们配券 | 用**商店侧的** offer / promo code（配置在 App Store Connect / Play Console） |

这里有一个**必须现在决定的口径问题**：商店返回的是**用户所在地区的货币**
（美国用户付 USD），而本仓库是单币种 CNY（`currency` 只作快照）。

可选：

- (a) **允许异币种**：`orders` 增加"实收金额 + 实收币种"，记账/残值仍换算成 CNY；
- (b) **只用 CNY 定价区**：App Store / Play 只卖 CNY 区（海外用户按商店汇率折算），
  我们只记商店给的 CNY 金额，不做换算；
- (c) 只记"商店实收"，残值与升级**不参与**（IAP 订阅不能折残值升级）。

### 10.6 订阅生命周期归商店，我们只是跟随

`period` 套餐在 IAP 上是**商店托管订阅**：续订、升降级、暂停、退款都在商店发生。

| 事项 | 谁说了算 | 我们要做的 |
|---|---|---|
| 到期时间 | 商店的 `expiresDate` / `expiryTimeMillis` | 覆盖 `platform_subscriptions.expires_at` |
| 续订 | 商店自动扣款 | 收 `DID_RENEW` / `SUBSCRIPTION_RENEWED` → 回查 → 延长 |
| 退款 / 撤销 | 用户找商店 | 收 `REFUND` / `REVOKE` → **必须收回权益**（钱退了，与"礼包不收回"是两回事） |
| 暂停 / 欠费 | 商店 | 收 `DID_FAIL_TO_RENEW` / `ON_HOLD` → 先不动权益，按 `expiresDate` 自然过期 |

两个必须现在定的点：

1. **我们的月结怎么跟商店的计费周期对齐？**（不是"跑不跑"，是"边界听谁的"）

   月结做的事是**把额度写回 `period_quota_gb`**（外加按实际用量折算后的额外池），
   判据是"从 `period_settled_at` 起，锚点日已越过"。Web 的锚点来自**下单日**；
   IAP 若也取下单日，就会与商店的周期错位：

   | 场景 | 后果 |
   |---|---|
   | 年付 365 天 + 每月 100GB | 商店一年只续费一次。若"跟着商店不重置"，用户一年只有 100GB —— **比承诺少 1100GB** |
   | 扣款失败后重试，续期日从 15 号挪到 23 号 | 我们仍在 15 号满额重置 ⇒ 商店周期才过 8 天又给一次 ⇒ **超发** |
   | 升级 / 降级（商店给 proration + 新周期起点） | 商店周期起点变了，锚点没变 ⇒ 同样错位 |

   正确规则：**锚点与次数都由商店的周期决定，不由我们猜**
   - `period_settled_at` 初值 = 商店这一期的**起点**（Apple `recentSubscriptionStartDate` /
     Google `startTime`），不是付款时刻；
   - `period_anchor_day` = 该起点的日号；
   - 商店续期（`DID_RENEW` / `SUBSCRIPTION_RENEWED`）到达 ⇒ 把锚点与 `period_settled_at`
     一同对齐到新周期，并立刻重置一次；
   - 一期覆盖几个月就重置几次（年付 = 12 期），次数由周期长度决定。

   Web 与 IAP 因此复用**同一段 `settle()`**，差别只在"锚点从哪来 / 续期由谁驱动"。
2. **家庭共享**（Apple `inAppOwnershipType = FAMILY_SHARED`）认不认？倾向：**不认**（或单独标记），
   否则一份订阅能给多个人开权益。

另外要防一个真实风险：**沙盒收据是可伪造的**（任何人装个 StoreKit Test 就能造）。
所以生产环境必须**拒绝 `environment = Sandbox`**，除非在白名单里（沿用 `allowed_emails` 的思路）。

#### 商店发起的退款 → 映射到我们的 A / B

我们自己的两种退款（`domain.md` §6）：

| 模式 | 名称 | 订单 | 订阅 |
|---|---|---|---|
| **A** | `refund_and_void` | 作废（`voided_at`），可部分退也整单作废 | `hold='revoked'`，cf-api 回滚到**购买前快照** |
| **B** | `refund_only` | 继续有效（`refunded_minor` 累加） | **继续有效**，cf-api 不动 |

IAP 下**我们没有"选模式"的权力** —— 钱是用户找商店退的，我们只是收到通知。
所以要做的是"把商店的撤销语义翻译成 A 或 B"：

| 商店事件 | 含义 | 建议动作 |
|---|---|---|
| Apple `REFUND` / Google 单笔作废 | 退**某一次**交易（可能只是最近一期） | 该期权益作废（按 A 处理），订阅链上其它期不受影响 |
| Apple `REVOKE`（家庭共享被撤销）、Google `SUBSCRIPTION_REVOKED` | **整条订阅链**被撤销 | A：订阅 `revoked` + 回滚 |
| Google `voidedPurchases` | **没有推送**，必须主动拉"某段时间内的作废购买" | 纳入定时对账（又一次"以查询为准"） |
| 消耗型（流量包 / 加购包）退款 | 额度可能已经被用掉 | 只能"作废剩余"；或选 B（退钱但保留权益）—— 需拍板 |

两个陷阱：

- **模式 A 的"回滚到购买前快照"在订阅链上不成立**：那个快照是"上一期"，
  而 IAP 是连续链。要单独定义"**撤销某一期**"的语义（`expires_at` 减一期？还是只标记该期作废）。
- Apple 会对同一笔交易**重投退款通知** ⇒ 退款处理必须幂等（按 `transactionId` 去重）。

### 10.7 配置落在哪（尽量复用现成字段）

| 位置 | 现状 | 需要补的 |
|---|---|---|
| `payment_gateways.driver` | `epay_v1` / `generic_json_v1` / `stripe` / `paypal` / `manual` / `mock` | 新增 `apple_iap` / `google_iap`（都是"只有 query"的 driver） |
| 密钥 | `secret_enc`（AES-GCM） | Apple：`.p8` + `issuer id` + `key id` + `bundleId`；Google：service account JSON + `packageName` |
| `plans.store_product_id` | `{"apple": "...", "google": "..."}` | 已有，够用（再加类型校验） |
| `plans.sales_channels` | `web_checkout` | 增加 `apple_iap` / `google_iap` |
| 商品类型映射 | — | `period` → 自动续期订阅；`traffic` / `addon` → **一次性消耗品**（Apple Consumable / Google one-time） |
| `orders` | `provider_order_no`（回调定位） | 加 `app_account_token`；`source` 增加 `iap`；记录 `store` + `environment` |

### 10.8 App 侧契约（新增端点）

App 付完必须把凭证交给我们，并且**当场拿到结论**：

```
POST /api/app/v1/iap/verify
{ "store": "apple" | "google",
  "product_id": "...",
  "transaction_id": "...",   // Apple
  "purchase_token": "..." }  // Google
→ { ok, order_code, status_text, can_finish: true, expires_at }
```

要求：幂等（App 会重试）、必须校验 `bundleId` / `packageName` / `productId` 属于我们、
认领成功后再 ack（Google）、返回 `can_finish` 让客户端 finish（Apple）。

### 10.9 对账与报表

- 商店要抽成（30% / 15%），所以"实收"≠"到账"：`amount_minor` 记**用户支付的金额**，
  净额另算（先不做到 CRM 里，避免两套数打架）。
- `source = iap` 让"自助 / 赠送 / 后台补单 / 商店"四类在报表上分得开。
- 沙盒交易必须能从报表里剔除。

### 10.10 待定（等拍板）

| # | 问题 | 我的倾向 |
|---|---|---|
| 1 | 订单在**付款前**建（带 `appAccountToken`）还是**付款后**建？ | 付款前建：token 是唯一能对上单的东西，且客服排查/入口统计都要它 |
| 2 | 异币种怎么办（USD 用户） | 见 §10.5 (b)：只卖 CNY 区，记商店返回的 CNY 金额；不做汇率 |
| 3 | 优惠券在 IAP 上无效，要不要在定价页对 IAP 渠道隐藏券？ | 要，否则用户以为能用 |
| 4 | IAP 的月度重置边界 | **照旧要重置**，但锚点与次数跟商店周期走（见 §10.6） |
| 5 | 家庭共享认不认 | 不认（或单独标记后人工处理） |
| 6 | 商店发起的退款怎么映射到我们的**模式 A / B** | 见 §10.6 之后新增的「退款」一节：单期退款 vs 整链撤销要分开定 |
