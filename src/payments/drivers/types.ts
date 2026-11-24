/**
 * 薄 driver 的共享契约。
 *
 * 这条路径**不经过映射解释器**：Stripe/PayPal 的签名、OAuth、二次 capture 都
 * 超出 `mapping.ts` 的边界（`docs/payments.md` §6.1）。每个 driver 只做两件事：
 *
 *   1. `create`：向服务商建一笔支付，拿回收银台地址 + 服务商侧的单号；
 *   2. `query`：用服务商侧单号查状态（PayPal 还要在 APPROVED 时 capture）。
 *
 * `fetch` 可注入：单测不发真网络；`raw` 原样落 `orders.raw_create` / `raw_notify`。
 */

import type { Env } from "../../env";
import type { GatewayRow } from "../gateways";

export interface ChargeInput {
  gateway: GatewayRow;
  /** 明文密钥：Stripe Secret Key / PayPal Client Secret */
  secret: string;
  /** PayPal Client ID；Stripe 不用 */
  merchantId: string | null;
  orderNo: string;
  amountMinor: number;
  currency: string;
  subject: string;
  successUrl: string;
  cancelUrl: string;
  /** 服务端回调地址（Epay V2 创建订单必填；Stripe/PayPal 不用） */
  notifyUrl?: string;
  /** 支付方式（Epay V2 的 type=alipay/wxpay；Stripe/PayPal 不用） */
  paymentMethod?: string;
  customerEmail?: string;
  env: Env;
  fetch?: typeof fetch;
}

export type ChargeOutcome =
  | { ok: true; payUrl: string; tradeNo: string; raw: string }
  | { ok: false; status: number; code: string; message: string };

export interface QueryInput {
  gateway: GatewayRow;
  secret: string;
  merchantId: string | null;
  /** 服务商侧单号：Stripe session id / PayPal order id（下单时写入 `provider_trade_no`） */
  providerTradeNo: string;
  amountMinor: number;
  currency: string;
  env: Env;
  fetch?: typeof fetch;
}

export type QueryOutcome =
  | {
      status: "paid" | "unpaid" | "terminal";
      /** 服务商返回的金额（最小单位）；没有就是 null */
      amountMinor: number | null;
      tradeNo: string | null;
      message?: string;
      raw: string;
    }
  | { status: "error"; message: string; raw: string | null };

/** 薄 driver 的统一签名；两个实现都满足它 */
export interface PaymentDriver {
  create(input: ChargeInput): Promise<ChargeOutcome>;
  query(input: QueryInput): Promise<QueryOutcome>;
}

export const DRIVER_TIMEOUT_MS = 10_000;

export function fetchOf(input: { fetch?: typeof fetch }): typeof fetch {
  return input.fetch ?? fetch;
}

export function errorMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}
