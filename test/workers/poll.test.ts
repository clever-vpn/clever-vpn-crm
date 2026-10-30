/**
 * 主动查单（`src/payments/poll.ts`）—— **钱的唯一真相**
 *
 * 覆盖三种结局 + 一条"查不了"的路径：
 *   1. 查单说已付 ⇒ 订单 paid→active，订阅真的发出来（走与回调**完全相同**的发放链路）
 *   2. 查单说未付 + 已过 `expires_at` ⇒ `expired`，**并且不再主动查单**
 *   3. 查单说失败（终态）⇒ `closed`
 *   4. 网关没有查单接口 ⇒ 原样留着，只计数 `no_query`
 *
 * 另外钉住两条**边界**（都是明确决定，别改回去）：
 *   - **退避**：按订单年龄查（0–10min/2min、10–30/5min、30–60/10min），不是死查；
 *   - **过期即停**：过了支付窗口就不再问网关，兜底只剩回调 + 后台人工「查一次」。
 *
 * 这些用例的意义：**回调丢了也不会丢钱**。以前只有回调一条路，回调一丢订单就永远
 * 停在 pending。
 */
import { beforeAll, describe, expect, it } from "vitest";

import { encryptSecret } from "../../src/payments/secret";
import { POLL_BACKOFF, nextPollAt, pollPendingOrders } from "../../src/payments/poll";
import { ORDER_TTL_MINUTES } from "../../src/payments/checkout";
import { env } from "./apply-migrations";
import { installFakeCfApi } from "./fake-cf-api";

const now = () => new Date().toISOString();
const minutesAgo = (m: number) => new Date(Date.now() - m * 60_000).toISOString();
const minutesAhead = (m: number) => new Date(Date.now() + m * 60_000).toISOString();

/** 一份带查单接口的最小映射（`generic_json_v1`） */
const MAPPING = {
  create: { path: "/pay" },
  fields: { merchant: "mch", order_no: "out_trade_no", amount: "amount" },
  amount_unit: "cent",
  response: { ok: { path: "code", equals: 0 }, pay_url: "url" },
  notify: {
    order_no: "out_trade_no",
    paid_when: { path: "status", equals: "ok" },
    reply: "ok",
  },
  query: {
    path: "/query",
    fields: { out_trade_no: "{order_no}" },
    sign: "none",
    paid_when: { path: "status", equals: "paid" },
    terminal_when: { path: "status", equals: "failed" },
    amount: "amount",
  },
};

const PLAN_SNAPSHOT = {
  id: "poll_plan_30d",
  name: "月付 · 查单测试",
  kind: "period",
  price_minor: 1500,
  currency: "CNY",
  licence_limit: 1,
  term_days: 30,
  monthly_quota_gb: 100,
  traffic_gb: null,
  validity_days: null,
  line_ids: [],
  sales_channels: [{ channel: "web_checkout", methods: ["alipay"] }],
  store_product_id: null,
};

let gatewayId = 0;
let noQueryGatewayId = 0;
let customerId = 0;
let seq = 0;

/** 直接落一条 pending 订单（跳过下单，专注查单） */
async function seedPending(opts: {
  gateway: number;
  expiresAt: string;
  amountMinor?: number;
}): Promise<string> {
  seq += 1;
  const code = `ORDPOLL${String(seq).padStart(4, "0")}`;
  await env.DB.prepare(
    `INSERT INTO orders (code, customer_id, plan_id, kind, plan_snapshot, amount_minor, currency,
       payment_method, gateway_id, provider_order_no, status, expires_at, created_at, updated_at)
     VALUES (?, ?, 'poll_plan_30d', 'period', ?, ?, 'CNY', 'alipay', ?, ?, 'pending', ?, ?, ?)`,
  )
    .bind(
      code,
      customerId,
      JSON.stringify(PLAN_SNAPSHOT),
      opts.amountMinor ?? 1500,
      opts.gateway,
      code,
      opts.expiresAt,
      // 超过 20 秒的"最小年龄"才算进扫描集合
      minutesAgo(2),
      minutesAgo(2),
    )
    .run();
  return code;
}

async function orderOf(code: string): Promise<{ status: string; note: string | null }> {
  const row = await env.DB.prepare(`SELECT status, note FROM orders WHERE code = ?`)
    .bind(code)
    .first<{ status: string; note: string | null }>();
  if (!row) throw new Error(`订单不存在：${code}`);
  return row;
}

/** 假网关响应：只关心 `status` / `amount` */
const fakeFetch = (payload: unknown) =>
  (async () =>
    new Response(JSON.stringify(payload), {
      status: 200,
      headers: { "content-type": "application/json" },
    })) as unknown as typeof fetch;

beforeAll(async () => {
  const cfApi = installFakeCfApi();
  (env as unknown as Record<string, unknown>).CF_API_BASE = cfApi.base;
  (env as unknown as Record<string, unknown>).CF_API_TOKEN = cfApi.token;

  const secret = await encryptSecret(env, "poll-secret");
  const withQuery = await env.DB.prepare(
    `INSERT INTO payment_gateways (driver, name, endpoint, merchant_id, secret_enc, methods,
       mapping, priority, status, currency, created_at, updated_at)
     VALUES ('generic_json_v1', '查单网关', 'https://pay.test', 'mch', ?, '["alipay"]', ?, 1,
       'live', 'CNY', ?, ?)`,
  )
    .bind(secret, JSON.stringify(MAPPING), now(), now())
    .run();
  gatewayId = Number(withQuery.meta.last_row_id ?? 0);

  // 没有查单接口的网关（虎皮椒那种）
  const withoutQuery = await env.DB.prepare(
    `INSERT INTO payment_gateways (driver, name, endpoint, merchant_id, secret_enc, methods,
       mapping, priority, status, currency, created_at, updated_at)
     VALUES ('generic_json_v1', '无查单网关', 'https://pay2.test', 'mch', ?, '["alipay"]', ?, 2,
       'live', 'CNY', ?, ?)`,
  )
    .bind(
      secret,
      JSON.stringify({ ...MAPPING, query: undefined }),
      now(),
      now(),
    )
    .run();
  noQueryGatewayId = Number(withoutQuery.meta.last_row_id ?? 0);

  const cust = await env.DB.prepare(
    `INSERT INTO customers (email, status, created_at) VALUES ('poll@test.com', 'active', ?)`,
  )
    .bind(now())
    .run();
  customerId = Number(cust.meta.last_row_id ?? 0);
});

describe("cron 兜底查单", () => {
  it("查单说已付 ⇒ 发放权益（回调丢了也照发）", async () => {
    const code = await seedPending({ gateway: gatewayId, expiresAt: minutesAhead(10) });

    const report = await pollPendingOrders(env, {
      fetch: fakeFetch({ status: "paid", amount: 1500, trade_no: "T-1" }),
    });

    expect(report.paid).toBeGreaterThanOrEqual(1);
    const row = await orderOf(code);
    expect(["paid", "provisioning", "active"]).toContain(row.status);

    // 订阅真的发出来了
    const sub = await env.DB.prepare(`SELECT plan_id FROM platform_subscriptions WHERE customer_id = ?`)
      .bind(customerId)
      .first<{ plan_id: string }>();
    expect(sub?.plan_id).toBe("poll_plan_30d");
  });

  it("查单说未付且已超时 ⇒ expired（不删单、留证据）", async () => {
    const code = await seedPending({ gateway: gatewayId, expiresAt: minutesAgo(1) });

    await pollPendingOrders(env, { fetch: fakeFetch({ status: "waiting", amount: 1500 }) });

    const row = await orderOf(code);
    expect(row.status).toBe("expired");
  });

  it("查单说失败（终态）⇒ closed，并记下原因", async () => {
    const code = await seedPending({ gateway: gatewayId, expiresAt: minutesAhead(10) });

    await pollPendingOrders(env, { fetch: fakeFetch({ status: "failed", amount: 1500 }) });

    const row = await orderOf(code);
    expect(row.status).toBe("closed");
    expect(row.note).toContain("失败");
  });

  it("金额不符 ⇒ 不认账（订单保持 pending）", async () => {
    const code = await seedPending({ gateway: gatewayId, expiresAt: minutesAhead(10) });

    const report = await pollPendingOrders(env, {
      fetch: fakeFetch({ status: "paid", amount: 1 }),
    });

    expect(report.paid).toBe(0);
    expect((await orderOf(code)).status).toBe("pending");
  });

  it("网关没有查单接口 ⇒ 跳过并计数，不置过期", async () => {
    const code = await seedPending({ gateway: noQueryGatewayId, expiresAt: minutesAhead(10) });

    const report = await pollPendingOrders(env, {
      fetch: fakeFetch({ status: "paid", amount: 1500 }),
    });

    expect(report.no_query).toBeGreaterThanOrEqual(1);
    expect((await orderOf(code)).status).toBe("pending");
  });
});

describe("退避与边界", () => {
  it("支付窗口是 60 分钟（TTL）", () => {
    expect(ORDER_TTL_MINUTES).toBe(60);
  });

  it("曲线：前 10 分钟每 2 分钟，10–30 每 5 分钟，30–60 每 10 分钟，之后就停", () => {
    const now = new Date("2026-10-30T12:00:00.000Z");
    const at = (ageMin: number) =>
      nextPollAt(new Date(now.getTime() - ageMin * 60_000).toISOString(), now);

    const every = (ageMin: number) => {
      const next = at(ageMin);
      return next ? Math.round((Date.parse(next) - now.getTime()) / 60_000) : null;
    };

    expect(every(1)).toBe(2);
    expect(every(9)).toBe(2);
    expect(every(15)).toBe(5);
    expect(every(29)).toBe(5);
    expect(every(45)).toBe(10);
    expect(every(59)).toBe(10);
    // 过了支付窗口 ⇒ 不再排（null）
    expect(at(60)).toBeNull();
    expect(at(120)).toBeNull();
    expect(POLL_BACKOFF).toHaveLength(3);
  });

  it("查过一次就排下一轮，并记下次数", async () => {
    const code = await seedPending({ gateway: gatewayId, expiresAt: minutesAhead(55) });

    await pollPendingOrders(env, { fetch: fakeFetch({ status: "waiting", amount: 1500 }) });

    const row = await env.DB.prepare(
      `SELECT next_poll_at, poll_attempts FROM orders WHERE code = ?`,
    )
      .bind(code)
      .first<{ next_poll_at: string | null; poll_attempts: number }>();
    expect(row!.poll_attempts).toBe(1);
    expect(row!.next_poll_at).toBeTruthy();
    // 刚建的单一律落在"前 10 分钟"段 ⇒ 2 分钟后
    const gapMin = Math.round((Date.parse(row!.next_poll_at!) - Date.now()) / 60_000);
    expect(gapMin).toBeLessThanOrEqual(2);
    expect(gapMin).toBeGreaterThanOrEqual(1);
  });

  it("没到 next_poll_at 的单不会被查（退避真的生效，不是每轮都问）", async () => {
    const code = await seedPending({ gateway: gatewayId, expiresAt: minutesAhead(55) });
    await pollPendingOrders(env, { fetch: fakeFetch({ status: "waiting", amount: 1500 }) });

    const again = await pollPendingOrders(env, { fetch: fakeFetch({ status: "waiting" }) });
    expect(again.scanned).toBe(0);
    expect((await orderOf(code)).status).toBe("pending");
  });

  it("过期即停：置 expired 后 next_poll_at 被清空，之后一轮也扫不到它", async () => {
    const code = await seedPending({ gateway: gatewayId, expiresAt: minutesAgo(1) });

    await pollPendingOrders(env, { fetch: fakeFetch({ status: "waiting", amount: 1500 }) });

    const row = await env.DB.prepare(
      `SELECT status, next_poll_at FROM orders WHERE code = ?`,
    )
      .bind(code)
      .first<{ status: string; next_poll_at: string | null }>();
    expect(row!.status).toBe("expired");
    expect(row!.next_poll_at).toBeNull();

    const again = await pollPendingOrders(env, { fetch: fakeFetch({ status: "paid", amount: 1500 }) });
    expect(again.scanned).toBe(0);
  });

  it("过期后钱到了仍然记帐（回调/人工查单走同一条路）", async () => {
    const code = await seedPending({ gateway: gatewayId, expiresAt: minutesAgo(5) });
    // 先让它过期
    await pollPendingOrders(env, { fetch: fakeFetch({ status: "waiting", amount: 1500 }) });
    expect((await orderOf(code)).status).toBe("expired");

    // 人工「查一次」：钱其实到了
    const { pollOrderOnce } = await import("../../src/payments/poll");
    const res = await pollOrderOnce(env, code, {
      fetch: fakeFetch({ status: "paid", amount: 1500 }),
    });
    expect(res?.status).toBe("paid");
    expect(["paid", "provisioning", "active"]).toContain((await orderOf(code)).status);
  });
});
