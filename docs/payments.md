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
| `generic_json_v1` | 同上（由 `methods` 决定） | 用结构化表单填映射（见 §4.0；文档→草稿的 AI 助手见 §8） |
| `stripe` / `paypal` | 「Stripe」「PayPal」—— 品牌即方式，**不再细分卡种** | 填 Secret Key（PayPal 还要 Client ID） |
| `manual` | 「银行转账」+ 后台人工确认 | **不作为网关创建项**；线下到账走「客户 → 手工开通」 |

> 所以一个租户可以同时接 3 家易支付站点做兜底，用户那边仍然只有「支付宝 / 微信」两个按钮。

### 1.2 网页上必须**先**告诉用户能怎么付

定价页的每一档都带一行「支持 支付宝 / 微信支付」，来源是 `/plans` 里这一档的
`payment_methods`（按**这个访客**算，契约 §2.4.5），SDK 把它映射成 `methods`。
点完购买才发现只有一种方式，等于骗人 —— 这行不是装饰。

两句话必须分开（`checkout()` 的错误码）：

| 情形 | 错误码 | 文案 | 前端动作 |
|---|---|---|---|
| 未登录 | `unauthorized` | 请先登录后再购买 | 跳登录页，别拉 `/plans` |
| 登录了但这一档没有可用方式 | `no_payment_method` | 这一档暂时无法在网页上购买，请下载 App 或联系客服 | 提示，不跳转 |

把两者混成一句，会让人以为"网关没配"，而真实原因只是没登录。

**能付的方式多于一种时，必须让用户选。** 定价页点购买就地展开「选择支付方式」
（支付宝 / 微信支付），选中后调 `SiteCrm.checkout({ planId, method })`；不传
`method` 时 SDK 用第一种（兼容老模板）。`method` 不在这一档的可用集合里时抛
`payment_method_unavailable` —— **绝不悄悄换成第一种**，那等于用户点了微信却付了
支付宝。App 侧不受影响：App 自己出按钮，本来就带 `payment_method`。

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
draft ──创建+查单测试──▶ live ──停用──▶ disabled
  disabled ──创建+查单测试──▶ live
  draft / live / disabled ──删除──▶ deleted（软删；列表隐藏，订单/回调仍可查）
```

- **只有 `status = 'live'` 参与路由**，`draft` / `disabled` 在 App 里完全不存在；
- **`deleted` 是软删除**：管理列表隐藏、新下单不再路由，但网关行保留 ——
  `orders.gateway_id`、在途订单的查单、服务端迟到的 webhook、审计都还引用它；
- 删除后如换新网关，Stripe/PayPal 后台的 webhook 地址要同步删除或改到新网关；
- `live` 可以测试、停用、删除；**驱动在 `live` / `disabled` 后锁定**，其他集成字段仍可改；
  改驱动应新建网关；
- 新建 / 停用后的网关可以「复制」为新的草稿：复制完整配置和密钥，但**不继承测试状态**。

### 4.1 发布前测试门禁

发布前必须完成：

```text
create_ok：创建订单成功，厂商返回可打开的页面支付 URL
query_ok：用同一笔测试单调厂商查单，返回合法响应、订单对得上、状态 pending/paid
```

- 测试单：`source = 'test'`，`plan_id = '__gateway_test__'`，`customer_id = 0`；
- **不发权益、不产生订阅**；用户侧订单列表不可见；
- 测试金额按网关配置 `test_amount_minor`（网关币种最小单位）；默认 1.00；
- 测试必须走与正式下单相同的 `createCharge → 厂商` 代码路径；
- `test_create_ok_at` / `test_query_ok_at` / `tested_config_hash` 落库；
- **任何集成字段变更都会让测试 hash 失效**，必须重新测试；
- 测试通过后，发布按钮才可用；发布接口还会再校验一次状态与 hash。

**查单测试成功不要求已支付**：新测试单状态为 `pending` 是正常的。
终态（失败/关闭/撤销）、订单不存在、金额/币种不符、验签失败、网络失败都算失败。

### 4.2 回调验证开关

`payment_gateways.test_require_callback`：

- `0`（默认）：创建 + 查单通过即可发布；回调到账只记录 `test_callback_ok_at`；
- `1`：创建 + 查单通过后仍显示「等待回调」，必须真实支付回调到账、
  写入 `test_callback_ok_at` 后才允许发布；
- 开关本身也参与测试 hash；改开关后旧测试失效。

### 4.3 币种与汇率

- CRM 账本（`orders.amount_minor` / `currency`）保持 CNY；
- 网关配置 `currency`（实际扣款币种）与 `fx_rate`（1 网关币种 = X CNY）；
- 下单时按网关汇率换算成 `provider_amount_minor` / `provider_currency`，
  **同时冻结 `fx_rate`**；
- Stripe / PayPal / EpayV2 / 映射类网关都使用 provider 金额；
- 回调 / 查单的金额校验使用 `provider_amount_minor`，不是 CRM 金额；
- 汇率变更只影响新订单。

### 4.4 编辑与测试入口

侧栏 `支付` → `web/src/pages/GatewaysList.tsx` / `GatewayEditor.tsx` / `GatewayMappingEditor.tsx`，
接口 `/api/admin/gateways*`（`src/admin/gateways.ts`）。

- 编辑页：基本信息、接口配置（① 下单 / ② 回调 / ③ 查单）、测试状态、测试金额、币种、汇率；
- 测试入口在编辑页和列表都有；
- 接口配置按 API 文档组织成「请求 / 响应」；金额单位、时间格式、数字字段都是字段属性；
- 模板来源：官方模板 / 导入 / 导出 / AI；**租户只编辑结构化表单，不直接编辑原始 JSON**；
- 导出模板：名称 / ID / 文件名 / 说明，默认 `<id>.json`，不包含地址、商户号、密钥、通道号；
- AI 仅生成草稿；必须测试通过后才允许发布。

### 4.5 后台配置规则

侧栏 `支付`（`web/src/pages/GatewaysList.tsx` / `GatewayEditor.tsx`）是**唯一能创建网关的地方**，接口是
`/api/admin/gateways*`（`src/admin/gateways.ts`）。列表列的是**网关**而不是支付方式：
名称、驱动、支持的方式、状态、优先级、有没有密钥、最近成功时间、`last_error`。

三条规则写在后端，不靠前端自觉：

1. `driver` 决定它**能卖哪些方式**（`DRIVER_METHODS`）—— 不允许“Stripe 卖支付宝”这种配置，
   否则显示名与真实能力会打架；
2. 密钥只接受明文 `secret` 字段，进来即加密入库；编辑页的密码框会直接带出当前值
   （可显隐、就地修改），列表/详情只回 `has_secret`；
   后端保留显式查看端点 `GET /gateways/:id/secret`（审计、不缓存）；
   `PATCH` 留空 = 不改，要清空用 `clear_secret`；
3. 没配主密钥 `APP_SECRET` 时**拒绝保存密钥**（`secret_key_missing`），不退化成存明文。

映射输入分两种口径：`epay_v1` 的 `mapping` 是**覆盖项**（与内置映射深合并，租户只写差异），
`generic_json_v1` 的 `mapping` 是**完整配置**（必须整体通过校验）。

`generic_json_v1` 的映射在后台用**结构化编辑器**（`web/src/pages/GatewayMappingEditor.tsx`）填写：
三个 API 页签（① 下单 / ② 回调 / ③ 查单），每个页签按「请求 / 响应」组织；金额、时间、数字字段都是字段属性。
JSON 只作为**只读预览 / 模板导出**，租户不直接编辑；导入模板和 AI 也最终落到同一个 `validateMapping` —— 没有第二套格式。

编辑器里**默认/隐藏**的只是「值」：回调地址、订单号、金额、客户 IP、标题、时间戳
由 CRM 在请求时填（商户号取网关表单里那个「商户号」），租户只需要填对方**字段名**。金额单位、下单/回调的已付判定、应答原文
**不隐藏**：它们是协议事实，写错就是资损或无限重推。

新建表单只列**能自动下单**的 driver：`epay_v1` / `generic_json_v1` / `stripe` / `paypal` /
`mock`（环境开关打开时）。`manual`（对公转账）不在此列——它不是自动收银台，线下到账走
「客户 → 手工开通」。支付方式选择器只在 `epay_v1` / `generic_json_v1` / `mock` 时出现；
Stripe/PayPal 的方式就是品牌本身，由 driver 固定。

### 4.6 路由与降级

```
method = alipay
  → 取所有 status='live' 且 methods 含 alipay 的网关，按 priority 升序
  → 依次 createCharge，第一个成功即用
  → 全部失败：502 + 告警
```

降级对用户无感（还在支付页）。**唯一要求：每次尝试用新单号**，绝不复用旧单号给第二家。

## 5. 协议形状对照（为什么映射够用）

国内聚合支付的**主干完全一样**，差异只在几个开关上。下表是四份经典协议
（易支付取自 SSPanel 实现；另外三家只作 `test/payments/fixtures.ts` 的夹具，
**产品不内置任何一家**）。XArrPay 原生 / 布拉格 / 泡泡-native 的矩阵见
`docs/protocols/README.md`：

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
   两种布局我们都要能表达：前者靠实例的通道号，后者靠"两条网关 + `methods` 单元素"。）

#### 由此新增的一个必需能力：**渠道码可以是空**

虎皮椒的支付宝 = "`type` 这个参数不出现"。所以网关实例的通道号是 `{"alipay": "", "wechat": "WAP"}`
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
2. **没有查单的协议不能作为完整网关。** 通用映射要求三端点；虎皮椒这类没有查单的
   协议不再支持（`query` 必填）。易支付 V1 的 key-in-URL 查单只保留在 V1 preset 内部。


### 5.2 解释器的可选开关（虎皮椒只作低级测试）

| 开关 | 解决什么 |
|---|---|
| `sign.field` | 签名字段名不一定是 `sign`（虎皮椒：`hash`）；默认 `"sign"` |
| `fields.nonce` | `nonce_str` 每次请求重新生成 32 位 hex（防重放） |
| 实例通道号允许空串 | 通道号为空时**整个参数不发**（虎皮椒：支付宝不传 `type`） |
| `query` 必填 | 通用映射必须支持订单查询；没有查单的协议不能作为完整网关 |
| `notify_amount_unit` / `query_amount_unit` | 金额单位可以**按方向不同**（下单按元、回调按分） |

这些开关默认值不变；`test/payments/fixtures.ts` 里现在有六份完整夹具
（易支付/青蛙/亿宏/华俊/XArrPay 原生/布拉格），虎皮椒只保留低级测试。

> 易支付 V2（`epayn`）用 **RSA-SHA256 双向签名**，属于非对称签名，放在独立
> `epay_v2` driver（见 §6.6），不硬塞进映射解释器。

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
| `epay_v1` | 内置一份映射（`src/payments/builtin/epay.ts`）；MD5，查单 key-in-URL | 租户填 endpoint / pid / key |
| `epay_v2` | 独立薄 driver（`src/payments/drivers/epay-v2.ts`）；RSA-SHA256 双向签名 | 租户填 endpoint / pid / 密钥 JSON（商户私钥 + 平台公钥） |
| `generic_json_v1` | 映射解释器（`src/payments/mapping.ts`） | 租户填 `mapping`（可让 AI 生成草稿） |
| `stripe` / `paypal` | 独立薄 driver：create + query + webhook/回跳页（见 §6.4/§6.5） | 租户填 Secret Key + Webhook Secret；PayPal 还要 Client ID + Webhook ID |
| `manual` | 无协议，人工确认 | **不作为网关创建项**；走后台「手工开通」 |
| `mock` | **自带的测试网关**（见 §5.3） | 只需配白名单 + 打开环境开关 |

**`epay_v1` 就是 `generic_json_v1` + 一份常量**，不是第二套实现 —— 只有一条代码
路径要测。变种差异（路径、渠道码、`&key=` 拼接）通过面板上的「高级：覆盖映射」
改名，不用发版。

### 6.1 判据：什么时候写 driver，什么时候写映射

> **签名能在本地一次算完 → 映射；需要换 token、二次 capture、或回调官方 API 验签 → driver。**

按这条，Stripe / PayPal **不进映射**，而是各写一条薄 driver（已实现，见 §6.4）：

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

**完整规范见 [`payment-templates.md`](payment-templates.md)**，机器可读 JSON Schema 见
[`payment-templates.schema.json`](payment-templates.schema.json)。

- **接口配置 mapping** = 表单背后的结构化配置；**模板文件** = 元数据 envelope + `mapping`；
- 根只有 `create` / `notify` / `query`，每个分 `request` / `response`；
- `fields` 是字段描述符数组：`field` + `role` + `value` + 单位/格式/时区/长度/数字；
- 金额、时间、随机数、渠道等属性都在字段上，不再有全局 `amount_unit` / `timestamp_format`；
- 每个端点自己的 `sign`；易支付 V1 查单用 `{ "mode": "none" }`；
- `schema_version` 只在模板 envelope；
- 官方模板：`web/src/templates/qwgua.json`、`xarrpay.json`；
- 导入/AI 只预填接口配置，不自动保存/发布。

### 6.3 映射的边界（有意不做）

只有两件事：**取值 + 比对 + 拼参数 + 算签名**。没有表达式、没有脚本、没有正则替换、
没有状态跳转。所有判定一律 `{path, equals|in}` 三件套 —— 这是"租户能看懂、AI 生成
可靠、测试可穷举"的前提。

响应验签是可选能力：配了 `response.sign` 就必须验签成功，否则下单/查单失败；未配置
则明确是 TLS-only，不能写成“已验签”。回调签名仍然必须校验，那是安全边界。

**AI 只做草稿**：生成后必须完成创建 + 查单测试（必要时再完成回调验证）才能 `live`。生成时永远不会带上密钥
（密钥在 `secret_enc`，不进 prompt）。


### 6.3.1 基本信息 vs 接口配置

- **基本信息（网关实例）**：网关地址、商户号/用户 ID、凭据、支付方式、**通道号**、名称、优先级、白名单；
- 通道号 = 支付方式是否可用：填了才启用，为空 = 该方式不可用；不再额外加勾选；
- 易支付 V2 的 `type` 就是支付方式，没有独立通道号；需要独立通道时用自定义接口；
- **接口配置（协议类型）**：三个端点、字段名、签名、金额单位、判定条件、路径；不包含任何账户值；
- **模板**：只描述接口类型，格式见 [`payment-templates.md`](payment-templates.md)；可来自官方
  （qwgua/XArrPay）、文件/粘贴导入或 AI 生成；不包含 endpoint/merchant/secret/methods/channel_codes；
- 请求方式默认 POST，主表单不显示；少数 GET 在「公共参数与认证 → 请求方式（高级）」里改。

### 6.4 Stripe / PayPal 薄 driver（v1）

与 cf-api 的 `createOrder + checkOrder` 同构；区别是密钥**按网关存**，不是 Worker 环境变量。

| | Stripe | PayPal |
|---|---|---|
| API 凭据 | `secret_enc` = Secret Key | `merchant_id` = Client ID；`secret_enc` = Client Secret |
| Webhook 凭据 | `webhook_enc` = `whsec_...`（endpoint signing secret） | `webhook_enc` = `WH-...`（webhook id） |
| 下单 | `POST /v1/checkout/sessions`（`mode=payment`） | OAuth2 换 token → `POST /v2/checkout/orders`（`intent=CAPTURE`） |
| 收银台 | `session.url` | `approve` 链接 |
| 查单 | `GET /v1/checkout/sessions/{id}`；`payment_status=paid` 才认 | `GET /v2/checkout/orders/{id}`；`APPROVED` 时**主动 capture**，`COMPLETED` 才认 |
| 权威交易号 | session id | capture id |
| 环境 | key 决定 test/live（同一个 API 根） | `ENVIRONMENT=production` → live；否则 sandbox |

几个明确取舍：

- **接 webhook，但只当触发器。** 固定 URL 是 `/api/pay/notify/:gatewayId`；Stripe 在
  后台配 endpoint 后把 signing secret 填进 `webhook_enc`，PayPal 填 webhook id。验签
  （Stripe 本地 HMAC；PayPal 调官方 verify 接口）通过后，仍要 `pollOrderOnce` 查单，
  不拿事件里的金额/状态直接落账（见 §6.5）。
- 确认路径有三层：**webhook（服务端权威触发器）→ 回跳页/refresh（即时 UX）→ cron
  （兜底）**。通常秒级；cron 最多约 2 分钟。超过 60 分钟的迟到支付不在自动查单窗口内，
  但后台「查一次」或回跳页仍可确认。
- **金额**：Stripe 传最小单位，PayPal 传两位小数；本轮只覆盖两位小数币种（JPY 等零小数
  币种不做）。测试金额按网关 `test_amount_minor` 配置，默认 1.00（网关币种）；低于厂商最低限额时测试失败。
- **退款**：未做；仍走后台内部退款流程。

### 6.5 Webhook 与回跳页（即时确认）

**Webhook（服务端）**

- 固定地址：`https://<crm>/api/pay/notify/<gatewayId>`，每个网关一个，**在 Stripe/PayPal
  后台配置一次**（不是下单时传）。
- 管理端在编辑页/展开行显示这个地址（复制按钮）。新建时先保存草稿拿到 id，再去 provider
  后台建 webhook，把 signing secret / webhook id 填回网关。
- 发布 Stripe/PayPal 前必须有 `webhook_enc`，否则 `webhook_required`。
- Stripe：`Stripe-Signature: t=...,v1=...`，`HMAC-SHA256(whsec, "{t}.{rawBody}")`，
  5 分钟容差；PayPal：用 OAuth2 调 `POST /v1/notify/webhooks/verify-webhook-signature`。
- 验签通过后按 `client_reference_id` / session id / custom_id / related order id 定位订单，
  再 `pollOrderOnce`。找不到订单或未知事件返回 200（不重试），不写库。

**回跳页 / refresh（浏览器）**

- 客户端传 `return_url`（Site 的 `/_crm/return.html`、App 的 https 通用链接）时，
  provider 直接回客户端 URL，并附 `order=<code>` 与 `crm_pay_token=<签名>`；客户端页面调
  `POST /api/pay/return/<code>/refresh?t=...`，接口做一次受控查单后返回
  `{status, pay}`。
- 客户端传自定义 scheme（App 深链）或没传时，provider 回 CRM 兜底页
  `/pay/return/<code>?t=...`：服务端查单、展示结果；自定义 scheme 给「返回 App」按钮。
- token 是 `base64url(payload).base64url(HMAC-SHA256)`，key 材料
  `<APP_SECRET>|pay-return/v1`，claims 含订单号、最终地址、24h 过期。最终地址在 token
  里，页面不从 query 读目标，避免开放重定向。
- `orders.return_poll_at` 是 10 秒冷却，只给回跳页/refresh 用；cron 不读不写。
  **`GET /orders/:code` 仍然只读库**；回跳/refresh 是唯一带 token 的“用户触发查单”入口。

**Site / App**

- Site：`/_crm/return.html` 读 `order` + `crm_pay_token`，调 refresh 后显示“支付成功/
  确认中/未完成”；旧站点产物没有这段逻辑时，webhook/cron 仍会确认，重新发布后获得。
- App：https 回跳直接进 App 页面；自定义 scheme 由 CRM 兜底页展示结果并给按钮。
- 所有路径最终都走 `pollOrderOnce → queryOnce → settlePaidOrder`；不新增第二套判据。

### 6.6 易支付 V1 / V2

| | V1（`epay_v1`） | V2（`epay_v2`） |
|---|---|---|
| 签名 | MD5（排序参数 + key） | RSA-SHA256 双向：商户私钥签请求，平台公钥验响应/回调 |
| 查单 | `api.php` 用 key 鉴权，**URL 带 key** | `/api/pay/query`，请求/响应都签名 |
| 密钥 | 一个 AppSecret | 商户私钥 + 平台公钥（JSON） |
| 时间戳 | 无 | 必填 10 位秒级 `timestamp` |
| 网关地址 | `.../xpay/epay/`，路径 `/mapi.php` | `.../xpay/epayn/`，路径 `/api/pay/create` / `/api/pay/query` |

V2 的实现：

- 凭据 `secret_enc` 加密 JSON：`{merchant_private_key, platform_public_key}`；
- 创建 `POST {base}/api/pay/create`；查单 `POST {base}/api/pay/query`；
- 响应/回调用平台公钥验签；创建响应 `code=0`、`pay_info`、`trade_no`；
- 查单 `status=2` 已付、`money` 元；
- 通知 GET，`trade_status=TRADE_SUCCESS`；应答 `success`；
- 不接 webhook；确认仍走 `pollOrderOnce` 查单（回调只当触发器）。
- UI 驱动下拉「易支付 V1」/「易支付 V2」；V1 保留兼容，V2 推荐。
- 文档：https://docs.xarr.cn/merchant/api/epayn.html

## 7. 安全

### 7.1 密钥怎么存

商户 API 密钥存 `payment_gateways.secret_enc`，webhook signing secret / id 存
`payment_gateways.webhook_enc`，**都不留明文**：

```
v1:<base64(iv(12B) || AES-GCM 密文+tag)>
```

- 主密钥来自 Worker secret **`APP_SECRET`**（任意长度口令，内部按用途标签派生，见 `src/secrets.ts`
  归一到 32 字节，不用记“必须 32 位”）；
- **没配主密钥就不允许用真实网关**：下单/回调会明确返回 `gateway_not_ready`，
  而不是退化存明文；
- 密文自带 `v1:` 版本前缀，将来换算法可以双读（`v2:` 新写、`v1:` 仍能解）；
- AES-GCM 是**认证加密**：密文改一个字节就解不开，换主密钥也解不开 —— 两种情况
  都是 `null`，绝不返回半截明文。

为什么必须加密：D1 的常规运维动作是 `wrangler d1 export`（备份/迁移/排障），
明文入库等于**每次备份都在泄露商户密钥**。

Stripe/PayPal 也一样：Stripe 的 Secret Key、PayPal 的 Client Secret 都进 `secret_enc`；
PayPal 的 Client ID 是公钥性质，存 `merchant_id`，不是密钥。Stripe 的 webhook signing
secret / PayPal 的 webhook id 进 `webhook_enc`，后台只回 `has_webhook`，不回明文。

网关 API 密钥（`secret_enc`）的当前值在**编辑页的密码框**直接带出（可显隐、就地改），
保存即覆盖；列表/详情仍不自动带出。后端另有显式端点 `GET /api/admin/gateways/:id/secret`，
返回 `{ secret }`，`Cache-Control: no-store`，并写审计 `gateway_secret_revealed`。
查看后请自行确认，不要贴到日志/工单里。

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
4. `test/payments/*` —— 六份完整协议夹具（易支付/青蛙/亿宏/华俊/XArrPay 原生/布拉格），虎皮椒只作低级测试；同一份解释器全过（签名用 `node:crypto` 交叉验证）
5. 解释器开关：`sign.field` / `fields.nonce` / 空渠道码 / `query` **必填** / 分方向金额单位 / `response.sign`
6. **测试网关（mock）** 全链路：`GET /api/app/v1/payment-methods`、
   `POST /api/app/v1/orders`、`/pay/mock/:code` 演示页、`POST /api/pay/notify/:gatewayId`
   （所有网关共用的回调入口）、订单 `pending → active` + 订阅发放
7. 闸门集中在 `src/payments/gateways.ts`（status / methods / 白名单 / 环境开关）
8. **密钥加密**：`src/payments/secret.ts`（AES-GCM + 主密钥 `APP_SECRET`，`v1:` 前缀）
   —— 真实网关的 epay 路径已用加密密钥跑通（下单签名、回调验签、查单复核）
9. **后台「支付」页**：`src/admin/gateways.ts` + `web/src/pages/GatewaysList.tsx` / `GatewayEditor.tsx`
   （列表保留发布/停用/测试支付/删除；新建/编辑是独立路由
   `/payments/gateways/new`、`/payments/gateways/:id/edit`；标题/状态/取消/保存收进粘性页签栏；
   密钥编辑页直接带出当前值（密码框可显隐），列表/详情不回显；映射可覆盖）
10. **`generic_json_v1` 映射编辑器**：`web/src/mapping-form.ts` + `web/src/pages/GatewayMappingEditor.tsx`
    （路由页内「基本信息 / 接口配置」；一次保存；接口配置按
    「金额与时间 / 签名与验签 / 下单 / 回调 / 查单 / 公共参数与认证」六组；
    字段映射就近放在各端点内；缺项在字段内联、保存时校验；
    AI 配置助手只在接口配置 Tab 内，默认折叠，不常驻右栏；官方模板 qwgua/XArrPay，
    支持文件/粘贴导入（只含接口类型，不包含账户值））
11. **Stripe / PayPal 薄 driver**：`src/payments/drivers/{stripe,paypal}.ts` + 路由/下单/查单
    （create + query；PayPal capture；见 §6.4）
12. **Webhook + 回跳页**：`src/payments/webhook.ts`（验签→查单）、
    `src/payments/return.ts` + `return-token.ts`（客户端 refresh / CRM 兜底页；见 §6.5）
13. **AI 配置助手**：`src/payments/ai.ts`（prompt + AI binding→AI Gateway 调用 +
    envelope/`validateMapping` 校验）+ `src/admin/gateway-ai.ts`
    （`POST /api/admin/gateways/ai-draft`，会话 + 每小时 20 次限流）+ 映射编辑器内的
    「粘贴/导入文档 → 生成 → 预览 → 应用」面板（支持 .txt/.md/.json/.html/.mhtml，
    本地转文本；入口是二态按钮）。服务端还有 completeness gate（规则+evidence 回查）：
    `soft_gaps` 警告未证实项，`insufficient` 禁用应用。只产 v2 草稿，不落库、不保存、不发布；
    模型默认 `deepseek/deepseek-flash`（`CLOUDFLARE_AI_MODEL` 可覆盖），厂商 key 在网关 BYOK；每条请求带
    `metadata.tenant`（cf-api 计费键）与 `product=crm`。未配 AI binding /
    `CLOUDFLARE_GATEWAY_ID` 时 `ai_unavailable`。


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
- **用户请求不打网关**：`GET /orders/:code` 只读我们自己的库。唯一例外是带签名 token 的
  回跳页/refresh：它只触发一次 `pollOrderOnce`，并受 `return_poll_at` 10 秒冷却保护；
  `GET /orders/:code` 本身仍然不碰网关。
- `orders.next_poll_at` / `poll_attempts` 落库：改曲线不影响存量单，后台也能看到
  "这单我们确认过几次"。

待做：

1. 真实网关的测试支付（`draft → live` 闸门：创建 + 查单通过；开启回调验证时还需真实回调到账）
2. 退款走网关（`refunds.channel_refund_id`）
3. Webhook 的自动注册/轮换（目前仍需在 Stripe/PayPal 后台手工配置）

## 9. 参考

核对字段、金额单位与状态码时，优先看这几处（都是可以直接对照的规范）：

- **XArrPay 商户 API 总览** —— 协议清单、统一签名算法、**金额单位的方向差异**、订单状态码：
  <https://docs.xarr.cn/merchant/api/>
- **易支付协议 V1** —— 与 SSPanel `Epay*` 实现一致，可作为 `epay_v1` 的对照：
  <https://docs.xarr.cn/merchant/api/epay.html>
- **虎皮椒协议** —— `hash` 签名、`errcode=0`、`status=OD`、无查单：
  <https://docs.xarr.cn/merchant/api/xunhupay.html>
- **易支付 V2（epayn）** —— RSA-SHA256 双向签名（已支持 `epay_v2` driver）：
  <https://docs.xarr.cn/merchant/api/epayn.html>
- **亿宏数码 API 文档** —— 本仓库 `clever-vpn-cf-api/docs/亿宏数码API接口文档.html`
  （回调 `status=1` / 查单 `status=3` 两套语义的出处）

> 注意：这类文档描述的是**聚合商自己的网关**，各家下游的 `submit.php` / `mapi.php`
> 仍可能有细微差异（路径、渠道码、`&key=` 拼接）。所以 `epay_v1` 必须允许"高级覆盖"，
> 且 `live` 之前必须真收一次钱。

