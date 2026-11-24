# 亿宏

来源：`clever-vpn-cf-api/docs/亿宏数码API接口文档.html`。

## 三端点

- 创建：`POST /api/open/store`，form；金额 **元**；响应 `code=200`、`datas.url`；
- 通知：POST form；回调 `status=1` 已付；应答 `success`；
- 查询：`POST /api/open/query`，form；查单 `datas.status=3` 已付；
- 签名：MD5，密钥直接拼接；`format` / `attach` 不参与签名；
- 响应验签：无。

## 映射

`YIHONG_MAPPING`（已有）。注意回调/查单是**两套状态码**：`status=1` vs `datas.status=3`。
