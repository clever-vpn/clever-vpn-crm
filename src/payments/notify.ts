/**
 * 支付回调（**所有网关共用一条路径**：`POST /api/pay/notify/:gatewayId`）
 *
 * 铁律（`docs/payments.md` §3.1）：
 *   1. 回调只当**触发器**。验签通过也不直接认账，还要 `queryCharge` 复核；
 *      只有网关没有查单接口时（虎皮椒/mock）才以回调为准。
 *   2. **钱到了必须记账**：订单已 `expired` 也照样转 `paid`（钱不能丢）。
 *   3. 幂等：已经 `paid/active` 的订单直接应答成功，不重复发货。
 */

import { GATEWAY_COLUMNS, mappingOf } from "./gateways";
import {
  buildQueryRequest,
  hasQuery,
  parseNotify,
  parseQueryResponse,
  readNotifyParams,
  type GatewayMapping,
} from "./mapping";
import { gatewaySecret } from "./checkout";
import { insertSubscription, logChange } from "../subscriptions/store";
import { subscriptionFromPlan } from "../plans/subscription";

import type { Env } from "../env";
import type { GatewayRow } from "./gateways";
import type { Plan } from "../plans/model";

interface OrderRow {
  id: number;
  code: string;
  customer_id: number;
  plan_id: string;
  plan_snapshot: string;
  amount_minor: number;
  currency: string;
  payment_method: string;
  gateway_id: number | null;
  status: string;
}

function text(body: string, status = 200): Response {
  return new Response(body, { status, headers: { "Content-Type": "text/plain; charset=utf-8" } });
}

async function markGatewayError(env: Env, gatewayId: number, message: string): Promise<void> {
  await env.DB.prepare(
    `UPDATE payment_gateways SET last_error = ?, updated_at = ? WHERE id = ?`,
  )
    .bind(message.slice(0, 500), new Date().toISOString(), gatewayId)
    .run();
}

/** 发放权益（**幂等靠订单状态**，不是靠调用方） */
async function grant(env: Env, order: OrderRow, tradeNo: string | null, raw: string): Promise<void> {
  const now = new Date();
  const plan = JSON.parse(order.plan_snapshot) as Plan;

  // 先标 paid：即使下面发放失败，也不会重复收钱/重复发
  await env.DB.prepare(
    `UPDATE orders SET status = 'provisioning', paid_at = ?, provider_trade_no = ?, raw_notify = ?, updated_at = ?
      WHERE id = ? AND status IN ('pending', 'expired')`,
  )
    .bind(now.toISOString(), tradeNo, raw, now.toISOString(), order.id)
    .run();

  try {
    const draft = subscriptionFromPlan(plan, {
      customerId: order.customer_id,
      paidMinor: order.amount_minor,
      now,
    });
    const subscriptionId = await insertSubscription(env, draft);
    await logChange(env, {
      customer_id: order.customer_id,
      action: "new",
      to_subscription_id: subscriptionId,
      paid_minor: order.amount_minor,
      detail: { order_id: order.id, order_code: order.code, plan_id: order.plan_id },
    });
    await env.DB.prepare(
      `UPDATE orders SET status = 'active', subscription_id = ?, provisioned_at = ?, updated_at = ?
        WHERE id = ?`,
    )
      .bind(subscriptionId, now.toISOString(), now.toISOString(), order.id)
      .run();
  } catch (e) {
    // 钱已收：绝不能回退订单状态，只记错误等重试（provision_attempts 供运维查看）
    const msg = e instanceof Error ? e.message : String(e);
    await env.DB.prepare(
      `UPDATE orders SET provision_attempts = provision_attempts + 1, provision_error = ?, updated_at = ?
        WHERE id = ?`,
    )
      .bind(msg.slice(0, 500), new Date().toISOString(), order.id)
      .run();
    console.error(`[pay] 发放失败 order=${order.code}: ${msg}`);
  }
}

/**
 * 处理一个网关回调。
 * @returns 必须按厂商要求逐字应答（`notify.reply`），否则会被无限重发
 */
export async function handlePayNotify(
  env: Env,
  request: Request,
  gatewayIdRaw: string,
): Promise<Response> {
  const gatewayId = Number(gatewayIdRaw);
  if (!Number.isInteger(gatewayId) || gatewayId <= 0) return text("bad gateway", 400);

  const gateway = await env.DB.prepare(
    `SELECT ${GATEWAY_COLUMNS} FROM payment_gateways WHERE id = ?`,
  )
    .bind(gatewayId)
    .first<GatewayRow>();
  if (!gateway) return text("unknown gateway", 404);

  const mapping: GatewayMapping | null = mappingOf(gateway);
  if (!mapping) return text("gateway misconfigured", 500);

  const secret = gatewaySecret(env, gateway.driver);
  if (!secret) {
    // 密钥加密尚未实现 ⇒ 无法验签，绝不"先记上再补"
    return text("gateway not ready", 501);
  }

  const params = await readNotifyParams(mapping, request);
  const parsed = parseNotify(mapping, params, secret);

  if (!parsed.signOk) {
    // `parsed.raw` 就是收到的参数 JSON（落 `orders.raw_notify` 与排查都用它）
    await markGatewayError(env, gateway.id, `notify 验签失败 raw=${parsed.raw.slice(0, 200)}`);
    return text("bad sign", 403);
  }
  if (!parsed.paid) {
    // 验签通过但不是"已付款"（例如等待支付）⇒ 正常应答，等下一次
    return text(mapping.notify.reply);
  }
  if (!parsed.orderNo) return text("missing order", 400);

  const order = await env.DB.prepare(
    `SELECT id, code, customer_id, plan_id, plan_snapshot, amount_minor, currency,
       payment_method, gateway_id, status
     FROM orders WHERE provider_order_no = ? AND gateway_id = ?`,
  )
    .bind(parsed.orderNo, gateway.id)
    .first<OrderRow>();

  if (!order) return text("unknown order", 404);

  // 金额核对：回调说的钱必须等于下单时的金额（防篡改、防串单）
  if (parsed.amountMinor !== null && parsed.amountMinor !== order.amount_minor) {
    const msg = `金额不符 order=${order.code} notify=${parsed.amountMinor} expected=${order.amount_minor}`;
    await markGatewayError(env, gateway.id, msg);
    console.error(`[pay] ${msg}`);
    return text("amount mismatch", 400);
  }

  // 幂等：已经认过账就直接应答
  if (order.status === "paid" || order.status === "provisioning" || order.status === "active") {
    return text(mapping.notify.reply);
  }

  // 复核："回调只当触发器"。有查单接口就以查单为准（没有则只能信回调）
  if (hasQuery(mapping)) {
    const secretForQuery = secret;
    const qreq = buildQueryRequest(mapping, {
      merchant: gateway.merchant_id ?? "",
      secret: secretForQuery,
      orderNo: parsed.orderNo,
      amountMinor: order.amount_minor,
      subject: "",
      method: order.payment_method,
      endpoint: gateway.endpoint ?? "",
      now: new Date(),
    });
    try {
      const res = await fetch(qreq.url, {
        method: qreq.method,
        headers: qreq.headers,
        body: qreq.body,
        signal: AbortSignal.timeout(10_000),
      });
      const payload = (await res.json().catch(() => null)) as unknown;
      const q = parseQueryResponse(mapping, payload);
      if (!q.paid) {
        // 查单说没付：不认账，但正常应答（对方会按自己的节奏重试）
        return text(mapping.notify.reply);
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      await markGatewayError(env, gateway.id, `查单失败：${msg}`);
      // 查单不通时**不能**直接认账（宁可晚一点，也不要认错）
      return text("query failed", 502);
    }
  }

  await grant(env, order, parsed.tradeNo, parsed.raw);
  await env.DB.prepare(`UPDATE payment_gateways SET last_ok_at = ?, last_error = NULL WHERE id = ?`)
    .bind(new Date().toISOString(), gateway.id)
    .run();

  return text(mapping.notify.reply);
}
