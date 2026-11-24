export const DRIVER_LABEL: Record<string, string> = {
  epay_v1: "易支付 V1",
  epay_v2: "易支付 V2",
  generic_json_v1: "自定义支付接口",
  mock: "测试网关",
  stripe: "Stripe",
  paypal: "PayPal",
  manual: "对公转账",
};

export const METHOD_LABEL: Record<string, string> = {
  alipay: "支付宝",
  wechat: "微信支付",
  stripe: "Stripe",
  paypal: "PayPal",
  transfer: "银行转账",
};

export const STATUS: Record<string, { color: string; text: string }> = {
  draft: { color: "default", text: "草稿" },
  live: { color: "green", text: "已启用" },
  disabled: { color: "red", text: "已停用" },
  deleted: { color: "red", text: "已删除" },
};
