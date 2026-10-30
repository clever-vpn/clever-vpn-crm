/**
 * 结算任务：按用户锚点重置额度，并把新余额**写回 cf-api**。
 *
 * 这里钉死两个曾经写错的点：
 *   1. 写回的单位是**字节**（`platform_balance_gb × 1024³`）
 *   2. 读不到平台余额时**跳过本轮**，不能拿 `quota_gb` 兜底（那等于凭空造额度）
 */
import { exports as rawExports } from "cloudflare:workers";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";

import { GIGA } from "../../src/platform/client";
import { runSettlement } from "../../src/subscriptions/store";
import { env } from "./apply-migrations";
import { installFakeCfApi } from "./fake-cf-api";

import type { FakeCfApi } from "./fake-cf-api";

const worker = rawExports as unknown as {
  default: { fetch(request: Request): Promise<Response> };
};

const PLATFORM_ID = 9001;
const EMAIL = "settle@test.com";

let cf: FakeCfApi;

/** 两个月前（保证跨过锚点） */
function twoMonthsAgo(now: Date): string {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 2, 2)).toISOString();
}

async function seedSubscription(opts: { lastSettledAt: string; platformId: number | null }) {
  // runSettlement 会读套餐快照（确认额度来源），所以套餐必须存在
  await env.DB.prepare(
    `INSERT OR IGNORE INTO plans (id, name, kind, price_minor, currency, licence_limit, term_days,
       monthly_quota_gb, traffic_gb, validity_days, line_ids, sales_channels,
       store_product_id, sort_order, status, visibility, created_at, updated_at)
     VALUES ('p_month', '月付 · 结算', 'period', 1500, 'CNY', 1, 30, 100, NULL, NULL,
       '[]', '[{"channel":"web_checkout","methods":["alipay"]}]', '{}', 1, 'active', 'public', ?, ?)`,
  )
    .bind(new Date().toISOString(), new Date().toISOString())
    .run();

  const res = await env.DB.prepare(
    `INSERT INTO customers (email, status, created_at) VALUES (?, 'active', ?)`,
  )
    .bind(`settle-${crypto.randomUUID().slice(0, 8)}@test.com`, new Date().toISOString())
    .run();
  const customerId = Number(res.meta.last_row_id ?? 0);

  await env.DB.prepare(
    `INSERT INTO platform_subscriptions
       (customer_id, plan_id, kind, hold, paid_minor, currency, licence_limit, period_term_days,
        period_quota_gb, traffic_total_gb, traffic_validity_days, line_ids, started_at,
        expires_at, period_anchor_day, period_extra_gb, period_settled_at,
        platform_customer_id, activation_code, created_at, updated_at)
     VALUES (?, 'p_month', 'period', 'none', 1500, 'CNY', 1, 30,
        100, NULL, NULL, '[]', ?, ?, 1, 10, ?, ?, '7391000000000001', ?, ?)`,
  )
    .bind(
      customerId,
      new Date().toISOString(),
      new Date(Date.now() + 365 * 86400_000).toISOString(),
      opts.lastSettledAt,
      opts.platformId,
      new Date().toISOString(),
      new Date().toISOString(),
    )
    .run();

  return customerId;
}

function seedPlatformCustomer(trafficGb: number) {
  cf.customers.set(PLATFORM_ID, {
    id: PLATFORM_ID,
    code: "7391000000000001",
    name: "settle",
    email: EMAIL,
    auth_id: `crm:${PLATFORM_ID}`,
    licence_limit: 1,
    frozen: 0,
    expire_date: null,
    // 平台侧只剩 5GB（用掉了绝大部分）
    traffic_balance: trafficGb * GIGA,
    quota: null,
    _is_deleted: 0,
  });
}

beforeAll(() => {
  cf = installFakeCfApi();
  (env as unknown as Record<string, unknown>).CF_API_BASE = cf.base;
  (env as unknown as Record<string, unknown>).CF_API_TOKEN = cf.token;
});

beforeEach(() => {
  cf.customers.clear();
});

describe("runSettlement：额度重置并回写平台", () => {
  it("B' = min(B, R)；写回 P + B'，单位是字节", async () => {
    const customerId = await seedSubscription({ lastSettledAt: twoMonthsAgo(new Date()), platformId: PLATFORM_ID });
    seedPlatformCustomer(5);

    const report = await runSettlement(env);
    expect(report.settled).toBeGreaterThanOrEqual(1);
    expect(report.failed).toBe(0);

    // 平台：100 + min(10, 5) = 105 GB，按**字节**写回
    expect(cf.customers.get(PLATFORM_ID)?.traffic_balance).toBe(105 * GIGA);
    // 平台自带的月度重置必须仍然关着
    expect(cf.customers.get(PLATFORM_ID)?.quota).toBeNull();

    const row = await env.DB.prepare(
      `SELECT period_extra_gb, period_settled_at FROM platform_subscriptions WHERE customer_id = ?`,
    )
      .bind(customerId)
      .first<{ period_extra_gb: number; period_settled_at: string }>();
    expect(row?.period_extra_gb).toBe(5);

    const change = await env.DB.prepare(
      `SELECT action FROM subscription_changes WHERE customer_id = ? ORDER BY id DESC LIMIT 1`,
    )
      .bind(customerId)
      .first<{ action: string }>();
    expect(change?.action).toBe("settle");
  });

  it("没到期（锚点未到）不动", async () => {
    await seedSubscription({ lastSettledAt: new Date().toISOString(), platformId: PLATFORM_ID });
    seedPlatformCustomer(5);
    const before = cf.customers.get(PLATFORM_ID)?.traffic_balance;

    const report = await runSettlement(env);
    expect(report.settled).toBe(0);
    expect(cf.customers.get(PLATFORM_ID)?.traffic_balance).toBe(before);
  });

  it("读不到平台余额 ⇒ 跳过本轮，绝不拿 quota_gb 兜底", async () => {
    await seedSubscription({ lastSettledAt: twoMonthsAgo(new Date()), platformId: PLATFORM_ID });
    seedPlatformCustomer(5);

    const backup = (env as unknown as Record<string, unknown>).CF_API_TOKEN;
    (env as unknown as Record<string, unknown>).CF_API_TOKEN = "";
    try {
      const report = await runSettlement(env);
      expect(report.settled).toBe(0);
      expect(report.failed).toBeGreaterThanOrEqual(1);
      // 平台侧保持原值，没有被改成 110GB
      expect(cf.customers.get(PLATFORM_ID)?.traffic_balance).toBe(5 * GIGA);
    } finally {
      (env as unknown as Record<string, unknown>).CF_API_TOKEN = backup;
    }
  });
});
