/**
 * 商店回调（ASSN V2 / RTDN）—— **只当触发器**
 *
 * 与网关回调同一条原则：通知到达后**立刻回源查一次**，查不到钱就什么都不发生。
 * 所以这里不验签：我们只用通知里的"事务号"去定位订单，然后向 Apple / Google
 * 重新查这笔交易的真实状态。伪造一个通知最多让我们白查一次。
 *
 * 两个路径都**永远回 200**（除报文本身无法解析）：非 200 会让商店无限重投。
 */
import { verifyApplePurchase, verifyGooglePurchase } from "../payments/iap";
import { refundIapOrder } from "../payments/refund";
import { decryptSecret } from "../payments/secret";
import { loadStoreChannel } from "../payments/store-channels";

import type { Env } from "../env";
import type { StoreChannelConfig, StoreSecret } from "../payments/iap";

const b64url = (text: string): string =>
  btoa(text).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

function decodeJwsPayload(jws: string): Record<string, unknown> | null {
  const parts = jws.split(".");
  if (parts.length < 2) return null;
  try {
    const pad = (parts[1] ?? "").length % 4 === 0 ? "" : "=".repeat(4 - ((parts[1] ?? "").length % 4));
    const raw = atob((parts[1] ?? "").replace(/-/g, "+").replace(/_/g, "/") + pad);
    return JSON.parse(raw) as Record<string, unknown>;
  } catch {
    return null;
  }
}

async function channel(env: Env, platform: "apple" | "google"): Promise<StoreChannelConfig | null> {
  const row = await loadStoreChannel(env, platform);
  if (!row || row.status !== "live") return null;
  const plain = await decryptSecret(env, row.secret_enc);
  if (!plain) return null;
  try {
    return {
      platform,
      endpoint: (row.endpoint || "").replace(/\/+$/, ""),
      identifier: row.identifier,
      environment: row.environment,
      secret: JSON.parse(plain) as StoreSecret,
    };
  } catch {
    return null;
  }
}

function ok(body: unknown = { ok: true }): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json; charset=utf-8" },
  });
}

/** Apple ASSN V2：`{ signedPayload }` */
async function handleAppleAssn(env: Env, request: Request): Promise<Response> {
  const body = (await request.json().catch(() => null)) as { signedPayload?: string } | null;
  if (!body?.signedPayload) return new Response("bad payload", { status: 400 });

  const outer = decodeJwsPayload(body.signedPayload);
  const type = String(outer?.notificationType ?? "");
  // 只关心"钱被退回去"的两类；其它（SUBSCRIBED / DID_RENEW…）在本模型里不存在
  if (type !== "REFUND" && type !== "REVOKE") return ok({ ignored: type || "unknown" });

  const data = (outer?.data ?? {}) as { signedTransactionInfo?: string };
  const info = data.signedTransactionInfo ? decodeJwsPayload(data.signedTransactionInfo) : null;
  const transactionId = String(info?.transactionId ?? "").trim();
  if (!transactionId) return ok({ ignored: "no_transaction" });

  const ch = await channel(env, "apple");
  if (!ch) return ok({ ignored: "channel_not_live" });

  // 回源：把通知里的 transactionId 当成"查单键"，真伪由 Apple 说了算
  const fakeReceipt = `h.${b64url(JSON.stringify({ transactionId }))}.s`;
  const verified = await verifyApplePurchase(ch, fakeReceipt);
  if (!verified.ok) return ok({ ignored: verified.code });
  if (!verified.purchase.revoked) return ok({ ignored: "not_revoked" });

  const result = await refundIapOrder(env, {
    iapKey: `apple:${verified.purchase.transactionId}`,
    reason: `stores:apple:${type}`,
  });
  return ok({ result });
}

/** Google RTDN：Pub/Sub push，`message.data` 是 base64 的 JSON */
async function handleGoogleRtdn(env: Env, request: Request): Promise<Response> {
  const body = (await request.json().catch(() => null)) as
    | { message?: { data?: string } }
    | null;
  const encoded = body?.message?.data;
  if (!encoded) return new Response("bad payload", { status: 400 });

  let inner: Record<string, unknown>;
  try {
    inner = JSON.parse(atob(encoded)) as Record<string, unknown>;
  } catch {
    return new Response("bad payload", { status: 400 });
  }

  const oneTime = (inner.oneTimeProductNotification ?? {}) as {
    purchaseToken?: string;
    notificationType?: number;
  };
  const token = String(oneTime.purchaseToken ?? "").trim();
  if (!token) return ok({ ignored: "no_token" });
  // 1 = ONE_TIME_PRODUCT_PURCHASED，2 = ONE_TIME_PRODUCT_CANCELED
  if (Number(oneTime.notificationType ?? 0) !== 2) {
    return ok({ ignored: `type_${String(oneTime.notificationType ?? "")}` });
  }

  const order = await env.DB.prepare(
    `SELECT plan_snapshot FROM orders WHERE iap_key = ?`,
  )
    .bind(`google:${token}`)
    .first<{ plan_snapshot: string | null }>();
  if (!order?.plan_snapshot) return ok({ ignored: "no_order" });

  const ch = await channel(env, "google");
  if (!ch) return ok({ ignored: "channel_not_live" });

  let productId = "";
  try {
    const plan = JSON.parse(order.plan_snapshot) as { store_product_id?: Record<string, string> };
    productId = plan.store_product_id?.google ?? "";
  } catch {
    return ok({ ignored: "bad_snapshot" });
  }
  if (!productId) return ok({ ignored: "no_product" });

  const verified = await verifyGooglePurchase(ch, productId, token);
  if (!verified.ok) return ok({ ignored: verified.code });
  if (!verified.purchase.revoked) return ok({ ignored: "not_revoked" });

  const result = await refundIapOrder(env, {
    iapKey: `google:${token}`,
    reason: "stores:google:CANCELED",
  });
  return ok({ result });
}

export async function handleWebhooks(env: Env, request: Request): Promise<Response | null> {
  if (request.method !== "POST") return null;
  const path = new URL(request.url).pathname;
  if (path === "/api/app/v1/webhooks/apple/assn") return handleAppleAssn(env, request);
  if (path === "/api/app/v1/webhooks/google/rtdn") return handleGoogleRtdn(env, request);
  return null;
}
