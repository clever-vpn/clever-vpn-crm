# XArrPay 原生

来源：https://docs.xarr.cn/merchant/api/xarrpay.html

## 三端点

- 创建：`POST /xpay/order/create`，JSON/form；金额 **元**；`pid` 在 JSON 下单按数字；响应 `code=200`，收银台在 `data.uri` / `data.qrcode` / `data.scheme`；
- 通知：POST form；`status=2` 已付；`amount` **分**；应答 `success`；
- 查询：`POST /xpay/order/status`，form；`out_order_id` + `pid`；`data.status=2` 已付；
- 签名：MD5，三端点都带 `sign`，密钥直接拼接；
- 响应验签：无。

## 映射

`XARRPAY_NATIVE_MAPPING`：`amount_unit:"yuan"`、`notify_amount_unit:"cent"`、
`numeric_fields:["pid"]`（JSON 下单）；
查单 `out_order_id:"{order_no}"`，`sign` 由解释器计算；终态 `3/4/5`。
