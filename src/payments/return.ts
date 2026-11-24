/**
 * 支付回跳页 + refresh 接口。
 *
 * 两种落地方式（由 `createCharge` 决定）：
 *   - 客户端给了 http(s) `return_url`：provider 直接回客户端 URL（带 `crm_pay_token`），
 *     客户端页面调 `POST /api/pay/return/:code/refresh?t=…`；
 *   - 没给 / 给的是 App 自定义 scheme：provider 回本文件的 CRM 兜底页
 *     `/pay/return/:code?t=…`，服务端查单后展示结果、给「返回 App」按钮。
 *
 * 两条路径都只做**触发器**：最终判据还是 `pollOrderOnce → queryOnce → settlePaidOrder`。
 */

import { esc } from "./mock";
import { pollOrderOnce } from "./poll";
import { normalizeReturnUrl, verifyReturnToken } from "./return-token";

import type { Env } from "../env";

/** 用户侧回跳查询冷却：刷新风暴不反复打网关 */
export const RETURN_POLL_COOLDOWN_SECONDS = 10;

export type ReturnPay = "paid" | "pending" | "failed" | "canceled";

export interface ReturnResult {
  orderCode: string;
  /** 订单原始状态（用于排障/展示） */
  orderStatus: string;
  pay: ReturnPay;
}

export interface ReturnOrderRow {
  code: string;
  status: string;
}

export type ReturnDeps = { fetch?: typeof fetch; now?: Date };

async function loadOrder(env: Env, code: string): Promise<ReturnOrderRow | null> {
  return env.DB.prepare(`SELECT code, status FROM orders WHERE code = ?`)
    .bind(code)
    .first<ReturnOrderRow>();
}

/**
 * 共用的查单逻辑：已付/终态直接返回；pending/expired 抢 10 秒冷却后 `pollOrderOnce`。
 * 兜底页和 refresh 接口都走这里，避免两套判定。
 */
export async function queryReturnOrder(
  env: Env,
  code: string,
  opts: { cancel?: boolean } & ReturnDeps = {},
): Promise<ReturnResult | null> {
  const order = await loadOrder(env, code);
  if (!order) return null;
  const now = opts.now ?? new Date();

  if (opts.cancel) return { orderCode: order.code, orderStatus: order.status, pay: "canceled" };

  if (order.status === "paid" || order.status === "provisioning" || order.status === "active") {
    return { orderCode: order.code, orderStatus: order.status, pay: "paid" };
  }
  if (order.status === "closed" || order.status === "refunded") {
    return { orderCode: order.code, orderStatus: order.status, pay: "failed" };
  }

  if (order.status === "pending" || order.status === "expired") {
    // 原子 claim：同一订单 10 秒内只有一个浏览器请求去打网关
    const claim = await env.DB.prepare(
      `UPDATE orders SET return_poll_at = ?
        WHERE code = ? AND status IN ('pending','expired')
          AND (return_poll_at IS NULL OR return_poll_at <= ?)`,
    )
      .bind(
        now.toISOString(),
        code,
        new Date(now.getTime() - RETURN_POLL_COOLDOWN_SECONDS * 1000).toISOString(),
      )
      .run();

    if ((claim.meta.changes ?? 0) > 0) {
      const out = await pollOrderOnce(env, code, { fetch: opts.fetch, now });
      const pay: ReturnPay =
        out?.verdict === "paid"
          ? "paid"
          : out?.verdict === "terminal"
            ? "failed"
            : "pending";
      return { orderCode: order.code, orderStatus: out?.status ?? order.status, pay };
    }
  }

  // 冷却中 / pending / expired（迟到支付仍可能）：不把话说死
  return { orderCode: order.code, orderStatus: order.status, pay: "pending" };
}

const PAY_COPY: Record<ReturnPay, { title: string; message: string }> = {
  paid: { title: "支付成功", message: "权益通常几秒内到账。" },
  pending: { title: "支付确认中", message: "如果已完成付款，权益通常几秒内到账。" },
  failed: { title: "支付未完成", message: "没有产生有效支付，可以返回重新购买。" },
  canceled: { title: "已取消支付", message: "没有产生扣款。" },
};

function withPay(url: string, pay: ReturnPay): string | null {
  try {
    const u = new URL(url);
    u.searchParams.set("pay", pay);
    return u.toString();
  } catch {
    return null;
  }
}

function isHttp(url: string | null): boolean {
  if (!url) return false;
  try {
    const p = new URL(url).protocol;
    return p === "http:" || p === "https:";
  } catch {
    return false;
  }
}

function page(title: string, message: string, code: string, finalUrl: string | null): Response {
  const httpUrl = isHttp(finalUrl) ? finalUrl : null;
  const meta = httpUrl ? `<meta http-equiv="refresh" content="1;url=${esc(httpUrl)}">` : "";
  const action = finalUrl
    ? `<a class="btn" href="${esc(finalUrl)}">${isHttp(finalUrl) ? "继续" : "返回 App"}</a>`
    : "";
  const body = `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">${meta}
<title>${esc(title)}</title>
<style>
:root{color-scheme:light}
body{margin:0;font:16px/1.7 -apple-system,BlinkMacSystemFont,"PingFang SC",system-ui,sans-serif;
color:#0d1626;background:#fff;display:grid;place-items:center;min-height:100vh}
main{max-width:420px;padding:28px 22px;text-align:center}
h1{font-size:20px;margin:0 0 10px}
p{color:#5c6b82;margin:0 0 8px}
code{background:#f6f8fc;border-radius:6px;padding:2px 6px;font-size:14px}
.btn{display:inline-block;margin-top:20px;padding:11px 20px;border-radius:10px;
background:#4f46e5;color:#fff;text-decoration:none;font-weight:600}
</style></head>
<body><main>
<h1>${esc(title)}</h1>
<p>${esc(message)}</p>
<p>单号 <code>${esc(code)}</code></p>
${action}
</main></body></html>`;
  return new Response(body, {
    status: 200,
    headers: {
      "Content-Type": "text/html; charset=utf-8",
      "Cache-Control": "no-store",
      "Referrer-Policy": "no-referrer",
    },
  });
}

/** `GET /pay/return/:code?t=…[&cancel=1]` */
export async function handleReturnPage(
  request: Request,
  env: Env,
  code: string,
  deps: ReturnDeps = {},
): Promise<Response> {
  const url = new URL(request.url);
  const token = url.searchParams.get("t") ?? "";
  const claims = await verifyReturnToken(env, token, code, deps.now);
  if (!claims) {
    return new Response("not found", {
      status: 404,
      headers: { "Cache-Control": "no-store", "Referrer-Policy": "no-referrer" },
    });
  }
  const cancel = url.searchParams.get("cancel") === "1";
  const result = await queryReturnOrder(env, code, { cancel, fetch: deps.fetch, now: deps.now });
  if (!result) return new Response("not found", { status: 404 });

  const finalUrl = claims.to ? normalizeReturnUrl(claims.to, code) : null;
  const withStatus = finalUrl ? withPay(finalUrl, result.pay) : null;
  const copy = PAY_COPY[result.pay];
  return page(copy.title, copy.message, result.orderCode, withStatus);
}

/** `POST /api/pay/return/:code/refresh?t=…[&cancel=1]`（客户端回跳页调用） */
export async function handleReturnRefresh(
  request: Request,
  env: Env,
  code: string,
  deps: ReturnDeps = {},
): Promise<Response> {
  const cors = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "content-type",
    "Cache-Control": "no-store",
  };
  if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: cors });
  if (request.method !== "POST") {
    return new Response("method not allowed", { status: 405, headers: cors });
  }
  const url = new URL(request.url);
  const token = url.searchParams.get("t") ?? "";
  const claims = await verifyReturnToken(env, token, code, deps.now);
  if (!claims) return new Response(JSON.stringify({ error: "not_found" }), { status: 404, headers: { ...cors, "Content-Type": "application/json" } });

  const cancel = url.searchParams.get("cancel") === "1";
  const result = await queryReturnOrder(env, code, { cancel, fetch: deps.fetch, now: deps.now });
  if (!result) {
    return new Response(JSON.stringify({ error: "not_found" }), {
      status: 404,
      headers: { ...cors, "Content-Type": "application/json" },
    });
  }
  return new Response(
    JSON.stringify({ order_code: result.orderCode, status: result.orderStatus, pay: result.pay }),
    { status: 200, headers: { ...cors, "Content-Type": "application/json" } },
  );
}
