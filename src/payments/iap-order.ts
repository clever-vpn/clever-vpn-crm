/**
 * `POST /orders/iap` 的实现：把一次**已经在商店完成**的购买落成一笔订单。
 *
 * 顺序不能变：
 *   回源验证 → 各项校验 → 落单（`iap_key` 幂等）→ `settlePaidOrder()` → Google `consume`
 *
 * 最后一步必须是"落库之后"：`consume` 早了凭据就没了，退起款来无法对账。
 */
import { consumeGooglePurchase, verifyApplePurchase, verifyGooglePurchase } from "./iap";
import { decryptSecret } from "./secret";
import { loadStoreChannel } from "./store-channels";
import { settlePaidOrder } from "./notify";
import { rowToPlan } from "../plans/model";

import type { Plan } from "../plans/model";

import type { Env } from "../env";
import type { StoreChannelConfig, VerifiedPurchase } from "./iap";
import type { PayableOrder } from "./notify";

export type IapResult =
  | { ok: true; orderCode: string; status: "paid" | "pending"; customerId: number }
  | { ok: false; status: number; code: string; message: string };

interface Input {
  platform: string;
  productId: string;
  receipt: string;
  customerId: number;
  customerUuid: string;
  fetch?: typeof fetch;
  now?: Date;
}

function orderCode(now: Date): string {
  const stamp = now.toISOString().replace(/\D/g, "").slice(0, 14);
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  const bytes = new Uint8Array(4);
  crypto.getRandomValues(bytes);
  let suffix = "";
  for (const b of bytes) suffix += alphabet[b % alphabet.length];
  return `IAP${stamp}${suffix}`;
}

async function channelConfig(
  env: Env,
  platform: string,
): Promise<StoreChannelConfig | { error: string }> {
  const row = await loadStoreChannel(env, platform);
  if (!row) return { error: "not_configured" };
  if (row.status !== "live") return { error: "not_live" };
  const plain = await decryptSecret(env, row.secret_enc);
  if (!plain) return { error: "no_secret" };
  let secret: Record<string, unknown>;
  try {
    secret = JSON.parse(plain) as Record<string, unknown>;
  } catch {
    return { error: "bad_secret" };
  }
  return {
    platform: platform as StoreChannelConfig["platform"],
    endpoint: (row.endpoint || "").replace(/\/+$/, ""),
    identifier: row.identifier,
    environment: row.environment,
    secret,
  };
}

/** 在架的套餐（与 `/plans` 同一份数据；商品号 → 套餐的反查用它） */
async function loadActivePlans(env: Env): Promise<Plan[]> {
  const rows = await env.DB.prepare(
    `SELECT id, name, kind, price_minor, currency, licence_limit, term_days, monthly_quota_gb,
       traffic_gb, validity_days, line_ids, up_mbps, down_mbps, sales_channels,
       store_product_id, sort_order, status, visibility, retired_at, trial, created_at,
       updated_at
     FROM plans WHERE status = 'active' ORDER BY sort_order, id`,
  ).all<Parameters<typeof rowToPlan>[0]>();
  return (rows.results ?? []).map(rowToPlan);
}

export async function placeIapOrder(env: Env, input: Input): Promise<IapResult> {
  const now = input.now ?? new Date();
  const platform = input.platform === "apple" || input.platform === "google" ? input.platform : null;
  if (!platform) return { ok: false, status: 400, code: "invalid_request", message: "platform 只能是 apple / google" };
  if (!input.productId) return { ok: false, status: 400, code: "invalid_request", message: "product_id 必填" };
  if (!input.receipt) return { ok: false, status: 400, code: "invalid_request", message: "receipt 必填" };

  const channel = await channelConfig(env, platform);
  if ("error" in channel) {
    const map: Record<string, [number, string, string]> = {
      not_configured: [503, "service_unavailable", "这个实例还没配置商店渠道"],
      not_live: [503, "service_unavailable", "商店渠道还没启用"],
      no_secret: [503, "service_unavailable", "商店渠道缺少凭据"],
      bad_secret: [503, "service_unavailable", "商店凭据无法解析"],
    };
    const [status, code, message] = map[channel.error] ?? [
      503,
      "service_unavailable",
      "商店渠道不可用",
    ];
    return { ok: false, status, code, message };
  }
  // 生产实例收到沙盒凭据一律拒（沙盒凭据可伪造，契约 §2.4.3 ③）
  if (channel.environment === "production" && String(env.ENVIRONMENT ?? "") === "production") {
    // 具体判定在拿到 purchase.environment 之后，这里只保证配置正确
  }

  // ── 1. 回源 ──
  const verified =
    platform === "apple"
      ? await verifyApplePurchase(channel, input.receipt, { fetch: input.fetch, now })
      : await verifyGooglePurchase(channel, input.productId, input.receipt, {
          fetch: input.fetch,
          now,
        });
  if (!verified.ok) {
    return { ok: false, status: 422, code: verified.code, message: verified.message };
  }
  const purchase: VerifiedPurchase = verified.purchase;

  // ── 2. 校验 ──
  if (purchase.revoked) {
    return { ok: false, status: 422, code: "invalid_receipt", message: "这笔交易已退款/撤销" };
  }
  if (purchase.environment === "sandbox" && channel.environment !== "sandbox") {
    return { ok: false, status: 422, code: "sandbox_rejected", message: "生产实例不接受沙盒凭据" };
  }

  const plans = await loadActivePlans(env);
  const plan = plans.find((p: Plan) => {
    const kv = p.store_product_id ?? {};
    return (kv as Record<string, string | undefined>)[platform] === purchase.productId;
  });
  if (!plan) {
    return { ok: false, status: 422, code: "product_mismatch", message: "这个商品号没有对应的套餐" };
  }

  // 人是对的：凭据里的账号绑定值必须等于当前登录用户的 uuid（契约 §2.4.3 ③）
  if (!purchase.accountToken || purchase.accountToken !== input.customerUuid.toLowerCase()) {
    return { ok: false, status: 403, code: "account_mismatch", message: "这笔购买属于另一个账号" };
  }

  // ── 3. 落单（幂等键 = platform:事务号）──
  const iapKey = `${platform}:${purchase.transactionId}`;
  const existing = await env.DB.prepare(
    `SELECT id, code, customer_id, status FROM orders WHERE iap_key = ?`,
  )
    .bind(iapKey)
    .first<{ id: number; code: string; customer_id: number; status: string }>();

  if (existing) {
    if (existing.customer_id !== input.customerId) {
      return {
        ok: false,
        status: 409,
        code: "receipt_already_used",
        message: "这笔购买已经绑到另一个账号，请登录原账号",
      };
    }
    return await resultFor(env, existing.id);
  }

  const iso = now.toISOString();
  const amountMinor = purchase.amountMinor ?? plan.price_minor;
  const currency = purchase.currency ?? plan.currency;
  const code = orderCode(now);
  const inserted = await env.DB.prepare(
    `INSERT INTO orders (code, customer_id, plan_id, kind, plan_snapshot, amount_minor,
       discount_minor, promotion_id, code_id, entry, source, payment_method, gateway_id,
       provider_order_no, provider_trade_no, raw_create, iap_key, expires_at, status,
       created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, 0, NULL, NULL, 'app', 'iap', ?, NULL, ?, ?, ?, ?, NULL,
       'pending', ?, ?)`,
  )
    .bind(
      code,
      input.customerId,
      plan.id,
      plan.kind,
      JSON.stringify(plan),
      amountMinor,
      platform,
      purchase.transactionId,
      purchase.transactionId,
      purchase.raw.slice(0, 20000),
      iapKey,
      iso,
      iso,
    )
    .run();

  const orderId = Number(inserted.meta.last_row_id ?? 0);

  // Google 的"待处理"（家长审批 / 延迟入账）：落成 pending，等客户端重试
  if (platform === "google" && purchase.raw.includes('"purchaseState":2')) {
    return { ok: true, orderCode: code, status: "pending", customerId: input.customerId };
  }

  // ── 4. 结算：与网页轨道**同一个**函数（不允许为内购另写一套发货）──
  const order = await env.DB.prepare(
    `SELECT id, code, customer_id, plan_id, plan_snapshot, amount_minor, discount_minor,
       promotion_id, code_id, currency, payment_method, gateway_id, status, source,
       provider_order_no, created_at, updated_at, expires_at
     FROM orders WHERE id = ?`,
  )
    .bind(orderId)
    .first<PayableOrder>();
  if (order) {
    await settlePaidOrder(env, order, purchase.transactionId, purchase.raw);
  }

  // ── 5. 收尾：Google 必须由 CRM consume（漏了 3 天自动退款）──
  if (platform === "google") {
    await consumeGooglePurchase(channel, purchase.productId, input.receipt, {
      fetch: input.fetch,
      now,
    });
  }

  return await resultFor(env, orderId);
}

/** 把订单状态收敛成契约里的两个值（订阅快照由调用方拼，避免把视图函数搬来搬去） */
async function resultFor(env: Env, orderId: number): Promise<IapResult> {
  const row = await env.DB.prepare(
    `SELECT code, status, customer_id FROM orders WHERE id = ?`,
  )
    .bind(orderId)
    .first<{ code: string; status: string; customer_id: number }>();
  if (!row) {
    return { ok: false, status: 500, code: "service_unavailable", message: "订单落库后读不到" };
  }
  return {
    ok: true,
    orderCode: row.code,
    status: row.status === "pending" ? "pending" : "paid",
    customerId: row.customer_id,
  };
}
