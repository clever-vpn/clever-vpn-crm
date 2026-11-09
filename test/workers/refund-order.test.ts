/**
 * 第三方网关订单的退款：**钱在网关侧退，CRM 只记账 + 按残值调权益 + 推平台**。
 *
 * 三条口径钉死：
 *   1. 只能退"没用掉的那部分"（`R ≤ 残值`）—— 用了 80% 再来退 90% 必须被拒；
 *   2. 部分退款按比例缩期限/流量，**并且推到 cf-api**（否则客户端照旧用满）；
 *   3. 扣到 0 等价于终止：走 `revokeEntitlement`（本地 revoked + 平台 frozen=1）。
 *
 * `paid_minor` 全程不变 —— 它是"当初成交价"，残值公式的分母。
 */
import { beforeEach, describe, expect, it } from "vitest";

import { env } from "./apply-migrations";
import { installFakeCfApi } from "./fake-cf-api";
import { refundOrder } from "../../src/payments/refund";

const CUSTOMER = 1;
const PLATFORM_ID = 9101;
const DAY = 86_400_000;

/** 固定"现在"，让残值与折算都能算准 */
const NOW = new Date("2026-11-09T00:00:00.000Z");
const iso = (d: Date) => d.toISOString();

async function seed(opts: {
  paidMinor?: number;
  termDays?: number;
  kind?: "period" | "traffic";
  orderAmount?: number;
  status?: string;
  iapKey?: string | null;
}) {
  const paid = opts.paidMinor ?? 3000;
  const term = opts.termDays ?? 30;
  const isoNow = iso(NOW);
  await env.DB.prepare(
    `INSERT INTO customers (id, uuid, email, status, created_at)
     VALUES (?, lower(hex(randomblob(16))), 'refund@test.com', 'active', ?)`,
  )
    .bind(CUSTOMER, isoNow)
    .run();
  await env.DB.prepare(
    `INSERT INTO platform_subscriptions
       (customer_id, plan_id, kind, paid_minor, currency, licence_limit,
        period_term_days, period_quota_gb, traffic_total_gb, traffic_remaining_gb,
        platform_customer_id, expires_at, started_at, hold, created_at, updated_at)
     VALUES (?, 'p_30d', ?, ?, 'CNY', 1, ?, NULL, ?, ?, ?, ?, ?, 'none', ?, ?)`,
  )
    .bind(
      CUSTOMER,
      opts.kind ?? "period",
      paid,
      opts.kind === "traffic" ? null : term,
      opts.kind === "traffic" ? 100 : null,
      opts.kind === "traffic" ? 100 : null,
      PLATFORM_ID,
      opts.kind === "traffic" ? null : iso(new Date(NOW.getTime() + term * DAY)),
      isoNow,
      isoNow,
      isoNow,
    )
    .run();
  await env.DB.prepare(
    `INSERT INTO orders (code, customer_id, plan_id, kind, plan_snapshot, amount_minor,
       discount_minor, entry, source, payment_method, gateway_id, iap_key, status,
       paid_at, created_at, updated_at)
     VALUES ('ORD-REFUND-1', ?, 'p_30d', 'period', '{}', ?, 0, 'web', 'purchase',
       'alipay', 1, ?, ?, ?, ?, ?)`,
  )
    .bind(
      CUSTOMER,
      opts.orderAmount ?? paid,
      opts.iapKey === undefined ? null : opts.iapKey,
      opts.status ?? "active",
      isoNow,
      isoNow,
      isoNow,
    )
    .run();
}

function withPlatform() {
  const cf = installFakeCfApi();
  const e = env as unknown as Record<string, unknown>;
  e.CF_API_BASE = cf.base;
  e.CF_API_TOKEN = cf.token;
  cf.customers.set(PLATFORM_ID, {
    id: PLATFORM_ID,
    code: "C9101",
    name: "refund",
    email: "refund@test.com",
    auth_id: "a9101",
    licence_limit: 1,
    frozen: 0,
    expire_date: null,
    traffic_balance: null,
    quota: null,
    _is_deleted: 0,
  });
  return cf;
}

const subOf = () =>
  env.DB.prepare(
    `SELECT expires_at, traffic_remaining_gb, hold, paid_minor FROM platform_subscriptions WHERE customer_id = ?`,
  )
    .bind(CUSTOMER)
    .first<{
      expires_at: string | null;
      traffic_remaining_gb: number | null;
      hold: string;
      paid_minor: number;
    }>();

const orderOf = () =>
  env.DB.prepare(
    `SELECT status, refunded_minor, refund_mode FROM orders WHERE code = 'ORD-REFUND-1'`,
  ).first<{ status: string; refunded_minor: number; refund_mode: string }>();

beforeEach(async () => {
  await env.DB.prepare("DELETE FROM orders").run();
  await env.DB.prepare("DELETE FROM platform_subscriptions").run();
  await env.DB.prepare("DELETE FROM customers").run();
});

describe("部分退款：按残值缩权益并推平台", () => {
  it("付 3000 用 30 天，退 1000 ⇒ 剩 20 天，且 expire_date 推到平台", async () => {
    await seed({});
    const cf = withPlatform();
    try {
      const r = await refundOrder(env, {
        orderCode: "ORD-REFUND-1",
        amountMinor: 1000,
        reason: "客户投诉，退三分之一",
        gatewayRef: "RF-888",
        now: NOW,
      });
      expect(r).toMatchObject({
        ok: true,
        refundedMinor: 1000,
        totalRefundedMinor: 1000,
        voided: false,
        platformSynced: true,
      });
      expect(r.ok && r.remaining).toEqual({ days: 20 });

      // 本地：到期日缩到 20 天后；paid_minor 不动
      const sub = await subOf();
      expect(sub?.paid_minor).toBe(3000);
      expect(sub?.expires_at).toBe(iso(new Date(NOW.getTime() + 20 * DAY)));

      // 平台：expire_date 只有天，且**向下取整**
      const patch = cf.patches.find((p) => p.id === PLATFORM_ID);
      expect(patch?.body).toMatchObject({
        expire_date: new Date(NOW.getTime() + 20 * DAY).toISOString().slice(0, 10),
      });

      // 订单：部分退款不改变 status，只累计金额
      const order = await orderOf();
      expect(order).toMatchObject({
        status: "active",
        refunded_minor: 1000,
        refund_mode: "refund_prorate",
      });
    } finally {
      cf.restore();
    }
  });

  it("流量套餐：按比例扣剩余流量", async () => {
    await seed({ kind: "traffic", paidMinor: 3000, termDays: 30 });
    const cf = withPlatform();
    try {
      const r = await refundOrder(env, {
        orderCode: "ORD-REFUND-1",
        amountMinor: 1500,
        reason: "退一半",
        now: NOW,
      });
      expect(r.ok && r.remaining).toEqual({ gb: 50 });
      const sub = await subOf();
      expect(sub?.traffic_remaining_gb).toBe(50);
      const patch = cf.patches.find((p) => p.id === PLATFORM_ID);
      // 50 GB ⇒ 字节
      expect(patch?.body).toMatchObject({ traffic_balance: 50 * 1024 ** 3 });
    } finally {
      cf.restore();
    }
  });
});

describe("全额退款：等于终止权益", () => {
  it("退满残值 ⇒ 订单 refunded、订阅 revoked、平台 frozen=1", async () => {
    await seed({});
    const cf = withPlatform();
    try {
      const r = await refundOrder(env, {
        orderCode: "ORD-REFUND-1",
        amountMinor: 3000,
        reason: "七天无理由",
        now: NOW,
      });
      expect(r).toMatchObject({ ok: true, voided: true, platformSynced: true });

      const sub = await subOf();
      expect(sub?.hold).toBe("revoked");
      expect((await orderOf())?.status).toBe("refunded");
      expect(cf.patches.find((p) => p.id === PLATFORM_ID)?.body).toMatchObject({
        frozen: 1,
      });
    } finally {
      cf.restore();
    }
  });
});

describe("拒绝的情形", () => {
  it("退得比剩余价值还多 ⇒ 拒绝（钱只能从没用掉的部分退）", async () => {
    await seed({ paidMinor: 3000, termDays: 30 });
    // 把到期日改到"只剩 15 天"：残值 = 1500
    await env.DB.prepare(
      `UPDATE platform_subscriptions SET expires_at = ? WHERE customer_id = ?`,
    )
      .bind(iso(new Date(NOW.getTime() + 15 * DAY)), CUSTOMER)
      .run();

    const r = await refundOrder(env, {
      orderCode: "ORD-REFUND-1",
      amountMinor: 2000,
      reason: "用了一半想全退",
      now: NOW,
    });
    expect(r).toMatchObject({ ok: false, code: "refund_exceeds_residual" });
    expect(r.ok === false && r.message).toContain("15.00");
  });

  it("超过这一单还没退的金额 ⇒ refund_too_large", async () => {
    await seed({ orderAmount: 3000 });
    expect(
      await refundOrder(env, {
        orderCode: "ORD-REFUND-1",
        amountMinor: 3001,
        reason: "多退",
        now: NOW,
      }),
    ).toMatchObject({ ok: false, code: "refund_too_large" });
  });

  it("必须写原因", async () => {
    await seed({});
    expect(
      await refundOrder(env, {
        orderCode: "ORD-REFUND-1",
        amountMinor: 100,
        reason: "   ",
        now: NOW,
      }),
    ).toMatchObject({ ok: false, code: "reason_required" });
  });

  it("还没到账的订单不能退", async () => {
    await seed({ status: "pending" });
    expect(
      await refundOrder(env, {
        orderCode: "ORD-REFUND-1",
        amountMinor: 100,
        reason: "没到账",
        now: NOW,
      }),
    ).toMatchObject({ ok: false, code: "not_paid" });
  });

  it("商店内购的退款由 Apple / Google 发起", async () => {
    await seed({ iapKey: "apple:123" });
    expect(
      await refundOrder(env, {
        orderCode: "ORD-REFUND-1",
        amountMinor: 100,
        reason: "商店单",
        now: NOW,
      }),
    ).toMatchObject({ ok: false, code: "iap_refund_by_store" });
  });
});
