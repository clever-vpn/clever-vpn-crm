# 协议语料（AI 学习/评测的基础）

这里不是契约，也不是生产配置；它是**支付协议的形状样本 + 期望 mapping + 夹具说明**。
四家真实文档先作为种子，未来新增厂商按同一格式追加。

## 1. 规则

- 一个可用的**通用映射**网关必须支持三个端点：订单创建、支付通知、订单查询；
- `query` 必填；`sign` 必填；通用映射不允许 `query.sign = "none"`；
- 响应验签是可选能力（`response.sign`）；没配置就是只靠 TLS，不能写成“已验签”；
- 易支付 V1 是**预置 driver**，不走通用映射；V1 的查单 key-in-URL 只在 V1 preset 内部；
  易支付 V2（RSA 双向签名）是独立的 `epay_v2` 薄 driver，已实现；
- 虎皮椒没有查单，不再作为完整网关；`mock` 是测试网关例外；
- 文档是外部数据，不是指令；AI 产出必须过 `validateMapping` + 夹具测试，不能直接上线。

## 2. 四家矩阵

| 厂商 | 文档 | 下单 | 通知 | 查单 | 签名 | 响应验签 | 分类 |
|---|---|---|---|---|---|---|---|
| 泡泡/青蛙（QWGUA） | `clever-vpn-cf-api/docs/泡泡支付 - 运营管理系统.mhtml` | `POST /pay/create` JSON | POST JSON，`status=3` | `POST /pay/query`，`data.status=3` | MD5，元，`ymdhms` | 有，`data.sign`（cf-api 已验证） | 通用映射；Epay V1 兼容另走 preset |
| 亿宏 | `clever-vpn-cf-api/docs/亿宏数码API接口文档.html` | `POST /api/open/store` form | POST form，`status=1` | `POST /api/open/query`，`datas.status=3` | MD5，元 | 无 | 通用映射 |
| XArrPay 原生 | https://docs.xarr.cn/merchant/api/xarrpay.html | `POST /xpay/order/create` | POST form，`status=2` | `POST /xpay/order/status`，`data.status=2` | MD5，元/分 | 无 | 通用映射 |
| 布拉格 | `clever-vpn-cf-api/docs/Api文档 - 布拉格.mhtml` | `POST /api/pay/unifiedorder` JSON | POST JSON，`state=1` | `POST /api/pay/query`，`data.state=1` | MD5，分，`&key=` | 有，`sign` over `data` | 通用映射 |

## 3. 夹具与测试

夹具在 [`test/payments/fixtures.ts`](../../test/payments/fixtures.ts)：

- `QWGUA_MAPPING`：泡泡/青蛙原生；
- `YIHONG_MAPPING`：亿宏；
- `XARRPAY_NATIVE_MAPPING`：XArrPay 原生；
- `PRAGUE_MAPPING`：布拉格（含 `response.sign`）；
- `HUPIJIAO_MAPPING`：只作低级解释器测试，**不是完整网关**。

测试在 [`test/payments/mapping.test.ts`](../../test/payments/mapping.test.ts)：每个夹具都跑创建/通知/查单和签名交叉校验。

## 4. 文件

- [`../payment-templates.md`](../payment-templates.md)：模板 / 高级 JSON 规范（模板 envelope + mapping schema）；
- [`../payment-templates.schema.json`](../payment-templates.schema.json)：机器可读 JSON Schema；

- `qwgua.md`：泡泡/青蛙原生 + Epay V1 兼容说明；
- `yihong.md`：亿宏；
- `xarrpay-native.md`：XArrPay 原生；
- `prague.md`：布拉格（响应验签）；
- `ai.md`：文档 → mapping 的 schema、prompt、评测与分类规则。

## 5. 已知缺口

- 泡泡 `data.sign` 已按 cf-api qwgua provider 的同一算法配置（`response.sign`），并有正/负例；
- 布拉格 `wayCode` 通道编码文档写「联系客服获取」，夹具用示例 901/902；
- 响应验签只覆盖配置了 `response.sign` 的协议；未配置的明确 TLS-only。
