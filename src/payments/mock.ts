/**
 * 测试网关（`driver = "mock"`，`docs/payments.md` §5.3）
 *
 * 它**不连任何真实渠道**：下单只是把订单跳到我们自己的演示页，点「模拟支付成功」
 * 时由服务端**构造一个带正确签名的回调 Request**，喂给真实的 notify 处理函数。
 *
 * 为什么这么做（而不是真发一次 HTTP 自调用）：
 *   - 走的是**生产同一段代码**（验签、金额核对、幂等、发权益），不是第二条测试路径；
 *   - 不依赖公网可达，本地 `wrangler dev` 就能跑完整链路；
 *   - Workers 自己 fetch 自己会占连接配额、还受路由/缓存影响，没必要。
 *
 * 隔离不在这里（在 `gateways.ts`）：mock 强制白名单；环境开关已移除。
 */

import { signParams, type SignSpec } from "./sign";

import { signingKeyOf } from "../secrets";

import type { Env } from "../env";
import type { GatewayMapping } from "./mapping";

export const MOCK_DRIVER = "mock";

/** 回调签名规则：与易支付同族（排序拼接 + 直接拼密钥 + MD5） */
export const MOCK_SIGN: SignSpec = { field: "sign", algo: "md5", key_append: "", exclude: ["sign"] };

/**
 * mock 也走同一份映射 —— 这样回调解析、金额单位、已付判定都复用解释器。
 * `create` 字段不会被用到（mock 不下单），保留是为了配置形状统一。
 */
export const MOCK_MAPPING: GatewayMapping = {
  create: {
    request: {
      method: "POST",
      path: "/pay/mock",
      format: "form",
      fields: [
        { field: "mch", role: "merchant", value: "{merchant}" },
        { field: "out_trade_no", role: "order_no", value: "{order_no}" },
        { field: "amount", role: "amount", value: "{amount}", unit: "cent" },
      ],
      sign: MOCK_SIGN,
    },
    response: {
      ok: { path: "code", equals: 0 },
      fields: [
        { field: "pay_url", role: "pay_url" },
        { field: "msg", role: "message" },
      ],
    },
  },
  notify: {
    request: {
      method: "POST",
      format: "form",
      fields: [
        { field: "out_trade_no", role: "order_no" },
        { field: "trade_no", role: "trade_no" },
        { field: "amount", role: "amount", unit: "cent" },
      ],
      paid_when: { path: "status", in: ["SUCCESS"] },
      sign: MOCK_SIGN,
    },
    response: { reply: "success" },
  },
};

/** mock 的签名密钥：派生自 APP_SECRET，未配置时用明显的开发值。 */
export function mockSecret(env: Env): string {
  const base = signingKeyOf(env);
  return base ? `${base}:mock` : "mock-dev-secret";
}

export interface MockNotifyInput {
  merchantId: string;
  orderNo: string;
  amountMinor: number;
  currency: string;
  now: Date;
  /** 模拟失败用 */
  status?: "SUCCESS" | "FAILED";
}

/** 构造"第三方发来的"回调参数（含签名） */
export function buildMockNotifyParams(input: MockNotifyInput, secret: string): Record<string, string> {
  const params: Record<string, string> = {
    mch: input.merchantId,
    out_trade_no: input.orderNo,
    amount: String(Math.round(input.amountMinor)),
    currency: input.currency,
    status: input.status ?? "SUCCESS",
    trade_no: `MOCK${input.now.getTime()}`,
    paid_at: input.now.toISOString(),
  };
  params.sign = signParams(params, secret, MOCK_SIGN);
  return params;
}

/** 把回调参数包成一个 form POST 的 `Request`（交给真实 notify handler） */
export function mockNotifyRequest(url: string, params: Record<string, string>): Request {
  return new Request(url, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(params).toString(),
  });
}

/** HTML 转义（演示页里会插入订单号/名称，凡用户可控值一律转义） */
export function esc(v: unknown): string {
  return String(v ?? "").replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c] ?? c,
  );
}

/** 不可扫的示意二维码：纯装饰，避免有人真去扫 */
function fakeQr(): string {
  const cells: string[] = [];
  for (let y = 0; y < 15; y++) {
    for (let x = 0; x < 15; x++) {
      // 伪随机但确定的图案（用坐标算，避免每次刷新都变）
      const on = ((x * 7 + y * 13 + ((x * y) % 5)) % 3) === 0;
      if (on) cells.push(`<i style="left:${x * 8}px;top:${y * 8}px"></i>`);
    }
  }
  return `<div class="qr">${cells.join("")}</div>`;
}

export interface MockPageInput {
  orderCode: string;
  method: string;
  amountMinor: number;
  currency: string;
  planName: string;
  expired?: boolean;
}

const METHOD_LABEL: Record<string, string> = { alipay: "支付宝", wechat: "微信支付" };

/**
 * 演示页。刻意做得很"不像真的"：
 * 顶部横幅写明不扣款、二维码是示意、按钮写"模拟支付"。
 */
export function renderMockPayPage(input: MockPageInput): string {
  const label = METHOD_LABEL[input.method] ?? input.method;
  const amount = (input.amountMinor / 100).toFixed(2);
  const code = encodeURIComponent(input.orderCode);
  // 三个按钮 = 支付链路的三个分支。租户改模板/改 App 时，最常写错的就是
  // "失败"和"取消"之后界面长什么样，没有真网关能配合他重放这些分支。
  //   paid   → 走真实回调（验签 + 发货）
  //   failed → 发一个**验签通过但非成功**的回调（真实网关的失败回调长这样）
  //   cancel → 什么都不发（用户直接关掉收银台，网关不会回调）
  const action = input.expired
    ? `<p class="done">该订单已过期，请回到 App 重新发起支付。</p>`
    : `<form method="post" action="/pay/mock/${code}/paid">
         <button class="pay" type="submit">模拟支付成功</button>
       </form>
       <div class="alt">
         <form method="post" action="/pay/mock/${code}/failed">
           <button class="ghost" type="submit">模拟支付失败</button>
         </form>
         <form method="post" action="/pay/mock/${code}/cancel">
           <button class="ghost" type="submit">模拟用户取消</button>
         </form>
       </div>`;

  return `<!doctype html>
<html lang="zh-CN"><head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>演示支付 · ${esc(label)}</title>
<style>
  :root { color-scheme: light; }
  body { margin:0; font:16px/1.6 -apple-system,BlinkMacSystemFont,"PingFang SC",sans-serif;
         background:#f5f6f7; color:#1f2328; display:flex; justify-content:center; }
  main { width:100%; max-width:420px; margin:24px 16px; background:#fff; border-radius:14px;
         padding:24px; box-shadow:0 2px 12px rgba(0,0,0,.06); }
  .banner { background:#fff4e5; border:1px solid #ffcf8a; color:#8a5300; border-radius:10px;
            padding:10px 12px; font-size:13px; margin-bottom:20px; }
  h1 { font-size:18px; margin:0 0 4px; }
  .amount { font-size:34px; font-weight:600; letter-spacing:-.5px; margin:12px 0 20px; }
  .qr { position:relative; width:120px; height:120px; margin:0 auto 8px; background:#eef0f2;
        border-radius:10px; opacity:.5; }
  .qr i { position:absolute; width:8px; height:8px; background:#9aa4ad; }
  .hint { text-align:center; color:#8b949e; font-size:12px; margin:0 0 20px; }
  .pay { width:100%; padding:14px; border:0; border-radius:10px; background:#1677ff; color:#fff;
         font-size:16px; font-weight:600; }
  .alt { display:flex; gap:10px; margin-top:10px; }
  .alt form { flex:1; }
  .ghost { width:100%; padding:11px; border:1px solid #d0d7de; border-radius:10px;
           background:#fff; color:#57606a; font-size:14px; font-weight:600; }
  .done { color:#8b949e; text-align:center; }
  .meta { margin-top:20px; border-top:1px solid #eee; padding-top:12px; font-size:12px; color:#8b949e; }
  code { font-family:ui-monospace,SFMono-Regular,Menlo,monospace; }
</style>
</head><body><main>
  <div class="banner">⚠️ 演示模式：这是 CRM 的测试网关，<b>不会真实扣款</b>。</div>
  <h1>${esc(label)}</h1>
  <div class="amount">${esc(input.currency)} ${amount}</div>
  ${fakeQr()}
  <p class="hint">示意二维码（不可扫）</p>
  ${action}
  <div class="meta">
    订单 <code>${esc(input.orderCode)}</code><br>
    套餐 ${esc(input.planName)}
  </div>
</main></body></html>`;
}
