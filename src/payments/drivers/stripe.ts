/**
 * Stripe 薄 driver —— Checkout Session + 查单
 *
 * 与 cf-api `payment_orders/services/providers/stripe.ts` 同构：
 *   - 下单：`POST /v1/checkout/sessions`，`mode=payment`；
 *   - 查单：`GET /v1/checkout/sessions/{id}`，`payment_status=paid` 才算到账；
 *   - session id 即权威交易号（退款/对账用它）。
 *
 * webhook 验签在 `payments/webhook.ts`（`Stripe-Signature` 的 HMAC），这里只负责
 * create + query；事件本身不直接判已付，仍由 `pollOrderOnce` 复核。
 */

import {
  DRIVER_TIMEOUT_MS,
  errorMessage,
  fetchOf,
  type ChargeInput,
  type ChargeOutcome,
  type PaymentDriver,
  type QueryInput,
  type QueryOutcome,
} from "./types";

export const STRIPE_API_BASE = "https://api.stripe.com/v1";

interface Session {
  id?: string;
  url?: string;
  status?: string;
  payment_status?: string;
  amount_total?: number;
}

function rejected(status: number, text: string): { ok: false; status: number; code: string; message: string } {
  return {
    ok: false,
    status: 502,
    code: "gateway_rejected",
    message: `Stripe HTTP ${status}：${text.slice(0, 500)}`,
  };
}

export async function createStripeCharge(input: ChargeInput): Promise<ChargeOutcome> {
  const doFetch = fetchOf(input);
  const body = new URLSearchParams({
    mode: "payment",
    success_url: input.successUrl,
    cancel_url: input.cancelUrl,
    "line_items[0][price_data][currency]": input.currency.toLowerCase(),
    "line_items[0][price_data][product_data][name]": input.subject || "VPN",
    "line_items[0][price_data][unit_amount]": String(Math.round(input.amountMinor)),
    "line_items[0][quantity]": "1",
    client_reference_id: input.orderNo,
    "metadata[order_code]": input.orderNo,
  });
  if (input.customerEmail) body.set("customer_email", input.customerEmail);

  let res: Response;
  try {
    res = await doFetch(`${STRIPE_API_BASE}/checkout/sessions`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${input.secret}`,
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body,
      signal: AbortSignal.timeout(DRIVER_TIMEOUT_MS),
    });
  } catch (e) {
    return { ok: false, status: 502, code: "gateway_unreachable", message: `Stripe 无响应：${errorMessage(e)}` };
  }

  const text = await res.text();
  if (!res.ok) return rejected(res.status, text);

  let session: Session;
  try {
    session = JSON.parse(text) as Session;
  } catch {
    return { ok: false, status: 502, code: "gateway_bad_response", message: "Stripe 返回的不是 JSON" };
  }
  if (!session.id || !session.url) {
    return { ok: false, status: 502, code: "gateway_bad_response", message: "Stripe 没返回 session id / url" };
  }
  return { ok: true, payUrl: session.url, tradeNo: session.id, raw: text.slice(0, 4000) };
}

export async function queryStripeCharge(input: QueryInput): Promise<QueryOutcome> {
  const doFetch = fetchOf(input);
  const id = input.providerTradeNo.trim();
  if (!id) return { status: "error", message: "缺少 Stripe session id", raw: null };

  let res: Response;
  try {
    res = await doFetch(`${STRIPE_API_BASE}/checkout/sessions/${encodeURIComponent(id)}`, {
      headers: { Authorization: `Bearer ${input.secret}` },
      signal: AbortSignal.timeout(DRIVER_TIMEOUT_MS),
    });
  } catch (e) {
    return { status: "error", message: `Stripe 无响应：${errorMessage(e)}`, raw: null };
  }

  const text = await res.text();
  if (!res.ok) return { status: "error", message: `Stripe HTTP ${res.status}：${text.slice(0, 300)}`, raw: text.slice(0, 4000) };

  let session: Session;
  try {
    session = JSON.parse(text) as Session;
  } catch {
    return { status: "error", message: "Stripe 返回的不是 JSON", raw: text.slice(0, 4000) };
  }

  const paid = session.payment_status === "paid";
  const terminal = !paid && session.status === "expired";
  return {
    status: paid ? "paid" : terminal ? "terminal" : "unpaid",
    amountMinor: typeof session.amount_total === "number" ? session.amount_total : null,
    tradeNo: session.id ?? id,
    raw: text.slice(0, 4000),
  };
}

export const stripeDriver: PaymentDriver = {
  create: createStripeCharge,
  query: queryStripeCharge,
};


/** Stripe webhook 签名容差（官方建议 5 分钟） */
export const STRIPE_WEBHOOK_TOLERANCE_SECONDS = 300;

/** 十六进制 → Uint8Array；非法返回 null */
function hexBytes(hex: string): Uint8Array | null {
  if (!/^[0-9a-f]+$/i.test(hex) || hex.length % 2 !== 0) return null;
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i += 1) out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return out;
}

/**
 * 验证 Stripe webhook 的 `Stripe-Signature`。
 *
 * 格式：`t=<unix>,v1=<hex>[,v1=<hex>]`；签名原文是 `${t}.${rawBody}`，
 * HMAC-SHA256 用 endpoint 的 signing secret（`whsec_...`）。
 * 必须在解析 body 之前用**原始文本**，不能 `request.json()` 后再序列化。
 */
export async function verifyStripeSignature(
  rawBody: string,
  signatureHeader: string,
  webhookSecret: string,
  nowSeconds: number = Math.floor(Date.now() / 1000),
): Promise<boolean> {
  if (!webhookSecret.trim()) return false;
  let timestamp = 0;
  const signatures: string[] = [];
  for (const part of signatureHeader.split(",")) {
    const idx = part.indexOf("=");
    if (idx <= 0) continue;
    const key = part.slice(0, idx).trim();
    const value = part.slice(idx + 1).trim();
    if (key === "t") timestamp = Number(value);
    if (key === "v1" && value) signatures.push(value);
  }
  if (!Number.isFinite(timestamp) || signatures.length === 0) return false;
  if (Math.abs(nowSeconds - timestamp) > STRIPE_WEBHOOK_TOLERANCE_SECONDS) return false;

  const enc = new TextEncoder();
  let key: CryptoKey;
  try {
    key = await crypto.subtle.importKey(
      "raw",
      enc.encode(webhookSecret),
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["verify"],
    );
  } catch {
    return false;
  }
  const data = enc.encode(`${timestamp}.${rawBody}`);
  for (const sig of signatures) {
    const bytes = hexBytes(sig);
    if (bytes && (await crypto.subtle.verify("HMAC", key, bytes, data))) return true;
  }
  return false;
}
