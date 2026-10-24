/**
 * 内置映射：`epay_v1` —— 易支付（彩虹易支付及其变种）
 *
 * 参考实现：SSPanel-UIM `src/Services/Gateway/Epay.php` + `Epay/EpayTool.php`
 * （2026-10 在测试机上逐行核对），这是国内机场/发卡面板用得最多的一套协议。
 *
 * ## 为什么 `epay_v1` 是一份常量而不是一段 driver
 *
 * 它只是「mapping 解释器 + 这套默认值」。好处：
 *   1. 只有**一条**代码路径要测试（解释器），不是两套并行实现；
 *   2. 租户选 `epay_v1` 只填 endpoint / pid / key 就能跑，不用碰 JSON；
 *   3. 遇到变种（路径不同、渠道码不同、要 `&key=` 拼接）时，**改配置即可**，
 *      不用等我们发版 —— 面板上那个「高级：覆盖映射」入口就是干这个的。
 *
 * ## 两个容易踩的点（都核对过源码）
 *
 * 1. **密钥是直接拼在明文末尾的，没有 `&key=`**：`md5(parsedParams + key)`。
 *    网上很多文档写成 `&key=`，那是别的协议族（如华俊）。
 * 2. **`sign_type` 不参与签名**，但要随请求发出去（值为 `MD5`）。
 */

import type { GatewayMapping } from "../mapping";

export const EPAY_V1_MAPPING: GatewayMapping = {
  create: { method: "POST", path: "/mapi.php", format: "form" },
  fields: {
    merchant: "pid",
    order_no: "out_trade_no",
    amount: "money",
    subject: "name",
    notify_url: "notify_url",
    return_url: "return_url",
    client_ip: "clientip",
    channel: "type",
  },
  /** 易支付按「元」收，`money=12.34` */
  amount_unit: "yuan",
  constants: { sign_type: "MD5" },
  /** 渠道码：支付宝 `alipay`、微信 `wxpay`（部分站点是 `wechat`，改这里即可） */
  channel_codes: { alipay: "alipay", wechat: "wxpay" },
  sign: {
    algo: "md5",
    // 直接拼密钥，无分隔符 —— 与 SSPanel `EpayTool::sign()` 一致
    key_append: "",
    exclude: ["sign", "sign_type"],
  },
  response: {
    ok: { path: "code", equals: 1 },
    message: "msg",
    // 文档里三种收银台形态三选一：跳转链接 / 二维码内容 / scheme
    pay_url_from: ["payurl", "pay_url", "qrcode", "urlscheme"],
    trade_no: "trade_no",
  },
  notify: {
    // 易支付的回调是 **GET 查询串**
    method: "GET",
    order_no: "out_trade_no",
    trade_no: "trade_no",
    amount: "money",
    // 它抄了支付宝的语义：`trade_status=TRADE_SUCCESS`
    paid_when: { path: "trade_status", in: ["TRADE_SUCCESS"] },
    reply: "success",
  },
  query: {
    method: "GET",
    path: "/api.php",
    // 查单接口把 pid/key 放在 query 里，本身不签名
    sign: "none",
    fields: { act: "order", pid: "{merchant}", key: "{secret}", out_trade_no: "{order_no}" },
    ok: { path: "code", equals: 1 },
    paid_when: { path: "status", equals: 1 },
    amount: "money",
    trade_no: "trade_no",
  },
};
