# 泡泡 / 青蛙（QWGUA）

来源：`clever-vpn-cf-api/docs/泡泡支付 - 运营管理系统.mhtml`（MHTML 里的
`doc.html` part，标题「青蛙系统-四方API接口文档」）。

## 原生协议

- 网关基址：`https://pay.pp.qwgua.com/rest`（cf-api 的 `QWGUA_API_BASE`；CRM 的「网关地址」要带 `/rest`）；
- 创建：`POST /pay/create`，JSON；金额 **元**；`mchId` 按数字发送（cf-api 用 `Number`）；
  `requestTime` 北京时间 `YYYYMMDDHHmmss`；
- 通知：POST JSON；`status=3` 已付；应答 `success`；
- 查询：`POST /pay/query`，JSON；请求带 `version` / `requestTime`；`data.status`：
  `1` 待支付、`2` 出码失败、`3` 支付完成、`4` 支付失败、`5` 订单冲正；
- 签名：非空参数排序拼 `k=v&...`，末尾直接拼商户密钥，MD5；
- 响应：创建/查单有 `data.sign`；cf-api 的 qwgua provider 已用同一套
  `md5(排序非空 data + key)` 复核，因此映射配置 `response.sign = { field:"data.sign", data_path:"data" }`。

## 映射

`QWGUA_MAPPING`：

- 查单路径 `/pay/query`（不是 `/query`）；
- 查单参数含 `version` / `requestTime`；
- `query.terminal_when` 覆盖 `2/4/5`；
- `response.sign` 配置为 `data.sign` over `data`（与 cf-api 一致）；
- `numeric_fields: ["mchId"]`（创建/查单的 JSON 都按数字）。

## Epay V1 兼容

同一份文档还包含易支付 V1 兼容：`/mapi.php`、`/submit.php`、`/api.php`。
查单 `api.php` 用 `key` 鉴权，不是 MD5；这属于 **Epay V1 preset**，不进入通用映射。
