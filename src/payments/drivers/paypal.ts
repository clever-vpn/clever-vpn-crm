/**
 * PayPal 薄 driver —— OAuth2 + Order + capture + 查单
 *
 * 与 cf-api `payment_orders/services/providers/paypal.ts` 同构：
 *   - 下单：OAuth2 换 token → `POST /v2/checkout/orders`（`intent=CAPTURE`），
 *     返回 `approve` 链接；
 *   - 查单：订单 `APPROVED` 时**主动 capture**；`COMPLETED` 才算 paid，
 *     最终交易号是 **capture id**（不是 order id）。
 *
 * webhook 验签在 `payments/webhook.ts`（官方 verify 接口），这里只负责
 * create + query；事件本身不直接判已付，仍由 `pollOrderOnce` 复核。
 * 环境决定 sandbox / live：`ENVIRONMENT === "production"` 用 live，否则 sandbox。
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

export const PAYPAL_LIVE_BASE = "https://api-m.paypal.com";
export const PAYPAL_SANDBOX_BASE = "https://api-m.sandbox.paypal.com";

interface PayPalOrder {
  id?: string;
  status?: string;
  links?: Array<{ rel: string; href: string }>;
  purchase_units?: Array<{
    amount?: { currency_code?: string; value?: string };
    payments?: {
      captures?: Array<{ id?: string; amount?: { currency_code?: string; value?: string } }>;
    };
  }>;
}

function apiBase(input: { env: { ENVIRONMENT?: string } }): string {
  return String(input.env.ENVIRONMENT ?? "").trim() === "production"
    ? PAYPAL_LIVE_BASE
    : PAYPAL_SANDBOX_BASE;
}

function rejected(status: number, text: string): { ok: false; status: number; code: string; message: string } {
  return {
    ok: false,
    status: 502,
    code: "gateway_rejected",
    message: `PayPal HTTP ${status}：${text.slice(0, 500)}`,
  };
}

async function getAccessToken(
  input: { merchantId: string | null; secret: string; env: { ENVIRONMENT?: string }; fetch?: typeof fetch },
  base: string,
): Promise<{ ok: true; token: string } | { ok: false; message: string }> {
  const clientId = (input.merchantId ?? "").trim();
  if (!clientId) return { ok: false, message: "PayPal 缺少 Client ID" };
  const doFetch = fetchOf(input);
  let res: Response;
  try {
    res = await doFetch(`${base}/v1/oauth2/token`, {
      method: "POST",
      headers: {
        Authorization: `Basic ${btoa(`${clientId}:${input.secret}`)}`,
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: "grant_type=client_credentials",
      signal: AbortSignal.timeout(DRIVER_TIMEOUT_MS),
    });
  } catch (e) {
    return { ok: false, message: `PayPal 无响应：${errorMessage(e)}` };
  }
  const text = await res.text();
  if (!res.ok) return { ok: false, message: `PayPal auth HTTP ${res.status}：${text.slice(0, 300)}` };
  try {
    const data = JSON.parse(text) as { access_token?: string };
    if (!data.access_token) return { ok: false, message: "PayPal 没返回 access_token" };
    return { ok: true, token: data.access_token };
  } catch {
    return { ok: false, message: "PayPal auth 返回的不是 JSON" };
  }
}

function amountMinorOf(order: PayPalOrder): number | null {
  const unit = order.purchase_units?.[0];
  const raw = unit?.payments?.captures?.[0]?.amount?.value ?? unit?.amount?.value;
  if (raw === undefined || raw === null || raw === "") return null;
  const n = Number(raw);
  return Number.isFinite(n) ? Math.round(n * 100) : null;
}

function captureIdOf(order: PayPalOrder): string | null {
  return order.purchase_units?.[0]?.payments?.captures?.[0]?.id ?? null;
}

export async function createPaypalCharge(input: ChargeInput): Promise<ChargeOutcome> {
  const base = apiBase(input);
  const auth = await getAccessToken(input, base);
  if (!auth.ok) return { ok: false, status: 502, code: "gateway_rejected", message: auth.message };

  const body = {
    intent: "CAPTURE",
    purchase_units: [
      {
        amount: {
          currency_code: input.currency.toUpperCase(),
          // 最小单位 → 两位小数字符串；零小数币种不在本轮
          value: (input.amountMinor / 100).toFixed(2),
        },
        description: input.subject || "VPN",
        custom_id: input.orderNo,
      },
    ],
    application_context: {
      return_url: input.successUrl,
      cancel_url: input.cancelUrl,
      user_action: "PAY_NOW",
    },
  };

  const doFetch = fetchOf(input);
  let res: Response;
  try {
    res = await doFetch(`${base}/v2/checkout/orders`, {
      method: "POST",
      headers: { Authorization: `Bearer ${auth.token}`, "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(DRIVER_TIMEOUT_MS),
    });
  } catch (e) {
    return { ok: false, status: 502, code: "gateway_unreachable", message: `PayPal 无响应：${errorMessage(e)}` };
  }

  const text = await res.text();
  if (!res.ok) return rejected(res.status, text);

  let order: PayPalOrder;
  try {
    order = JSON.parse(text) as PayPalOrder;
  } catch {
    return { ok: false, status: 502, code: "gateway_bad_response", message: "PayPal 返回的不是 JSON" };
  }
  const approve = order.links?.find((l) => l.rel === "approve")?.href
    ?? order.links?.find((l) => l.rel === "payer-action")?.href
    ?? "";
  if (!order.id || !approve) {
    return { ok: false, status: 502, code: "gateway_bad_response", message: "PayPal 没返回订单号 / approve 链接" };
  }
  return { ok: true, payUrl: approve, tradeNo: order.id, raw: text.slice(0, 4000) };
}

async function fetchOrder(base: string, token: string, id: string, doFetch: typeof fetch): Promise<
  { ok: true; order: PayPalOrder; raw: string } | { ok: false; message: string; raw: string | null }
> {
  let res: Response;
  try {
    res = await doFetch(`${base}/v2/checkout/orders/${encodeURIComponent(id)}`, {
      headers: { Authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(DRIVER_TIMEOUT_MS),
    });
  } catch (e) {
    return { ok: false, message: `PayPal 无响应：${errorMessage(e)}`, raw: null };
  }
  const text = await res.text();
  if (!res.ok) return { ok: false, message: `PayPal HTTP ${res.status}：${text.slice(0, 300)}`, raw: text.slice(0, 4000) };
  try {
    return { ok: true, order: JSON.parse(text) as PayPalOrder, raw: text.slice(0, 4000) };
  } catch {
    return { ok: false, message: "PayPal 返回的不是 JSON", raw: text.slice(0, 4000) };
  }
}

export async function queryPaypalCharge(input: QueryInput): Promise<QueryOutcome> {
  const base = apiBase(input);
  const id = input.providerTradeNo.trim();
  if (!id) return { status: "error", message: "缺少 PayPal order id", raw: null };

  const auth = await getAccessToken(input, base);
  if (!auth.ok) return { status: "error", message: auth.message, raw: null };

  const doFetch = fetchOf(input);
  let info = await fetchOrder(base, auth.token, id, doFetch);
  if (!info.ok) return { status: "error", message: info.message, raw: info.raw };

  let raw = info.raw;
  // APPROVED 只是"买家授权了"，还没扣款；必须 capture 才真正到账。
  if (info.order.status === "APPROVED") {
    let cap: Response;
    try {
      cap = await doFetch(`${base}/v2/checkout/orders/${encodeURIComponent(id)}/capture`, {
        method: "POST",
        headers: { Authorization: `Bearer ${auth.token}`, "Content-Type": "application/json" },
        body: "{}",
        signal: AbortSignal.timeout(DRIVER_TIMEOUT_MS),
      });
    } catch (e) {
      return { status: "error", message: `PayPal capture 无响应：${errorMessage(e)}`, raw };
    }
    const capText = await cap.text();
    raw = capText.slice(0, 4000);
    if (cap.ok) {
      try {
        info = { ok: true, order: JSON.parse(capText) as PayPalOrder, raw };
      } catch {
        return { status: "error", message: "PayPal capture 返回的不是 JSON", raw };
      }
    } else if (/ALREADY_CAPTURED/i.test(capText)) {
      // 并发/历史轮询已经捕获过：回查权威状态
      info = await fetchOrder(base, auth.token, id, doFetch);
      if (!info.ok) return { status: "error", message: info.message, raw: info.raw };
      raw = info.raw;
    } else {
      // 网络/网关侧失败：订单仍是 APPROVED，留给下一轮重试
      return {
        status: "unpaid",
        amountMinor: amountMinorOf(info.order),
        tradeNo: captureIdOf(info.order) ?? id,
        message: `PayPal capture HTTP ${cap.status}`,
        raw,
      };
    }
  }

  const status = info.order.status;
  if (status === "COMPLETED") {
    return {
      status: "paid",
      amountMinor: amountMinorOf(info.order),
      tradeNo: captureIdOf(info.order) ?? id,
      raw,
    };
  }
  if (status === "VOIDED") {
    return {
      status: "terminal",
      amountMinor: null,
      tradeNo: id,
      message: "PayPal order voided",
      raw,
    };
  }
  return {
    status: "unpaid",
    amountMinor: amountMinorOf(info.order),
    tradeNo: captureIdOf(info.order) ?? id,
    raw,
  };
}

export const paypalDriver: PaymentDriver = {
  create: createPaypalCharge,
  query: queryPaypalCharge,
};


export interface PaypalWebhookInput {
  headers: Headers;
  rawBody: string;
  clientId: string;
  secret: string;
  webhookId: string;
  env: { ENVIRONMENT?: string };
  fetch?: typeof fetch;
}

/**
 * 用 PayPal 的官方接口验证 webhook：
 * `POST /v1/notify/webhooks/verify-webhook-signature`。
 *
 * 不在本地自己算签名：PayPal 要求用 cert URL / transmission 头去官方验证；
 * 本地复刻证书链只会把实现变成易错的安全代码。
 */
export async function verifyPaypalWebhook(
  input: PaypalWebhookInput,
): Promise<{ ok: boolean; message?: string }> {
  if (!input.webhookId.trim()) return { ok: false, message: "缺少 PayPal webhook id" };
  let event: unknown;
  try {
    event = JSON.parse(input.rawBody) as unknown;
  } catch {
    return { ok: false, message: "webhook body 不是 JSON" };
  }

  const base = apiBase(input);
  const auth = await getAccessToken(
    { merchantId: input.clientId, secret: input.secret, env: input.env, fetch: input.fetch },
    base,
  );
  if (!auth.ok) return { ok: false, message: auth.message };

  const body = {
    auth_algo: input.headers.get("paypal-auth-algo") ?? "",
    cert_url: input.headers.get("paypal-cert-url") ?? "",
    transmission_id: input.headers.get("paypal-transmission-id") ?? "",
    transmission_sig: input.headers.get("paypal-transmission-sig") ?? "",
    transmission_time: input.headers.get("paypal-transmission-time") ?? "",
    webhook_id: input.webhookId,
    webhook_event: event,
  };

  const doFetch = fetchOf(input);
  let res: Response;
  try {
    res = await doFetch(`${base}/v1/notify/webhooks/verify-webhook-signature`, {
      method: "POST",
      headers: { Authorization: `Bearer ${auth.token}`, "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(DRIVER_TIMEOUT_MS),
    });
  } catch (e) {
    return { ok: false, message: `PayPal verify 无响应：${errorMessage(e)}` };
  }
  const text = await res.text();
  if (!res.ok) return { ok: false, message: `PayPal verify HTTP ${res.status}：${text.slice(0, 300)}` };
  try {
    const data = JSON.parse(text) as { verification_status?: string };
    return data.verification_status === "SUCCESS"
      ? { ok: true }
      : { ok: false, message: `PayPal verification_status=${data.verification_status ?? "?"}` };
  } catch {
    return { ok: false, message: "PayPal verify 返回的不是 JSON" };
  }
}
