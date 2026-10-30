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
import { provisionOrder } from "../platform/provision";
import { rewardReferrer } from "../promotions/referral";
import { grantSignupGifts } from "../promotions/triggers";
import { redeemOrderPromotion } from "../promotions/service";
import { customerSubscription, freshenTraffic, logChange, upsertSubscription } from "../subscriptions/store";
import {
  isOver,
  renewSubscription,
  subscriptionFromPlan,
  upgradeSubscription,
} from "../plans/subscription";

import type { Env } from "../env";
import type { GatewayRow } from "./gateways";
import type { Plan } from "../plans/model";
import type { Subscription } from "../plans/subscription";

interface OrderRow {
  id: number;
  code: string;
  customer_id: number;
  plan_id: string;
  plan_snapshot: string;
  amount_minor: number;
  /** 促销减免（分）与命中的活动；支付成功后才核销 */
  discount_minor: number;
  promotion_id: number | null;
  code_id: number | null;
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
    // 一个客户只有一行订阅（domain.md §1.2），所以发放 = "算出新快照 → 覆盖这一行"。
    // 动作只看两件事：这份订阅还在不在、是不是同一个套餐。
    const before = await customerSubscription(env, order.customer_id);
    const paid = order.amount_minor;
    let action: "new" | "renewal" | "upgrade" | "addon";
    let next: Subscription;

    if (plan.kind === "addon") {
      // 加购包不产生订阅，只往池子里加 GB（应付里也不含它）
      if (!before) throw new Error("加购包需要一条已存在的订阅");
      action = "addon";
      // 加量 = 往平台余额上加数，**必须**先拿平台的真实剩余：
      // 用 15 分钟前的缓存会把用户这段时间用掉的流量又还回去。
      // 读不到就抛 —— 订单留在 provisioning，由重试任务重做，宁可晚开不可错写。
      const freshened = before.platform_customer_id
        ? await freshenTraffic(env, before, { now })
        : before;
      if (!freshened) throw new Error("读不到平台余额，加量包暂不能落账");
      next = renewSubscription(freshened, plan, { paidMinor: paid, now });
    } else if (before && !isOver(before, now) && before.plan_id === plan.id) {
      // 续订：同一个套餐再来一份，全款，到期日顺延
      action = "renewal";
      next = renewSubscription(before, plan, { paidMinor: paid, now });
    } else if (before && !isOver(before, now)) {
      // 升级：换成别的套餐（可跨 kind），旧残值已在报价里抵扣
      action = "upgrade";
      next = upgradeSubscription(before, plan, { paidMinor: paid, now });
    } else if (before) {
      // 上一次已经结束（到期 / 作废）：按新购重开。hold 保留，付款不解冻。
      action = "new";
      next = upgradeSubscription(before, plan, { paidMinor: paid, now });
    } else {
      action = "new";
      next = { ...subscriptionFromPlan(plan, { customerId: order.customer_id, paidMinor: paid, now }), id: 0 };
    }

    // `order_id` 只记“最初让这份权益生效”的那笔单：续费/升级/加量都不覆盖它（那些在台账里）
    if (action === "new") next.order_id = order.id;

    const subscriptionId = await upsertSubscription(env, next);
    await logChange(env, {
      customer_id: order.customer_id,
      subscription_id: subscriptionId,
      action,
      before,
      after: { ...next, id: subscriptionId },
      paid_minor: paid,
      residual_minor: action === "upgrade" ? Math.max(0, plan.price_minor - paid) : null,
      detail: { order_id: order.id, order_code: order.code, plan_id: plan.id, kind: plan.kind },
    });
    await env.DB.prepare(
      // 先记关联，再落账：落账失败时订单停在 provisioning，cron 只重做这一步
      `UPDATE orders SET subscription_id = ?, updated_at = ? WHERE id = ?`,
    )
      .bind(subscriptionId, now.toISOString(), order.id)
      .run();

    // ── 促销核销 + 邀请奖励（都**必须**在钱到账之后）──
    // 独立 try：这两步失败不能把订单拖成"发放失败"（权益已经给了）
    try {
      await redeemOrderPromotion(env, order, now);
      await rewardReferrer(env, { referredCustomerId: order.customer_id, orderId: order.id, now });
    } catch (e) {
      console.error(`[promo] 核销/发奖失败 order=${order.code}: ${e instanceof Error ? e.message : e}`);
    }

    await provisionOrder(env, order.id);

    // ── 注册礼包（`audience='new'` 的礼包）──
    // 必须在**开通之后**：新客还没有订阅，天数/流量无处可放。
    // 这里已经有钱到账，礼包失败绝不能影响订单结论。
    try {
      const gifts = await grantSignupGifts(env, order.customer_id, now);
      const done = gifts.filter((g) => g.granted).length;
      const pending = gifts.filter((g) => g.pending).length;
      if (done || pending) {
        console.log(
          `[gift] 注册礼包已发 customer=${order.customer_id} 到账=${done} 待领取=${pending}`,
        );
      }
    } catch (e) {
      console.error(`[gift] 注册礼包失败 order=${order.code}: ${e instanceof Error ? e.message : e}`);
    }
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
  deps: { fetch?: typeof fetch } = {},
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

  const secret = await gatewaySecret(env, gateway);
  if (!secret) {
    // 密钥解不开 ⇒ 无法验签，绝不"先记上再补"
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
    `SELECT id, code, customer_id, plan_id, plan_snapshot, amount_minor, discount_minor,
       promotion_id, code_id, currency, payment_method, gateway_id, status
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
    const doFetch = deps.fetch ?? fetch;
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
      const res = await doFetch(qreq.url, {
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
