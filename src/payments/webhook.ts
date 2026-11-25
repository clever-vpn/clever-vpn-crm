/**
 * Stripe / PayPal 的 webhook 处理。
 *
 * 两条硬规则：
 *   1. **先验签，再解析/找订单**；验签失败不回任何订单信息。
 *   2. **webhook 只当触发器**：不拿事件里的金额/状态直接落账，而是调用
 *      `pollOrderOnce`（内部 `queryOnce` + `settlePaidOrder`）。与后台「查一次」、
 *      回跳页、cron 完全同一条判据。
 *
 * URL 是 `/api/pay/notify/:gatewayId`（每个网关一个，租户在 Stripe/PayPal 后台配置一次）。
 * 映射类网关的 notify 逻辑仍在 `notify.ts`，这里只处理 stripe/paypal。
 */

import { verifyPaypalWebhook } from "./drivers/paypal";
import { verifyStripeSignature } from "./drivers/stripe";
import { decryptSecret } from "./secret";

import type { Env } from "../env";
import type { GatewayRow } from "./gateways";

export interface WebhookDeps {
  fetch?: typeof fetch;
  now?: Date;
  /**
   * 由调用方注入（`routes.ts` 传 `pollOrderOnce`）。
   * 不在这里直接 import `poll.ts`：`poll.ts` 反过来 import `notify.ts`，
   * 会造成 notify → webhook → poll → notify 的循环。
   */
  refresh: (orderCode: string) => Promise<unknown>;
}

function text(body: string, status = 200): Response {
  return new Response(body, { status, headers: { "Content-Type": "text/plain; charset=utf-8" } });
}

interface OrderRef {
  code: string;
}

async function findOrder(
  env: Env,
  gatewayId: number,
  code: string | null,
  providerTradeNo: string | null,
): Promise<OrderRef | null> {
  const c = (code ?? "").trim();
  const t = (providerTradeNo ?? "").trim();
  if (!c && !t) return null;
  return env.DB.prepare(
    `SELECT code FROM orders WHERE gateway_id = ? AND (code = ? OR provider_trade_no = ?) LIMIT 1`,
  )
    .bind(gatewayId, c, t)
    .first<OrderRef>();
}

async function triggerRefresh(env: Env, orderCode: string, deps: WebhookDeps): Promise<void> {
  try {
    await deps.refresh(orderCode);
  } catch (e) {
    // webhook 已经验签通过；查单失败交给 cron/回跳页重试。这里只记录，不让 provider 重试
    console.error(`[webhook] refresh ${orderCode} failed: ${e instanceof Error ? e.message : String(e)}`);
  }
}

interface StripeEvent {
  type?: string;
  data?: {
    object?: {
      id?: string;
      client_reference_id?: string | null;
      payment_intent?: string | null;
    };
  };
}

export async function handleStripeWebhook(
  env: Env,
  gateway: GatewayRow,
  request: Request,
  deps: WebhookDeps,
): Promise<Response> {
  if (!gateway.webhook_enc) return text("webhook not configured", 400);
  const secret = await decryptSecret(env, gateway.webhook_enc);
  if (!secret) return text("webhook secret unavailable", 500);

  // Stripe 必须用原始文本验签；不能先 json()
  const rawBody = await request.text();
  const header = request.headers.get("stripe-signature") ?? "";
  const nowSeconds = Math.floor((deps.now ?? new Date()).getTime() / 1000);
  if (!(await verifyStripeSignature(rawBody, header, secret, nowSeconds))) {
    return text("bad signature", 400);
  }

  let event: StripeEvent;
  try {
    event = JSON.parse(rawBody) as StripeEvent;
  } catch {
    return text("bad payload", 400);
  }

  const obj = event.data?.object;
  if (!obj) return text("ok");
  // checkout.session.* 的 object 就是 session；兼容 client_reference_id 缺失时用 session id
  const order = await findOrder(
    env,
    gateway.id,
    obj.client_reference_id ?? null,
    obj.id ?? null,
  );
  if (order) await triggerRefresh(env, order.code, deps);
  return text("ok");
}

interface PaypalEvent {
  event_type?: string;
  resource?: {
    id?: string;
    custom_id?: string;
    purchase_units?: Array<{ custom_id?: string }>;
    supplementary_data?: {
      related_ids?: { order_id?: string };
    };
  };
}

export async function handlePaypalWebhook(
  env: Env,
  gateway: GatewayRow,
  request: Request,
  deps: WebhookDeps,
): Promise<Response> {
  if (!gateway.webhook_enc) return text("webhook not configured", 400);
  const webhookId = await decryptSecret(env, gateway.webhook_enc);
  if (!webhookId) return text("webhook id unavailable", 500);
  if (!gateway.merchant_id) return text("client id missing", 400);
  const secret = await decryptSecret(env, gateway.secret_enc);
  if (!secret) return text("client secret unavailable", 500);

  const rawBody = await request.text();
  const verified = await verifyPaypalWebhook({
    headers: request.headers,
    rawBody,
    clientId: gateway.merchant_id,
    secret,
    webhookId,
    paypalEnv: gateway.paypal_env,
    env,
    fetch: deps.fetch,
  });
  if (!verified.ok) return text("bad signature", 400);

  let event: PaypalEvent;
  try {
    event = JSON.parse(rawBody) as PaypalEvent;
  } catch {
    return text("bad payload", 400);
  }

  const res = event.resource;
  if (!res) return text("ok");
  const relatedOrderId = res.supplementary_data?.related_ids?.order_id ?? null;
  const customId = res.custom_id ?? res.purchase_units?.[0]?.custom_id ?? null;
  // capture 事件里 `resource.id` 是 capture id，不是下单时的 order id；
  // 优先用 related order id，才能找到 `provider_trade_no = O-...` 的那条订单。
  const order = await findOrder(
    env,
    gateway.id,
    customId,
    relatedOrderId ?? res.id ?? null,
  );
  if (order) await triggerRefresh(env, order.code, deps);
  return text("ok");
}
