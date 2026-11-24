# 布拉格

来源：`clever-vpn-cf-api/docs/Api文档 - 布拉格.mhtml`（渲染后的 `doc_index`）。

## 三端点

- 创建：`POST /api/pay/unifiedorder`，JSON；金额 **分**；`reqTime` 13 位毫秒；
  响应 `code=0`、`data.payUrl`、`data.tradeNo`；
- 通知：POST JSON；`state=1` 已付；金额分；`sign` 验签；应答 `SUCCESS`/`OK`；
- 查询：`POST /api/pay/query`，JSON；`data.state=1` 已付；`2/3/4` 失败/未出码/异常；
- 签名：非空参数排序拼 `k=v&...`，末尾拼 `&key=商户密钥`，MD5；
- 响应验签：**有**。`sign` 在顶层，签名对象是 `data`；算法与请求相同。

## 映射

`PRAGUE_MAPPING`：`amount_unit:"cent"`、`timestamp_format:"ms"`、`key_append:"&key="`；
`response.sign = { field:"sign", data_path:"data" }`；查单终态 `2/3/4`。
