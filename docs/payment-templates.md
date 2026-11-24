# 支付接口模板 / 高级 JSON 规范（v2）

> 机器可读 schema：[`payment-templates.schema.json`](payment-templates.schema.json)
> 运行时语义权威：`src/payments/mapping.ts` 的 `validateMapping()`。
> 旧 v1 平铺 mapping 不再保留；未正式发布，直接切 v2。

## 1. 两个层次

- **高级 JSON**：后台「接口配置 → 高级 JSON」里的对象，也就是存进
  `payment_gateways.mapping` 的对象；
- **模板文件**：在高级 JSON 外面包一层元数据，用于分发/导入/AI 导出。

```json
{
  "schema_version": 2,
  "id": "qwgua",
  "name": "泡泡 / 青蛙",
  "description": "JSON、MD5、元、北京时间 ymdhms；响应 data.sign",
  "source": "official",
  "mapping": { ...高级 JSON... }
}
```

- `schema_version` **只在模板 envelope**；mapping 本身不带版本号；
- `mapping` 与高级 JSON 完全同构；
- 模板不包含 endpoint、merchant_id、secret、methods、channel_codes 等实例值。

## 2. mapping 根结构

根对象只有三个 API：

```json
{
  "create": { "request": {}, "response": {} },
  "notify": { "request": {}, "response": {} },
  "query":  { "request": {}, "response": {} }
}
```

- 不再有全局 `fields` / `amount_unit` / `sign` / `response` / `constants` /
  `auth` / `timestamp_format` / `numeric_fields`；
- 金额单位、时间格式、签名、响应验签都归属于各自的端点；
- 未知键在所有层级拒绝。

## 3. 字段描述符

每个请求/响应字段都是一个对象。**`field` 是唯一的字段名键**，不再有 `key`：

```ts
{
  field: string;       // 请求：body 字段名；响应：点号路径
  role?:               // 语义角色；常量可省略
    "merchant" | "order_no" | "amount" | "subject" | "body" |
    "notify_url" | "return_url" | "client_ip" | "channel" |
    "timestamp" | "nonce" | "pay_url" | "trade_no" |
    "expires_at" | "message";
  value?: string;      // 请求：占位符或字面量；响应不写
  unit?: "yuan" | "cent";          // amount：元/分
  format?: "s" | "ms" | "ymdhms";  // timestamp：秒/毫秒/北京时间
  timezone?: string;               // timestamp；`ymdhms` 固定 Asia/Shanghai
  length?: number;                 // nonce：十六进制长度，默认 32
  numeric?: boolean;               // JSON 请求里按数字发送
}
```

- 请求的 `field` 是厂商 body/form 的**实际字段名**；
- 响应的 `field` 是响应的**点号路径**，如 `data.amount`；
- `role` 告诉运行时这行是商户号、订单号、金额、时间、收银台地址等；
- 常量没有 `role`，只写 `field` + `value`；
- `amount` / `timestamp` / `nonce` / `channel` 的差异全部在属性里，不再有全局枚举。

## 4. create

```jsonc
"create": {
  "request": {
    "method": "POST",
    "path": "/pay/create",
    "format": "json",
    "fields": [
      { "field": "mchId", "role": "merchant", "value": "{merchant}", "numeric": true },
      { "field": "mchOrderNo", "role": "order_no", "value": "{order_no}" },
      { "field": "amount", "role": "amount", "value": "{amount}", "unit": "yuan" },
      { "field": "title", "role": "subject", "value": "{subject}" },
      { "field": "notifyUrl", "role": "notify_url", "value": "{notify_url}" },
      { "field": "returnUrl", "role": "return_url", "value": "{return_url}" },
      { "field": "ip", "role": "client_ip", "value": "{client_ip}" },
      { "field": "code", "role": "channel", "value": "{channel}" },
      { "field": "requestTime", "role": "timestamp", "value": "{timestamp}", "format": "ymdhms", "timezone": "Asia/Shanghai" },
      { "field": "nonce_str", "role": "nonce", "value": "{nonce}", "length": 32 },
      { "field": "version", "value": "1.0" }
    ],
    "auth": { "header": "Authorization", "value": "Token {key}" },
    "sign": { "algo": "md5", "key_append": "", "exclude": ["sign"] }
  },
  "response": {
    "ok": { "path": "code", "equals": "200" },
    "fields": [
      { "field": "data.payUrl", "role": "pay_url" },
      { "field": "data.tradeNo", "role": "trade_no" },
      { "field": "data.expireTime", "role": "expires_at", "format": "s" },
      { "field": "data.amount", "role": "amount", "unit": "yuan" },
      { "field": "msg", "role": "message" }
    ],
    "sign": { "field": "data.sign", "data_path": "data" }
  }
}
```

- `fields` 是请求 body 字段；`amount` 不再单列；
- 常量 `version` 折叠进 `fields`，没有 `role`，`value` 是字面量；
- `numeric: true` 表示 JSON 里按数字发送；
- 响应只列出我们需要的字段；
- 成功判定用 `response.ok`，不塞进 `fields`。

## 5. notify

```jsonc
"notify": {
  "request": {
    "method": "POST",
    "format": "json",
    "fields": [
      { "field": "mchOrderNo", "role": "order_no" },
      { "field": "sysOrderNo", "role": "trade_no" },
      { "field": "amount", "role": "amount", "unit": "yuan" }
    ],
    "paid_when": { "path": "status", "in": ["3"] },
    "sign": { "algo": "md5", "exclude": ["sign"] }
  },
  "response": { "reply": "success" }
}
```

- `notify.request.fields` 是回调里的字段；
- 回调金额单位写在 amount 字段属性；
- `notify.response.reply` 是我方应答原文，必须逐字一致；
- 回调不发送 constants/auth/时间戳，所以这些不放进 notify；
- 回调没有“响应验签”。

## 6. query

```jsonc
"query": {
  "request": {
    "method": "POST",
    "path": "/pay/query",
    "format": "json",
    "fields": [
      { "field": "mchId", "value": "{merchant}", "numeric": true },
      { "field": "out_trade_no", "value": "{order_no}" },
      { "field": "requestTime", "value": "{timestamp}", "role": "timestamp", "format": "ymdhms" }
    ],
    "sign": { "algo": "md5", "exclude": ["sign"] }
  },
  "response": {
    "ok": { "path": "code", "equals": "200" },
    "paid_when": { "path": "data.status", "equals": "3" },
    "terminal_when": { "path": "data.status", "in": ["2", "4", "5"] },
    "fields": [
      { "field": "data.tradeNo", "role": "trade_no" },
      { "field": "data.amount", "role": "amount", "unit": "yuan" },
      { "field": "msg", "role": "message" }
    ],
    "sign": { "field": "data.sign", "data_path": "data" }
  }
}
```

- `query.request.fields` 的 `value` 支持占位符；
- 查单请求也可以带 amount 字段（`role: "amount"` + `unit`）；
- 通用映射查单必须签名；易支付 V1 例外：

```json
"query": {
  "request": { "sign": { "mode": "none" } }
}
```

## 7. sign 的 field 默认值

**是，`sign.field` 不写时默认就是 `"sign"`。**

- `create.request.sign.field`：下单签名字段，默认 `"sign"`；
- `notify.request.sign.field`：回调签名字段，默认 `"sign"`；
- `query.request.sign.field`：查单签名字段，默认 `"sign"`；
- 签名字段自身永远不参与签名，即使 `exclude` 没写；
- `sign.exclude` 默认 `["sign"]`，但像 `sign_type` 这种也要显式排除；
- `sign.algo` 默认 `"md5"`；`key_append` 默认 `""`；`upper`/`encode` 默认 `false`；
- `response.sign.field` 是**响应里的路径**，不是默认 `"sign"`，必须显式写；
- `response.sign.spec.field` 是响应签名对象里的签名字段，省略时默认 `"sign"`；
- 如果 `response.sign.spec` 省略，沿用同端点 request 的 sign。

## 8. 判定条件

判定独立于 `fields`：

- `create.response.ok`：下单成功；
- `notify.request.paid_when`：回调已付；
- `query.response.ok`：查单网关层成功；不写 = 总是成功；
- `query.response.paid_when`：查单已付；
- `query.response.terminal_when`：失败/过期/撤销终态。

每个判定都是：

```json
{ "path": "data.status", "equals": "3" }
```

或：

```json
{ "path": "data.status", "in": ["2", "4", "5"] }
```

`equals` / `in` 只能二选一；值统一按字符串比较。

## 9. 其它规则

- `fields` 数组里的 `field` 在同一请求内必须唯一；响应里可以有多个 `role: "pay_url"`，按数组顺序取第一个非空；
- 请求占位符：`{merchant}` `{secret}` `{order_no}` `{amount}` `{subject}` `{body}` `{notify_url}` `{return_url}` `{client_ip}` `{channel}` `{timestamp}` `{nonce}`；
- `channel` 的值来自网关实例的通道号，不在 mapping 中存具体值；
- 实例值：endpoint、merchant_id、secret、methods、channel_codes、优先级、白名单不属于 mapping；
- `notify.response.reply` 必须逐字一致，写错会被无限重发；
- 严格 JSON，不接受注释/尾逗号；模板文件最大 64KB；
- 模板导入只预填接口配置，不自动保存/发布；账号字段拒绝。

## 10. 模板 envelope

- 单模板：`schema_version: 2` + `id` + `name` + `description` + `source` + `mapping`；
- 模板目录：`schema_version: 2` + `templates[]`；
- 包装：`schema_version: 2` + `template`；
- `id`：1–64 位小写字母/数字/连字符，文件内唯一；
- `name`：1–80 字；
- `source`：`official` / `community` / `ai` / `imported`；
- 导入时 `source` 统一标记为 `imported`；
- 官方模板：`web/src/templates/qwgua.json`、`xarrpay.json`。

## 11. 兼容性

- 未正式发布，直接切 v2；
- 不做 v1 运行时适配；
- 旧 mapping 需要一次性改写为 v2；
- 当前四个演示网关在实现完成后按 v2 重建；
- 模板/高级 JSON/schema/运行时/表单/测试同批更新。

## 12. 已同步

- `docs/payment-templates.schema.json`（JSON Schema 2020-12）；
- `src/payments/mapping.ts`（v2 运行时）；
- `web/src/mapping-form.ts` / `GatewayMappingEditor.tsx`（结构化表单映射到 v2）；
- `web/src/templates/{qwgua,xarrpay}.json`；
- `test/payments/template-schema.test.ts`、`test/web/mapping-form.test.ts`；
- 四个演示网关按 v2 重建。
