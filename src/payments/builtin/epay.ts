/** 内置映射：`epay_v1` —— 易支付（彩虹易支付及其变种），v2 三端点结构。 */
import type { GatewayMapping } from "../mapping";

export const EPAY_V1_MAPPING: GatewayMapping = {
  create: {
    request: {
      method: "POST",
      path: "/mapi.php",
      format: "form",
      fields: [
        { field: "pid", role: "merchant", value: "{merchant}" },
        { field: "out_trade_no", role: "order_no", value: "{order_no}" },
        { field: "money", role: "amount", value: "{amount}", unit: "yuan" },
        { field: "name", role: "subject", value: "{subject}" },
        { field: "notify_url", role: "notify_url", value: "{notify_url}" },
        { field: "return_url", role: "return_url", value: "{return_url}" },
        { field: "clientip", role: "client_ip", value: "{client_ip}" },
        { field: "type", role: "channel", value: "{channel}" },
        { field: "sign_type", value: "MD5" },
      ],
      sign: { algo: "md5", key_append: "", exclude: ["sign", "sign_type"] },
    },
    response: {
      ok: { path: "code", equals: 1 },
      fields: [
        { field: "payurl", role: "pay_url" },
        { field: "trade_no", role: "trade_no" },
        { field: "msg", role: "message" },
      ],
    },
  },
  notify: {
    request: {
      method: "GET",
      fields: [
        { field: "out_trade_no", role: "order_no" },
        { field: "trade_no", role: "trade_no" },
        { field: "money", role: "amount", unit: "yuan" },
      ],
      paid_when: { path: "trade_status", in: ["TRADE_SUCCESS"] },
      sign: { algo: "md5", key_append: "", exclude: ["sign", "sign_type"] },
    },
    response: { reply: "success" },
  },
  query: {
    request: {
      method: "GET",
      path: "/api.php",
      fields: [
        { field: "act", value: "order" },
        { field: "pid", value: "{merchant}" },
        { field: "key", value: "{secret}" },
        { field: "out_trade_no", value: "{order_no}" },
      ],
      sign: { mode: "none" },
    },
    response: {
      ok: { path: "code", equals: 1 },
      paid_when: { path: "status", equals: 1 },
      fields: [
        { field: "money", role: "amount", unit: "yuan" },
        { field: "trade_no", role: "trade_no" },
      ],
    },
  },
};
