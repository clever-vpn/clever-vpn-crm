/**
 * 支付夹具：三家真实网关 + 易支付的协议形状
 *
 * ⚠️ **只用于测试**，产品里不内置任何一家厂商的预设（租户自己接自己的服务商，
 * 用 `epay_v1` 或 `generic_json_v1`）。放在这里的目的只有一个：
 * **证明同一份映射解释器能表达三种完全不同的协议形状**。
 *
 * 来源：
 *   - 易支付：SSPanel-UIM `src/Services/Gateway/Epay*.php`（测试机实测核对）
 *   - 青蛙：`clever-vpn-cf-api/.../providers/qwgua.ts` + `payment_orders/handlers.ts`
 *   - 亿宏：`clever-vpn-cf-api/.../providers/yihong.ts` + `docs/亿宏数码API接口文档.html`
 *   - 华俊：`https://mch.fhtuajus.xyz/doc`（2026-10 抓取）
 */

import type { GatewayMapping } from "../../src/payments/mapping";

/** 青蛙：JSON 下单 / JSON 回调 / `requestTime` 是北京时间 `YYYYMMDDHHmmss` */
export const QWGUA_MAPPING: GatewayMapping = {
  create: { method: "POST", path: "/pay/create", format: "json" },
  fields: {
    merchant: "mchId",
    order_no: "mchOrderNo",
    amount: "amount",
    subject: "title",
    body: "body",
    notify_url: "notifyUrl",
    return_url: "returnUrl",
    client_ip: "ip",
    channel: "code",
    timestamp: "requestTime",
  },
  amount_unit: "yuan",
  timestamp_format: "ymdhms",
  constants: { version: "1.0", device: "app" },
  channel_codes: { alipay: "1888", wechat: "1999" },
  sign: { algo: "md5", key_append: "", exclude: ["sign"] },
  response: {
    ok: { path: "code", equals: "200" },
    message: "msg",
    pay_url: "data.payUrl",
    trade_no: "data.sysOrderNo",
  },
  notify: {
    method: "POST",
    format: "json",
    order_no: "mchOrderNo",
    trade_no: "sysOrderNo",
    amount: "amount",
    paid_when: { path: "status", in: ["3"] },
    reply: "success",
  },
  query: {
    method: "POST",
    format: "json",
    path: "/query",
    fields: { mchId: "{merchant}", mchOrderNo: "{order_no}", requestTime: "{timestamp}" },
    ok: { path: "code", equals: "200" },
    paid_when: { path: "data.status", equals: "3" },
    amount: "data.amount",
  },
};

/**
 * 亿宏：**form 下单**、响应 `datas.url`、`format`/`attach` 不参与签名，
 * 且**回调 `status=1` 已付、查单 `status=3` 已付**（两套语义，必须分开配）。
 */
export const YIHONG_MAPPING: GatewayMapping = {
  create: { method: "POST", path: "/api/open/store", format: "form" },
  fields: {
    merchant: "userId",
    order_no: "requestNo",
    amount: "amount",
    notify_url: "notifyurl",
    return_url: "callbackurl",
    channel: "type",
  },
  amount_unit: "yuan",
  constants: { format: "json" },
  channel_codes: { alipay: "180", wechat: "210" },
  sign: {
    algo: "md5",
    key_append: "",
    // 文档明确 format / attach 不参与签名；回调字段集合没写清 ⇒ 两种集合都试
    exclude: ["sign", "format", "attach"],
    exclude_variants: [["sign", "format"]],
  },
  response: {
    ok: { path: "code", equals: "200" },
    message: "error",
    pay_url: "datas.url",
    // 官方给的是 http 收银台，https 同样可用（cf-api 实测）
    pay_url_force_https: true,
  },
  notify: {
    method: "POST",
    format: "form",
    order_no: "requestNo",
    amount: "amount",
    paid_when: { path: "status", in: ["1"] },
    reply: "success",
  },
  query: {
    method: "POST",
    format: "form",
    path: "/api/open/query",
    fields: { userId: "{merchant}", requestNo: "{order_no}" },
    ok: { path: "code", equals: "200" },
    paid_when: { path: "datas.status", equals: "3" },
    amount: "datas.amount",
  },
};

/** 华俊：JSON 下单 / 金额单位**分** / 13 位毫秒 / 密钥 `&key=` 拼接 / 应答 SUCCESS */
export const HUAJUN_MAPPING: GatewayMapping = {
  create: { method: "POST", path: "/api/pay/unifiedorder", format: "json" },
  fields: {
    merchant: "mchId",
    order_no: "outTradeNo",
    amount: "amount",
    subject: "subject",
    body: "body",
    notify_url: "notifyUrl",
    return_url: "returnUrl",
    client_ip: "clientIp",
    channel: "wayCode",
    timestamp: "reqTime",
  },
  amount_unit: "cent",
  timestamp_format: "ms",
  channel_codes: { alipay: 901, wechat: 902 },
  sign: { algo: "md5", key_append: "&key=", exclude: ["sign"] },
  response: {
    ok: { path: "code", equals: 0 },
    message: "message",
    pay_url: "data.payUrl",
    trade_no: "data.tradeNo",
  },
  notify: {
    method: "POST",
    format: "json",
    order_no: "outTradeNo",
    trade_no: "tradeNo",
    amount: "amount",
    paid_when: { path: "state", equals: 1 },
    reply: "SUCCESS",
  },
  query: {
    method: "POST",
    format: "json",
    path: "/api/pay/query",
    fields: { mchId: "{merchant}", outTradeNo: "{order_no}", reqTime: "{timestamp}" },
    ok: { path: "code", equals: 0 },
    paid_when: { path: "data.state", equals: 1 },
    // 0 待支付 / 1 成功 / 2 失败 / 3 未出码 / 4 异常
    terminal_when: { path: "data.state", in: [2, 3, 4] },
    amount: "data.amount",
    trade_no: "data.tradeNo",
  },
};
