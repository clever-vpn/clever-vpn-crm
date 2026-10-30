/**
 * 下单 = **一次支付尝试**（`docs/payments.md` §2）
 *
 * 每次调用都写一行 `orders`（单号唯一、创建后不可改），并立刻向网关换一个收银台
 * 地址。**不判断是否已付** —— 那是 notify / queryCharge 的事。
 */

import { listLiveGateways, mappingOf, pickGateway } from "./gateways";
import { buildCreateRequest, parseCreateResponse } from "./mapping";
import { MOCK_DRIVER, mockSecret } from "./mock";
import { decryptSecret } from "./secret";

import type { Env } from "../env";
import type { Plan } from "../plans/model";

/**
 * 订单有效期（分钟）= **支付窗口**。
 *
 * 窗口内 cron 按退避曲线主动查单（`payments/poll.ts`）；到点没查到钱就置 `expired`
 * 并**停止主动查单**，之后只等回调（钱晚到仍会转 `paid`）+ 后台人工「查一次」。
 *
 * 60 分钟是权衡：更短会让"慢用户"付完就见过期，更长会让"点了又放弃"的单拖着一堆
 * 查单请求（每个单每 2 分钟一次、打在网关的 QPS 上）。
 */
export const ORDER_TTL_MINUTES = 60;

/** 双击保护窗口（秒）：同一 plan + 方式在这个窗口内复用未过期的 pending 单 */
const REUSE_WINDOW_SECONDS = 60;

/**
 * 单号：**纯字母数字**（很多网关的 `out_trade_no` 不接受标点，长度也有限制）。
 * 形如 `ORD20261024A1B2C3D4`（19 位）。
 */
export function newOrderCode(now: Date = new Date()): string {
  const ymd = now.toISOString().slice(0, 10).replace(/-/g, "");
  const buf = new Uint8Array(4);
  crypto.getRandomValues(buf);
  const rand = [...buf].map((b) => b.toString(16).padStart(2, "0")).join("").toUpperCase();
  return `ORD${ymd}${rand}`;
}

/**
 * 取网关密钥（明文，只在内存里）。
 *
 * - `mock`：派生自 `SESSION_SECRET`；
 * - 其它：解密 `secret_enc`。解不开（没配主密钥 / 换过主密钥 / 密文被改）→ `null`，
 *   调用方必须明确报错，**不能**拿空密钥去签名（那样会静默签错）。
 */
export async function gatewaySecret(
  env: Env,
  gw: { driver: string; secret_enc: string | null },
): Promise<string | null> {
  if (gw.driver === MOCK_DRIVER) return mockSecret(env);
  return decryptSecret(env, gw.secret_enc);
}

export interface CreateChargeInput {
  customerId: number;
  customerEmail: string;
  plan: Plan;
  /** 用户选的支付方式（alipay / wechat / …） */
  method: string;
  /**
   * 应付金额（最小单位）。**不传就按套餐目录价**；
   * 升级时必须传 `quote.payable_minor`（新价 − 残值），否则会按原价收钱。
   */
  amountMinor?: number;
  /**
   * 促销减免（分）与命中的活动。**只用于记账与事后核销**，
   * 不再二次计算 —— 金额已经包含在 `amountMinor` 里了。
   */
  discountMinor?: number;
  promotionId?: number | null;
  /** 命中的批次码 id（一码一人的券）；主码 / 无码不传 */
  codeId?: number | null;
  /** 入口：`web`（品牌官网）/ `app`；只用于统计，不参与计价 */
  entry?: string | null;
  /** 本站 origin（拼 pay_url 与 notify_url 用） */
  origin: string;
  clientIp?: string;
  now?: Date;
  /** 仅测试注入：默认用全局 fetch */
  fetch?: typeof fetch;
}

export type CreateChargeResult =
  | {
      ok: true;
      orderCode: string;
      payUrl: string;
      amountMinor: number;
      currency: string;
      expiresAt: string;
      /** true = 复用了 60 秒内的 pending 单（防双击），没有新建行 */
      reused: boolean;
    }
  | { ok: false; status: number; code: string; message: string };

export async function createCharge(env: Env, input: CreateChargeInput): Promise<CreateChargeResult> {
  const now = input.now ?? new Date();
  const nowIso = now.toISOString();
  const origin = input.origin.replace(/\/+$/, "");
  const amountMinor = input.amountMinor ?? input.plan.price_minor;

  // ── 1. 防双击：60 秒内同一 plan + 方式 + **金额**还在 pending ⇒ 复用（不新建行）──
  //    金额必须参与匹配：用户中途换了个优惠码，价格变了就该新建一单，
  //    否则会把“旧价的收银台”当成新单交回去。
  const cutoff = new Date(now.getTime() - REUSE_WINDOW_SECONDS * 1000).toISOString();
  const recent = await env.DB.prepare(
    `SELECT code, pay_url, amount_minor, currency, expires_at FROM orders
      WHERE customer_id = ? AND plan_id = ? AND payment_method = ? AND status = 'pending'
        AND amount_minor = ?
        AND pay_url IS NOT NULL AND created_at >= ? AND expires_at > ?
      ORDER BY id DESC LIMIT 1`,
  )
    .bind(input.customerId, input.plan.id, input.method, amountMinor, cutoff, nowIso)
    .first<{ code: string; pay_url: string; amount_minor: number; currency: string; expires_at: string | null }>();

  if (recent?.pay_url) {
    return {
      ok: true,
      orderCode: recent.code,
      payUrl: recent.pay_url,
      amountMinor: recent.amount_minor,
      currency: recent.currency,
      expiresAt: recent.expires_at ?? nowIso,
      reused: true,
    };
  }

  // ── 2. 路由：闸门全在这一处（status / methods / 白名单 / 环境开关）──
  const route = pickGateway(await listLiveGateways(env), input.method, input.customerEmail, env);
  if (!route) {
    return { ok: false, status: 400, code: "payment_method_unavailable", message: "该支付方式暂不可用" };
  }
  const mapping = mappingOf(route.gateway);
  if (!mapping) {
    return { ok: false, status: 400, code: "gateway_misconfigured", message: "该支付网关的映射配置无效" };
  }

  const currency = input.plan.currency;
  const orderCode = newOrderCode(now);
  const expiresAt = new Date(now.getTime() + ORDER_TTL_MINUTES * 60_000).toISOString();

  // ── 3. 换收银台地址 ──
  let payUrl: string;
  let rawCreate: string | null = null;
  let tradeNo: string | null = null;

  if (route.gateway.driver === MOCK_DRIVER) {
    payUrl = `${origin}/pay/mock/${orderCode}`;
  } else {
    const secret = await gatewaySecret(env, route.gateway);
    if (!secret) {
      // 密钥解不开 ⇒ 明确拒绝，不拿空密钥去签名
      return {
        ok: false,
        status: 501,
        code: "gateway_not_ready",
        message: "网关密钥不可用（未配置 PAYMENT_SECRET_KEY 或密文无法解密）",
      };
    }
    const doFetch = input.fetch ?? fetch;
    const req = buildCreateRequest(mapping, {
      merchant: route.gateway.merchant_id ?? "",
      secret,
      orderNo: orderCode,
      amountMinor,
      currency,
      subject: input.plan.name,
      method: input.method,
      notifyUrl: `${origin}/api/pay/notify/${route.gateway.id}`,
      returnUrl: `${origin}/?order=${orderCode}`,
      clientIp: input.clientIp,
      endpoint: route.gateway.endpoint ?? "",
      now,
    });

    let text = "";
    try {
      const res = await doFetch(req.url, {
        method: req.method,
        headers: req.headers,
        body: req.body,
        signal: AbortSignal.timeout(10_000),
      });
      text = await res.text();
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
    } catch (e) {
      return {
        ok: false,
        status: 502,
        code: "gateway_unreachable",
        message: `网关无响应：${e instanceof Error ? e.message : String(e)}`,
      };
    }

    let payload: unknown;
    try {
      payload = JSON.parse(text) as unknown;
    } catch {
      return { ok: false, status: 502, code: "gateway_bad_response", message: "网关返回的不是 JSON" };
    }
    const parsed = parseCreateResponse(mapping, payload);
    if (!parsed.ok || !parsed.payUrl) {
      return {
        ok: false,
        status: 502,
        code: "gateway_rejected",
        message: parsed.message ?? "网关拒绝了这笔下单",
      };
    }
    payUrl = parsed.payUrl;
    tradeNo = parsed.tradeNo ?? null;
    rawCreate = text;
  }

  // ── 4. 落订单（单号创建后不可改）──
  await env.DB.prepare(
    `INSERT INTO orders (code, customer_id, plan_id, kind, plan_snapshot, amount_minor, currency,
       discount_minor, promotion_id, code_id, entry,
       source, payment_method, gateway_id, provider_order_no, provider_trade_no, pay_url,
       raw_create, expires_at, status, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'purchase', ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?)`,
  )
    .bind(
      orderCode,
      input.customerId,
      input.plan.id,
      input.plan.kind,
      JSON.stringify(input.plan),
      amountMinor,
      currency,
      input.discountMinor ?? 0,
      input.promotionId ?? null,
      input.codeId ?? null,
      input.entry ?? null,
      input.method,
      route.gateway.id,
      orderCode,
      tradeNo,
      payUrl,
      rawCreate,
      expiresAt,
      nowIso,
      nowIso,
    )
    .run();

  return { ok: true, orderCode, payUrl, amountMinor, currency, expiresAt, reused: false };
}
