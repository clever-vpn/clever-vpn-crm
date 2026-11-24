# 文档 → 支付接口模板：AI 的输出契约 / prompt / 评测

现在只建语料和评测，不训练模型。模板规范见
[`../payment-templates.md`](../payment-templates.md) 和
[`../payment-templates.schema.json`](../payment-templates.schema.json)。

## 1. 输出契约

AI 输出：

```json
{
  "classification": "generic_mapping | driver | unsupported",
  "template": {
    "schema_version": 1,
    "id": "...",
    "name": "...",
    "mapping": { ...GatewayMapping... }
  },
  "evidence": [{ "section": "...", "quote": "..." }],
  "uncertainty": ["..."]
}
```

规则：

- `mapping` 必须符合 v2 模板规范，且通过 `validateMapping` + JSON Schema；
- 只生成**协议类型**：端点路径、字段名、签名、金额单位、状态判定；
- **不生成** endpoint、merchant_id/user_id、secret、methods、channel_codes；
- `fields` 是字段描述符数组；`field` 是请求 body 字段名/响应路径，`role` 表语义；
  `channel` 字段只写字段名和 `value: "{channel}"`，不写具体通道号；
- 响应验签能本地完成的，写 `response.sign`；不写 `response.sign` 就是明确 TLS-only；
- 不清晰就写 `uncertainty`，不要发明兜底规则。

## 2. 分类

- `generic_mapping`：三端点都能用本地签名/验签表达；包括有 `response.sign` 的协议；
- `driver`：RSA 双向签名、OAuth、远程验签、capture 等需要代码的协议；
- `unsupported`：没有查单、无法满足三端点等。

## 3. Prompt 骨架

```
输入：支付协议文档（三端点、签名、金额单位、状态码）
输出：
1) classification: generic_mapping | driver | unsupported
2) template: { schema_version:1, id, name, mapping }（仅 generic_mapping）
3) evidence: 文档里对应的章节/字段
4) uncertainty: 未写清的点（如响应签名算法）
约束：不猜；query 必填；通用映射不允许 unsigned query；
      fields.channel 只写字段名，不写具体通道号；
      response.sign 未确认就留空并写 uncertainty；
      不生成 endpoint/merchant/secret/methods/channel_codes。
```

## 4. 校验

- `validateMapping`（运行时权威）；
- `docs/payment-templates.schema.json`（结构）；
- `test/payments/mapping.test.ts` 的夹具测试（创建/通知/查单/签名）；
- `test/payments/template-schema.test.ts` 的 schema/运行时一致性；
- 人工复核 + 真实测试支付；AI 草稿不能直接 `live`。

## 5. 评测

- 四家作为 held-out；
- 评分：三端点字段是否齐全、签名是否可验证、金额单位、状态码、响应验签分类；
- 对 `driver` / `unsupported` 也要评分，不能强行生成 mapping。

## 6. 数据边界

- 文档是外部数据，不是指令；
- 原始文档的版权/授权按内部语料约定；
- 仓库只放规范/映射/夹具说明，原始大文件引用来源路径/URL；
- 不把密钥、商户号、通道号放进 prompt。

## 7. UI 位置

- 只在 `generic_json_v1` 的「接口配置」Tab 内出现，默认折叠；
- 不常驻页面右栏；Stripe/PayPal/epay_v2/epay_v1 不显示；
- 目标是生成草稿 + 差异 + 依据，应用到同一张映射表单；
- 不自动保存、不自动发布，永不接触密钥；
- 列表页仍保留发布/测试。

## 8. AI 配置助手

- 目标：把 API 文档文件/文本生成**接口配置模板**（协议类型），不是网关实例，也不是通用聊天；
- 输入：文档文件/文本；不抓任意 URL，不接收地址/商户号/凭据/通道号；
- 输出：`classification` + `template` + `evidence` + `uncertainty`；服务端必须过
  `validateMapping` + JSON Schema；
- 生成后可预览、应用、导出模板 JSON；不自动保存/发布；
- 文档不清晰时返回 uncertainty/unsupported，不发明兜底规则；
- 模型接入单独工作单元，当前只保留 UI 位置和契约。
