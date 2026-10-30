/**
 * 主动查单：**钱的唯一真相来源**
 *
 * `docs/payments.md` §3.1 的第 1 条铁律是"回调不判定已付" —— 回调只当**触发器**。
 * 但触发器会丢（对方重试到放弃、`notify_url` 一时不可达、Worker 恰好抖动），
 * 所以触发器之外必须有一台**自己的**时钟去问。这台时钟就是 cron。
 *
 * ## 三条边界（都是明确决定，别改回去）
 *
 * 1. **只在 60 分钟的支付窗口内查**（`ORDER_TTL_MINUTES`）。窗口内按退避曲线查；
 *    到点还没查到钱 ⇒ 置 `expired`，**之后一律不再问网关**。
 * 2. **过期之后只等回调**：钱晚到了照样转 `paid`（`settlePaidOrder` 接受 `expired`），
 *    但不再由我们主动去问 —— 兜底交给后台的「查一次」按钮（人工）。
 * 3. **用户请求不打网关**：`GET /orders/:code` 只读我们自己的库。否则 100 个人同时
 *    刷新就等于 100 次/5 秒的查单风暴，网关会被我们打坏。
 *
 * ## 退避曲线（按**订单年龄**算，不按次数）
 *
 * | 年龄 | 间隔 | 为什么 |
 * |---|---|---|
 * | 0–10 min | 2 min | 用户正盯着页面，最可能刚付完 |
 * | 10–30 min | 5 min | 还在收银台犹豫的人 |
 * | 30–60 min | 10 min | 非典型付款，只有零星延迟回调 |
 * | ≥ 60 min | 停 | 置 `expired`，转人工 + 回调兜底 |
 *
 * 一单约 12 次查询（死查 2 分钟 = 30 次），省下的是**网关的 QPS**：
 * 一天 100 个"点了支付又放弃"的单，就是 1800 次 vs 3000 次真实的网关请求。
 *
 * ## 与商店内购（Apple / Google）的关系
 *
 * 商店轨道**没有"下单"这一步**（支付在 App 里由 StoreKit / Play Billing 发起），
 * 但**收款确认是同一件事**：拿 `purchaseToken` / `transactionId` 去问商店
 * "这笔钱到了吗"。所以商店网关只是"没有 create、只有 query"的网关，本模块一视同仁
 * （见 `docs/payments.md` §10）。
 */
import { gatewaySecret } from "./checkout";
import { GATEWAY_COLUMNS, mappingOf } from "./gateways";
import { buildQueryRequest, hasQuery, parseQueryResponse } from "./mapping";
import { PAYABLE_COLUMNS, markGatewayResult, settlePaidOrder } from "./notify";

import type { Env } from "../env";
import type { GatewayRow } from "./gateways";
import type { PayableOrder } from "./notify";

/** 刚创建的单先不查：给它一次自然回调的机会，也避免与创建请求抢同一秒 */
export const POLL_MIN_AGE_SECONDS = 20;

/** 单批上限：一次 cron 别把整库扫完（免费版 subrequest 有数） */
export const POLL_BATCH = 50;

/**
 * 「不用再查」的哨兵值。
 *
 * 不能拿 NULL 表示"停止"：NULL 在取数条件里是"**还没查过**，现在就该查"，
 * 一旦用 NULL 表示停止，那一单每轮都会被重新捞起来（永远问网关）。
 */
const POLL_STOPPED = "9999-12-31T23:59:59.000Z";

/** 支付窗口（分钟）：与 `ORDER_TTL_MINUTES` 同源，超出这个年龄就不再主动查 */
export const POLL_WINDOW_MINUTES = 60;

/**
 * 退避曲线：`untilMin` = 这个年龄段的**上界**，`everyMin` = 该段里每隔几分钟查一次。
 *
 * 按年龄（`created_at`）算而不是按"第几次"算，是因为**时间才是用户的实际等待**：
 * 按次数算会让"查单失败重试"额外多查几次，把曲线搞成不可预期。
 */
export const POLL_BACKOFF: readonly { untilMin: number; everyMin: number }[] = [
  { untilMin: 10, everyMin: 2 },
  { untilMin: 30, everyMin: 5 },
  { untilMin: 60, everyMin: 10 },
];

/**
 * 下一次该查的时间；`null` = **不再查**（已过支付窗口）。
 *
 * @param createdAt 订单创建时间（ISO）
 * @param now       当前时间
 */
export function nextPollAt(createdAt: string, now: Date): string | null {
  const ageMin = (now.getTime() - Date.parse(createdAt)) / 60_000;
  for (const band of POLL_BACKOFF) {
    if (ageMin < band.untilMin) {
      return new Date(now.getTime() + band.everyMin * 60_000).toISOString();
    }
  }
  return null;
}

export type PollVerdict = "paid" | "pending" | "terminal" | "no_query" | "error";

export interface PollReport {
  scanned: number;
  paid: number;
  terminal: number;
  expired: number;
  /** 网关没有查单接口（只能靠回调）—— 计入但不告警风暴 */
  no_query: number;
  failed: number;
  errors: string[];
}

const EMPTY_REPORT = (): PollReport => ({
  scanned: 0,
  paid: 0,
  terminal: 0,
  expired: 0,
  no_query: 0,
  failed: 0,
  errors: [],
});

interface QueryOutcome {
  verdict: PollVerdict;
  tradeNo: string | null;
  message?: string;
  /** 原始响应（截断后落 `raw_notify`，作为"这次查到了什么"的证据） */
  raw: string | null;
}

/**
 * 查一次单并**落账**（不做任何"是否该查"的判断）。
 *
 * - `paid` 且金额一致 ⇒ 走与回调完全相同的发放链路（`settlePaidOrder`）；
 * - 判据里出现终态（失败/关闭/撤销）⇒ 订单转 `closed`；
 * - 查不到 ⇒ 交给调用方决定是否置过期。
 */
async function queryOnce(
  env: Env,
  order: PayableOrder,
  gateway: GatewayRow,
  deps: { fetch?: typeof fetch; now?: Date },
): Promise<QueryOutcome> {
  const mapping = mappingOf(gateway);
  if (!mapping || !hasQuery(mapping)) return { verdict: "no_query", tradeNo: null, raw: null };

  const secret = await gatewaySecret(env, gateway);
  if (!secret) {
    await markGatewayResult(env, gateway.id, null, "查单失败：网关密钥不可用");
    return { verdict: "error", tradeNo: null, message: "gateway_not_ready", raw: null };
  }

  const now = deps.now ?? new Date();
  const req = buildQueryRequest(mapping, {
    merchant: gateway.merchant_id ?? "",
    secret,
    orderNo: order.provider_order_no ?? order.code,
    amountMinor: order.amount_minor,
    subject: "",
    method: order.payment_method,
    endpoint: gateway.endpoint ?? "",
    now,
  });

  let text: string;
  try {
    const doFetch = deps.fetch ?? fetch;
    const res = await doFetch(req.url, {
      method: req.method,
      headers: req.headers,
      body: req.body,
      signal: AbortSignal.timeout(10_000),
    });
    text = await res.text();
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    await markGatewayResult(env, gateway.id, null, `查单失败：${msg}`);
    return { verdict: "error", tradeNo: null, message: msg, raw: null };
  }

  let payload: unknown;
  try {
    payload = JSON.parse(text) as unknown;
  } catch {
    await markGatewayResult(env, gateway.id, null, "查单失败：返回的不是 JSON");
    return { verdict: "error", tradeNo: null, message: "bad json", raw: text.slice(0, 2000) };
  }

  const q = parseQueryResponse(mapping, payload);
  const raw = text.slice(0, 4000);

  if (q.paid) {
    // 金额核对：查单说的钱必须等于下单金额。查单没给金额 ⇒ 只能认"已付"这个事实
    if (q.amountMinor !== null && q.amountMinor !== order.amount_minor) {
      const msg = `金额不符 order=${order.code} query=${q.amountMinor} expected=${order.amount_minor}`;
      await markGatewayResult(env, gateway.id, null, msg);
      return { verdict: "error", tradeNo: q.tradeNo, message: "amount_mismatch", raw };
    }
    await settlePaidOrder(env, order, q.tradeNo, raw, now);
    await markGatewayResult(env, gateway.id, now, null);
    return { verdict: "paid", tradeNo: q.tradeNo, raw };
  }

  if (q.terminal) {
    await closeOrder(env, order, q.message ?? "服务商判定失败", raw);
    return { verdict: "terminal", tradeNo: q.tradeNo, message: q.message, raw };
  }

  // 未付但不是终态：把最后一次查询结果留证（客服排查要看"到底查到什么"）
  await env.DB.prepare(
    `UPDATE orders SET raw_notify = ?, updated_at = ? WHERE id = ? AND status = 'pending'`,
  )
    .bind(raw, new Date().toISOString(), order.id)
    .run();
  return { verdict: "pending", tradeNo: q.tradeNo, raw };
}

async function closeOrder(
  env: Env,
  order: PayableOrder,
  reason: string,
  raw: string | null,
): Promise<void> {
  const now = new Date().toISOString();
  await env.DB.prepare(
    `UPDATE orders SET status = 'closed', note = ?, raw_notify = COALESCE(?, raw_notify),
       next_poll_at = NULL, updated_at = ?
      WHERE id = ? AND status IN ('pending', 'expired')`,
  )
    .bind(reason.slice(0, 200), raw, now, order.id)
    .run();
}

/**
 * 到点置过期，**并停止后续查单**（`next_poll_at = NULL`）。
 *
 * 只动 `pending`：`expired` 之后钱到了照样能转 `paid`（`settlePaidOrder` 接受两者），
 * 所以这**不是终局**，只是"我们不再主动问了"。
 */
async function expireIfDue(env: Env, order: PayableOrder, now: Date): Promise<boolean> {
  if (order.status !== "pending") return false;
  if (!order.expires_at || order.expires_at > now.toISOString()) return false;
  const r = await env.DB.prepare(
    `UPDATE orders SET status = 'expired', note = COALESCE(note, '支付超时未到账'),
       next_poll_at = NULL, updated_at = ?
      WHERE id = ? AND status = 'pending'`,
  )
    .bind(now.toISOString(), order.id)
    .run();
  return (r.meta.changes ?? 0) > 0;
}

/** 记下一次该查的时间 + 计一次数；`next` 传 `null` = 不再查 */
async function scheduleNextPoll(
  env: Env,
  order: PayableOrder,
  next: string | null,
  now: Date,
): Promise<void> {
  await env.DB.prepare(
    `UPDATE orders SET next_poll_at = ?, poll_attempts = poll_attempts + 1, updated_at = ?
      WHERE id = ?`,
  )
    .bind(next, now.toISOString(), order.id)
    .run();
}

/**
 * cron 兜底：把"到点该查"的 pending 单查一遍。
 *
 * 取数条件三件套：`pending` + 超过最小年龄（20 秒）+ 到了 `next_poll_at`。
 * **不包含过期单** —— 过了支付窗口就不再问网关，只等回调或人工。
 */
export async function pollPendingOrders(
  env: Env,
  deps: { fetch?: typeof fetch; now?: Date; limit?: number } = {},
): Promise<PollReport> {
  const now = deps.now ?? new Date();
  const report = EMPTY_REPORT();
  const minAge = new Date(now.getTime() - POLL_MIN_AGE_SECONDS * 1000).toISOString();

  const rows = await env.DB.prepare(
    `SELECT ${PAYABLE_COLUMNS}, raw_create FROM orders
      WHERE status = 'pending'
        AND created_at <= ?
        AND (next_poll_at IS NULL OR next_poll_at <= ?)
      ORDER BY next_poll_at IS NULL DESC, next_poll_at ASC, id ASC
      LIMIT ?`,
  )
    .bind(minAge, now.toISOString(), deps.limit ?? POLL_BATCH)
    .all<PayableOrder & { raw_create: string | null }>();

  const orders = rows.results ?? [];
  report.scanned = orders.length;
  if (!orders.length) return report;

  // 网关最多几十条，先整表读一次，避免每单一次查询
  const gwRows = await env.DB.prepare(
    `SELECT ${GATEWAY_COLUMNS} FROM payment_gateways`,
  ).all<GatewayRow>();
  const gwList = gwRows.results ?? [];

  for (const order of orders) {
    const gateway = order.gateway_id
      ? (gwList.find((g) => g.id === order.gateway_id) ?? null)
      : null;
    if (!gateway) {
      // 没有网关（人工补单 / 商店轨道还没接）：没什么可问的，也别一直排队
      report.no_query += 1;
      await scheduleNextPoll(env, order, POLL_STOPPED, now);
      continue;
    }

    const out = await queryOnce(env, order, gateway, { fetch: deps.fetch, now });
    switch (out.verdict) {
      case "paid":
        report.paid += 1;
        continue; // 已经付了：不再排下一轮
      case "terminal":
        report.terminal += 1;
        continue; // 终态：closeOrder 已清空 next_poll_at
      case "no_query":
        // 网关没有查单接口 ⇒ 只能等回调，不必来回排
        report.no_query += 1;
        await scheduleNextPoll(env, order, POLL_STOPPED, now);
        continue;
      case "error":
        report.failed += 1;
        if (out.message) report.errors.push(`${order.code}: ${out.message}`);
        break;
      case "pending":
        break;
    }

    // 还没查到钱：先判过期（到点就不等了），再排下一次
    if (await expireIfDue(env, order, now)) {
      report.expired += 1;
      continue;
    }
    // 过了支付窗口就不再自动查（这一轮之后只剩回调 + 人工）
    await scheduleNextPoll(env, order, nextPollAt(order.created_at, now) ?? POLL_STOPPED, now);
  }

  return report;
}

/**
 * 后台「查一次」：客服手动问网关一次（**唯一**的过期后兜底路径）。
 *
 * 与自动查单走同一段 `queryOnce`，判据完全一致；区别只是它不看 TTL、
 * 也不改 `next_poll_at`（人工操作不该影响自动节奏）。
 *
 * @returns `null` = 订单不存在；否则是这次查单的结论
 */
export async function pollOrderOnce(
  env: Env,
  orderCode: string,
  deps: { fetch?: typeof fetch; now?: Date } = {},
): Promise<{ status: string; verdict: PollVerdict } | null> {
  const now = deps.now ?? new Date();
  const row = await env.DB.prepare(`SELECT ${PAYABLE_COLUMNS} FROM orders WHERE code = ?`)
    .bind(orderCode)
    .first<PayableOrder>();
  if (!row) return null;

  const gateway = row.gateway_id
    ? await env.DB.prepare(`SELECT ${GATEWAY_COLUMNS} FROM payment_gateways WHERE id = ?`)
        .bind(row.gateway_id)
        .first<GatewayRow>()
    : null;
  if (!gateway) return { status: row.status, verdict: "no_query" };

  const out = await queryOnce(env, row, gateway, { fetch: deps.fetch, now });
  if (out.verdict === "paid") return { status: "paid", verdict: out.verdict };
  if (out.verdict === "terminal") return { status: "closed", verdict: out.verdict };
  return { status: row.status, verdict: out.verdict };
}
