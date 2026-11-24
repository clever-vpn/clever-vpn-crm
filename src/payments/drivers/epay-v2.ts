/**
 * 易支付 V2（epayn）薄 driver —— RSA-SHA256 双向签名。
 *
 * 与 Stripe/PayPal 一样不经过映射解释器：RSA、时间戳、响应验签都超出
 * `mapping.ts` 的本地摘要边界。
 *
 * 文档：https://docs.xarr.cn/merchant/api/epayn.html
 *   - 创建：POST {base}/api/pay/create（JSON）→ pay_info / pay_type / trade_no
 *   - 查单：POST {base}/api/pay/query（JSON）→ status=2 已付
 *   - 通知：GET，trade_status=TRADE_SUCCESS；平台公钥验签；应答 success
 *
 * 凭据 `secret_enc` 是加密 JSON：
 *   { "merchant_private_key": "-----BEGIN PRIVATE KEY-----...",
 *     "platform_public_key": "-----BEGIN PUBLIC KEY-----..." }
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
import { importRsaPrivateKey, importRsaPublicKey, rsaSignBase64, rsaVerifyBase64 } from "./rsa";

interface EpayV2Creds {
  privateKey: CryptoKey;
  platformPublic: CryptoKey;
}

function parseCreds(raw: string): Promise<EpayV2Creds | null> {
  let json: unknown;
  try {
    json = JSON.parse(raw) as unknown;
  } catch {
    return Promise.resolve(null);
  }
  if (!json || typeof json !== "object") return Promise.resolve(null);
  const obj = json as Record<string, unknown>;
  const priv = typeof obj.merchant_private_key === "string" ? obj.merchant_private_key : "";
  const pub = typeof obj.platform_public_key === "string" ? obj.platform_public_key : "";
  if (!priv || !pub) return Promise.resolve(null);
  return (async () => {
    const privateKey = await importRsaPrivateKey(priv);
    const platformPublic = await importRsaPublicKey(pub);
    return privateKey && platformPublic ? { privateKey, platformPublic } : null;
  })();
}

function apiBase(endpoint: string): string {
  return `${endpoint.replace(/\/+$/, "")}/api/pay`;
}

function canonical(params: Record<string, unknown>): string {
  return Object.keys(params)
    .filter((k) => k !== "sign" && k !== "sign_type" && String(params[k] ?? "") !== "")
    .sort()
    .map((k) => `${k}=${String(params[k])}`)
    .join("&");
}

async function signRequest(
  params: Record<string, unknown>,
  creds: EpayV2Creds,
): Promise<Record<string, unknown>> {
  const sign = await rsaSignBase64(creds.privateKey, canonical(params));
  return { ...params, sign, sign_type: "RSA" };
}

async function verifyResponse(
  payload: Record<string, unknown>,
  creds: EpayV2Creds,
): Promise<boolean> {
  const sign = typeof payload.sign === "string" ? payload.sign : "";
  if (!sign) return false;
  return rsaVerifyBase64(creds.platformPublic, canonical(payload), sign);
}

function timestamp(): string {
  return String(Math.floor(Date.now() / 1000));
}

function amountYuan(amountMinor: number): string {
  return (amountMinor / 100).toFixed(2);
}

function amountMinor(raw: unknown): number | null {
  if (raw === undefined || raw === null || raw === "") return null;
  const n = Number(String(raw));
  return Number.isFinite(n) ? Math.round(n * 100) : null;
}

function wechatCode(method: string): string {
  return method === "wechat" ? "wxpay" : method;
}

interface EpayV2Response {
  code?: unknown;
  msg?: unknown;
  trade_no?: unknown;
  pay_type?: unknown;
  pay_info?: unknown;
  status?: unknown;
  money?: unknown;
  [key: string]: unknown;
}

async function post(
  base: string,
  path: string,
  params: Record<string, unknown>,
  creds: EpayV2Creds,
  doFetch: typeof fetch,
): Promise<{ ok: true; body: EpayV2Response; raw: string } | { ok: false; message: string; raw: string | null }> {
  const body = await signRequest(params, creds);
  let res: Response;
  try {
    res = await doFetch(`${base}${path}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(DRIVER_TIMEOUT_MS),
    });
  } catch (e) {
    return { ok: false, message: `易支付 V2 无响应：${errorMessage(e)}`, raw: null };
  }
  const text = await res.text();
  if (!res.ok) return { ok: false, message: `易支付 V2 HTTP ${res.status}：${text.slice(0, 300)}`, raw: text.slice(0, 4000) };
  let parsed: EpayV2Response;
  try {
    parsed = JSON.parse(text) as EpayV2Response;
  } catch {
    return { ok: false, message: "易支付 V2 返回的不是 JSON", raw: text.slice(0, 4000) };
  }
  if (!(await verifyResponse(parsed, creds))) {
    return { ok: false, message: "易支付 V2 响应签名校验失败", raw: text.slice(0, 4000) };
  }
  return { ok: true, body: parsed, raw: text.slice(0, 4000) };
}

export async function createEpayV2(input: ChargeInput): Promise<ChargeOutcome> {
  const creds = await parseCreds(input.secret);
  if (!creds) {
    return { ok: false, status: 500, code: "gateway_not_ready", message: "易支付 V2 密钥 JSON 无效（需要商户私钥 + 平台公钥）" };
  }
  if (!input.notifyUrl) {
    return { ok: false, status: 500, code: "gateway_not_ready", message: "易支付 V2 缺少 notify_url" };
  }
  const method = (input.paymentMethod ?? "").trim();
  if (!method) {
    return { ok: false, status: 500, code: "gateway_not_ready", message: "易支付 V2 缺少支付方式 type" };
  }
  const createParams: Record<string, unknown> = {
    pid: input.merchantId ?? "",
    type: wechatCode(method),
    out_trade_no: input.orderNo,
    notify_url: input.notifyUrl,
    return_url: input.successUrl,
    name: input.subject,
    money: amountYuan(input.amountMinor),
    timestamp: timestamp(),
  };

  const out = await post(apiBase(input.gateway.endpoint ?? ""), "/create", createParams, creds, fetchOf(input));
  if (!out.ok) return { ok: false, status: 502, code: "gateway_rejected", message: out.message };
  const body = out.body;
  if (String(body.code ?? "") !== "0") {
    return { ok: false, status: 502, code: "gateway_rejected", message: `易支付 V2 code=${String(body.code ?? "")} ${String(body.msg ?? "")}` };
  }
  const payInfo = String(body.pay_info ?? "").trim();
  if (!payInfo) return { ok: false, status: 502, code: "gateway_bad_response", message: "易支付 V2 没返回 pay_info" };
  return { ok: true, payUrl: payInfo, tradeNo: String(body.trade_no ?? input.orderNo), raw: out.raw };
}

export async function queryEpayV2(input: QueryInput): Promise<QueryOutcome> {
  const creds = await parseCreds(input.secret);
  if (!creds) return { status: "error", message: "易支付 V2 密钥 JSON 无效", raw: null };
  const params: Record<string, unknown> = {
    pid: input.merchantId ?? "",
    trade_no: input.providerTradeNo,
    timestamp: timestamp(),
  };
  const out = await post(apiBase(input.gateway.endpoint ?? ""), "/query", params, creds, fetchOf(input));
  if (!out.ok) return { status: "error", message: out.message, raw: out.raw };
  const body = out.body;
  if (String(body.code ?? "") !== "0") {
    return { status: "error", message: `易支付 V2 code=${String(body.code ?? "")} ${String(body.msg ?? "")}`, raw: out.raw };
  }
  const status = String(body.status ?? "");
  const paid = status === "2";
  return {
    status: paid ? "paid" : "unpaid",
    amountMinor: amountMinor(body.money),
    tradeNo: String(body.trade_no ?? input.providerTradeNo),
    raw: out.raw,
  };
}

/** 回调验签（GET 参数）；不触发查单，调用方负责 */
export async function verifyEpayV2Notify(
  params: Record<string, unknown>,
  secret: string,
): Promise<boolean> {
  const creds = await parseCreds(secret);
  if (!creds) return false;
  return verifyResponse(params, creds);
}

export const epayV2Driver: PaymentDriver = {
  create: createEpayV2,
  query: queryEpayV2,
};
