/**
 * 支付夹具：易支付 + 青蛙/亿宏/华俊 + XArrPay 原生 + 布拉格的协议形状
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
 *   - XArrPay 原生：`https://docs.xarr.cn/merchant/api/xarrpay.html`
 *   - 布拉格：`clever-vpn-cf-api/docs/Api文档 - 布拉格.mhtml`
 */

import type { GatewayMapping } from "../../src/payments/mapping";

/** 青蛙：JSON 下单 / JSON 回调 / `requestTime` 是北京时间 `YYYYMMDDHHmmss` */
type AnyV1 = Record<string, any>;

function toV2(m: AnyV1): GatewayMapping {
  const fm: Record<string, string> = m.fields ?? {};
  const roles = ["merchant", "order_no", "amount", "subject", "body", "notify_url", "return_url", "client_ip", "channel", "timestamp", "nonce"] as const;
  const createFields: GatewayMapping["create"]["request"]["fields"] = [];
  for (const role of roles) {
    const field = fm[role];
    if (!field) continue;
    if (role === "amount") {
      createFields.push({ field, role, value: "{amount}", unit: m.amount_unit });
    } else if (role === "timestamp") {
      createFields.push({
        field,
        role,
        value: "{timestamp}",
        format: m.timestamp_format ?? "s",
        ...(m.timestamp_format === "ymdhms" ? { timezone: "Asia/Shanghai" } : {}),
      });
    } else if (role === "nonce") {
      createFields.push({ field, role, value: "{nonce}", length: 32 });
    } else if (role === "channel") {
      createFields.push({ field, role, value: "{channel}" });
    } else {
      createFields.push({ field, role, value: `{${role}}` });
    }
  }
  for (const [field, value] of Object.entries(m.constants ?? {})) {
    createFields.push({ field, value: String(value) });
  }
  for (const name of m.numeric_fields ?? []) {
    const f = createFields.find((x) => x.field === name);
    if (f) f.numeric = true;
  }

  const responseFields: GatewayMapping["create"]["response"]["fields"] = [];
  if (m.response?.pay_url) responseFields.push({ field: m.response.pay_url, role: "pay_url" });
  for (const p of m.response?.pay_url_from ?? []) responseFields.push({ field: p, role: "pay_url" });
  if (m.response?.trade_no) responseFields.push({ field: m.response.trade_no, role: "trade_no" });
  if (m.response?.expires_at) responseFields.push({ field: m.response.expires_at, role: "expires_at", format: "s" });
  if (m.response?.message) responseFields.push({ field: m.response.message, role: "message" });

  const notifyFields: GatewayMapping["notify"]["request"]["fields"] = [
    { field: m.notify.order_no, role: "order_no" },
  ];
  if (m.notify.trade_no) notifyFields.push({ field: m.notify.trade_no, role: "trade_no" });
  if (m.notify.amount) {
    notifyFields.push({
      field: m.notify.amount,
      role: "amount",
      unit: m.notify_amount_unit ?? m.amount_unit,
    });
  }

  const q = m.query;
  const queryFields: NonNullable<GatewayMapping["query"]>["request"]["fields"] = [];
  for (const [field, value] of Object.entries(q?.fields ?? {})) {
    const f: AnyV1 = { field, value: String(value) };
    if (value === "{amount}") {
      f.role = "amount";
      f.unit = m.query_amount_unit ?? m.amount_unit;
    }
    if (value === "{timestamp}") {
      f.role = "timestamp";
      f.format = m.timestamp_format ?? "s";
      if (m.timestamp_format === "ymdhms") f.timezone = "Asia/Shanghai";
    }
    const numeric = (m.numeric_fields ?? []).includes(field);
    if (numeric) f.numeric = true;
    queryFields.push(f as never);
  }
  const queryResponseFields: NonNullable<GatewayMapping["query"]>["response"]["fields"] = [];
  if (q?.trade_no) queryResponseFields.push({ field: q.trade_no, role: "trade_no" });
  if (q?.amount) {
    queryResponseFields.push({
      field: q.amount,
      role: "amount",
      unit: m.query_amount_unit ?? m.amount_unit,
    });
  }
  if (q?.message) queryResponseFields.push({ field: q.message, role: "message" });

  return {
    create: {
      request: {
        method: m.create.method,
        path: m.create.path,
        format: m.create.format,
        fields: createFields,
        auth: m.auth,
        sign: m.sign,
      },
      response: {
        ok: m.response.ok,
        fields: responseFields,
        sign: m.response.sign,
      },
    },
    notify: {
      request: {
        method: m.notify.method,
        format: m.notify.format,
        fields: notifyFields,
        paid_when: m.notify.paid_when,
        sign: m.sign,
      },
      response: { reply: m.notify.reply },
    },
    query: q
      ? {
          request: {
            method: q.method,
            path: q.path,
            format: q.format,
            fields: queryFields,
            auth: m.auth,
            sign: q.sign === "none" ? { mode: "none" } : m.sign,
          },
          response: {
            ok: q.ok,
            paid_when: q.paid_when,
            terminal_when: q.terminal_when,
            fields: queryResponseFields,
            sign: m.response.sign,
          },
        }
      : undefined,
  };
}

const QWGUA_MAPPING_V1 = {
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
  numeric_fields: ["mchId"],
  sign: { algo: "md5", key_append: "", exclude: ["sign"] },
  response: {
    ok: { path: "code", equals: "200" },
    message: "msg",
    pay_url: "data.payUrl",
    trade_no: "data.sysOrderNo",
    // cf-api qwgua provider 同样用 data.sign 复核响应（同一 MD5 算法）
    sign: { field: "data.sign", data_path: "data" },
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
    path: "/pay/query",
    fields: {
      mchId: "{merchant}",
      mchOrderNo: "{order_no}",
      requestTime: "{timestamp}",
      version: "1.0",
    },
    ok: { path: "code", equals: "200" },
    paid_when: { path: "data.status", equals: "3" },
    terminal_when: { path: "data.status", in: ["2", "4", "5"] },
    amount: "data.amount",
  },
};

/**
 * 亿宏：**form 下单**、响应 `datas.url`、`format`/`attach` 不参与签名，
 * 且**回调 `status=1` 已付、查单 `status=3` 已付**（两套语义，必须分开配）。
 */
const YIHONG_MAPPING_V1 = {
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
  sign: {
    algo: "md5",
    key_append: "",
    // 文档明确 format / attach 不参与签名；回调字段集合没写清 ⇒ 两种集合都试
    exclude: ["sign", "format", "attach"],
  },
  response: {
    ok: { path: "code", equals: "200" },
    message: "error",
    pay_url: "datas.url",
    // 官方给的是 http 收银台，https 同样可用（cf-api 实测）
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
const HUAJUN_MAPPING_V1 = {
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

/**
 * XArrPay 原生协议：JSON 下单/查单、form 回调；三端点全部 MD5 签名；
 * 下单金额按元、回调金额按分（文档的金额方向差异）。
 *
 * 来源：https://docs.xarr.cn/merchant/api/xarrpay.html
 */
const XARRPAY_NATIVE_MAPPING_V1 = {
  create: { method: "POST", path: "/xpay/order/create", format: "json" },
  fields: {
    merchant: "pid",
    order_no: "out_trade_no",
    amount: "money",
    subject: "name",
    notify_url: "notify_url",
    return_url: "return_url",
    client_ip: "clientip",
    channel: "pay_type",
  },
  amount_unit: "yuan",
  numeric_fields: ["pid"],
  sign: { algo: "md5", key_append: "", exclude: ["sign"] },
  response: {
    ok: { path: "code", equals: 200 },
    message: "msg",
    pay_url: "data.uri",
    trade_no: "data.trade_no",
    expires_at: "data.expire_time",
  },
  notify: {
    method: "POST",
    format: "form",
    order_no: "out_trade_no",
    trade_no: "trade_no",
    amount: "amount",
    paid_when: { path: "status", equals: 2 },
    reply: "success",
  },
  notify_amount_unit: "cent",
  query: {
    method: "POST",
    format: "form",
    path: "/xpay/order/status",
    fields: { out_order_id: "{order_no}", pid: "{merchant}" },
    ok: { path: "code", equals: 200 },
    paid_when: { path: "data.status", equals: 2 },
    terminal_when: { path: "data.status", in: [3, 4, 5] },
  },
};

/**
 * 布拉格：JSON 下单/查单、JSON 回调；金额分、13 位时间戳；
 * 密钥用 `&key=` 拼接；响应 `sign` 对 `data` 验签。
 *
 * 来源：`clever-vpn-cf-api/docs/Api文档 - 布拉格.mhtml`
 */
const PRAGUE_MAPPING_V1 = {
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
  sign: { algo: "md5", key_append: "&key=", exclude: ["sign"] },
  response: {
    ok: { path: "code", equals: 0 },
    message: "message",
    pay_url: "data.payUrl",
    trade_no: "data.tradeNo",
    expires_at: "data.expiredTime",
    sign: { field: "sign", data_path: "data" },
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
    terminal_when: { path: "data.state", in: [2, 3, 4] },
    amount: "data.amount",
    trade_no: "data.tradeNo",
  },
};

/**
 * 虎皮椒（XunHuPay）：与易支付共用签名主干，但有四处"语义相同、字面相反"的差异。
 *
 * 关键点（都来自 `https://docs.xarr.cn/merchant/api/xunhupay.html`）：
 *   - 签名字段叫 `hash`，排除的也是 `hash`
 *   - 成功码是 `errcode = "0"`（易支付是 `code = 1`）
 *   - 回调已付是 `status = "OD"`（固定字面量）
 *   - **`type` 为空 = 支付宝**，`WAP` / `JSAPI` = 微信 ⇒ 渠道码可以是空串
 *   - **没有查单接口**（官方"开发中"）⇒ 不配置 `query`
 */
const HUPIJIAO_MAPPING_V1 = {
  create: { method: "POST", path: "/xpay/hupijiao/payment/do.html", format: "form" },
  fields: {
    merchant: "appid",
    order_no: "trade_order_id",
    amount: "total_fee",
    subject: "title",
    notify_url: "notify_url",
    return_url: "return_url",
    channel: "type",
    timestamp: "time",
    nonce: "nonce_str",
  },
  amount_unit: "yuan",
  timestamp_format: "s",
  constants: { version: "1.1" },
  // 支付宝 = 不传 type；微信 H5 = WAP（小程序是 JSAPI，租户按需改）
  sign: { field: "hash", algo: "md5", key_append: "", exclude: ["hash"] },
  response: {
    ok: { path: "errcode", equals: "0" },
    message: "errmsg",
    // PC 端要 url_qrcode 自己出二维码；移动端直接用 url
    pay_url_from: ["url", "url_qrcode"],
  },
  notify: {
    method: "POST",
    format: "form",
    order_no: "trade_order_id",
    trade_no: "transaction_id",
    amount: "total_fee",
    paid_when: { path: "status", in: ["OD"] },
    reply: "success",
  },
  // query 故意不写：官方查单接口"开发中"，只能靠回调
};

export const QWGUA_MAPPING: GatewayMapping = toV2(QWGUA_MAPPING_V1);
export const YIHONG_MAPPING: GatewayMapping = toV2(YIHONG_MAPPING_V1);
export const XARRPAY_NATIVE_MAPPING: GatewayMapping = toV2(XARRPAY_NATIVE_MAPPING_V1);
export const PRAGUE_MAPPING: GatewayMapping = toV2(PRAGUE_MAPPING_V1);
export const HUAJUN_MAPPING: GatewayMapping = toV2(HUAJUN_MAPPING_V1);
export const HUPIJIAO_MAPPING: GatewayMapping = toV2(HUPIJIAO_MAPPING_V1);
