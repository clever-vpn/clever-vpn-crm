/**
 * 支付相关的"非 API"路由：
 *   POST /api/pay/notify/:gatewayId   网关回调（所有 driver 共用）
 *   GET  /pay/mock/:code              mock 演示页
 *   POST /pay/mock/:code/paid         模拟"第三方"回调
 *
 * 这些路径**不走 App 的 CORS / 会话**（回调来自服务商，演示页由浏览器直接打开）。
 */

import { GATEWAY_COLUMNS, mappingOf } from "./gateways";
import { handlePayNotify } from "./notify";
import { MOCK_DRIVER, esc, buildMockNotifyParams, mockNotifyRequest, mockSecret, renderMockPayPage } from "./mock";

import type { Env } from "../env";
import type { GatewayRow } from "./gateways";

const NOTIFY_RE = /^\/api\/pay\/notify\/(\d+)$/;
const PAGE_RE = /^\/pay\/mock\/([A-Za-z0-9]+)$/;
const PAID_RE = /^\/pay\/mock\/([A-Za-z0-9]+)\/paid$/;

interface OrderForPage {
  id: number;
  code: string;
  plan_snapshot: string;
  amount_minor: number;
  currency: string;
  payment_method: string;
  gateway_id: number | null;
  status: string;
  expires_at: string | null;
}

function html(body: string, status = 200): Response {
  return new Response(body, {
    status,
    headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" },
  });
}

function noticePage(title: string, message: string, status = 200): Response {
  return html(
    `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(title)}</title>
<style>body{margin:0;font:16px/1.7 -apple-system,"PingFang SC",sans-serif;background:#f5f6f7;
display:flex;justify-content:center}main{max-width:380px;margin:64px 16px;background:#fff;
border-radius:14px;padding:28px;text-align:center;box-shadow:0 2px 12px rgba(0,0,0,.06)}
h1{font-size:18px;margin:0 0 12px}p{color:#57606a}</style></head>
<body><main><h1>${esc(title)}</h1><p>${esc(message)}</p></main></body></html>`,
    status,
  );
}

async function loadOrder(env: Env, code: string): Promise<OrderForPage | null> {
  return env.DB.prepare(
    `SELECT id, code, plan_snapshot, amount_minor, currency, payment_method, gateway_id, status, expires_at
       FROM orders WHERE code = ?`,
  )
    .bind(code)
    .first<OrderForPage>();
}

async function loadMockGateway(env: Env, id: number): Promise<GatewayRow | null> {
  const row = await env.DB.prepare(
    `SELECT ${GATEWAY_COLUMNS} FROM payment_gateways WHERE id = ? AND driver = ?`,
  )
    .bind(id, MOCK_DRIVER)
    .first<GatewayRow>();
  return row ?? null;
}

export async function handlePayRoutes(request: Request, env: Env): Promise<Response | null> {
  const url = new URL(request.url);
  const path = url.pathname;

  const notify = NOTIFY_RE.exec(path);
  if (notify) {
    if (request.method !== "POST") return new Response("method not allowed", { status: 405 });
    return handlePayNotify(env, request, notify[1] ?? "");
  }

  const paid = PAID_RE.exec(path);
  if (paid) {
    if (request.method !== "POST") return new Response("method not allowed", { status: 405 });
    return simulatePaid(env, request, paid[1] ?? "");
  }

  const page = PAGE_RE.exec(path);
  if (page) {
    if (request.method !== "GET") return new Response("method not allowed", { status: 405 });
    return renderPage(env, page[1] ?? "", url.origin);
  }

  return null;
}

async function renderPage(env: Env, code: string, origin: string): Promise<Response> {
  const order = await loadOrder(env, code);
  if (!order || !order.gateway_id) return noticePage("订单不存在", "请回到 App 重新发起支付。", 404);

  const gateway = await loadMockGateway(env, order.gateway_id);
  if (!gateway) return noticePage("不是测试网关", "该订单不是由测试网关创建的。", 400);
  if (!mappingOf(gateway)) return noticePage("网关配置异常", "请联系管理员。", 500);

  if (order.status !== "pending") {
    return noticePage("这笔订单已经处理过了", `当前状态：${order.status}。可以回到 App 查看结果。`);
  }
  const expired = !!order.expires_at && order.expires_at <= new Date().toISOString();

  const plan = safePlanName(order.plan_snapshot);
  // `origin` 只是给页面拼表单地址用的；真正的回调地址由服务端自己算
  void origin;

  return html(
    renderMockPayPage({
      orderCode: order.code,
      method: order.payment_method,
      amountMinor: order.amount_minor,
      currency: order.currency,
      planName: plan,
      expired,
    }),
  );
}

function safePlanName(snapshot: string): string {
  try {
    const v = JSON.parse(snapshot) as { name?: unknown };
    return typeof v.name === "string" ? v.name : "";
  } catch {
    return "";
  }
}

/**
 * 「模拟支付成功」：**由服务端构造一个带正确签名的回调 Request**，
 * 喂给真实的 notify 处理函数 —— 不真发 HTTP 自调用。
 */
async function simulatePaid(env: Env, request: Request, code: string): Promise<Response> {
  const order = await loadOrder(env, code);
  if (!order || !order.gateway_id) return noticePage("订单不存在", "请回到 App 重新发起。", 404);

  const gateway = await loadMockGateway(env, order.gateway_id);
  if (!gateway) return noticePage("不是测试网关", "该订单不是由测试网关创建的。", 400);

  if (order.status !== "pending") {
    return noticePage("这笔订单已经处理过了", `当前状态：${order.status}。`);
  }
  if (order.expires_at && order.expires_at <= new Date().toISOString()) {
    return noticePage("订单已过期", "请回到 App 重新发起支付。", 400);
  }

  const secret = mockSecret(env);
  const params = buildMockNotifyParams(
    {
      merchantId: gateway.merchant_id ?? "",
      orderNo: order.code,
      amountMinor: order.amount_minor,
      currency: order.currency,
      now: new Date(),
    },
    secret,
  );

  // 回调地址由服务端自己拼（不用请求里的 Host，避免被伪造）
  const notifyUrl = `${new URL(request.url).origin}/api/pay/notify/${gateway.id}`;
  const res = await handlePayNotify(env, mockNotifyRequest(notifyUrl, params), String(gateway.id));

  if (res.status >= 400) {
    return noticePage("模拟回调失败", `网关处理器返回 ${res.status}：${await res.text()}`, 502);
  }
  return noticePage("已模拟支付成功", "可以回到 App 查看，订阅应已生效。");
}
