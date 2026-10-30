/**
 * 批量发放（`promotions/runs.ts`）—— **分页 + 重入**
 *
 * 要钉住的：
 *   1. 建任务只是建任务：**立刻返回**，真正的发放由 cron 一批一批做；
 *   2. 一批有界（`batch` 条），游标前进，跑完置 `done`；
 *   3. 重复点「批量发放」**不会**开第二个任务（幂等）；
 *   4. 跑完再跑不会多发（`redemptions` 唯一 + 任务已结束）；
 *   5. 人群不符合的人计入 `skipped`，不会中断整轮。
 */
import { beforeAll, describe, expect, it } from "vitest";

import { env } from "./apply-migrations";

const now = () => new Date().toISOString();

/** 直接建客户（不走登录，测试只关心批量语义） */
async function makeCustomer(email: string): Promise<number> {
  const res = await env.DB.prepare(
    `INSERT INTO customers (email, status, created_at) VALUES (?, 'active', ?)`,
  )
    .bind(email, now())
    .run();
  return Number(res.meta.last_row_id ?? 0);
}

/** 直接给一个客户造一行生效中的订阅（礼包才有地方放） */
async function giveSubscription(customerId: number, days = 30): Promise<void> {
  const iso = now();
  const expires = new Date(Date.now() + days * 86_400_000).toISOString();
  await env.DB.prepare(
    `INSERT INTO platform_subscriptions
       (customer_id, plan_id, kind, hold, paid_minor, currency, licence_limit,
        period_quota_gb, period_extra_gb, started_at, expires_at, trial, created_at, updated_at)
     VALUES (?, 'run_30d', 'period', 'none', 1000, 'CNY', 1, 100, 0, ?, ?, 0, ?, ?)`,
  )
    .bind(customerId, iso, expires, iso, iso)
    .run();
}

async function makeGift(rewards: Record<string, number>): Promise<number> {
  const iso = now();
  const res = await env.DB.prepare(
    `INSERT INTO promotions
       (auto_apply, name, kind, benefit_type, benefit_value, rewards_json, delivery,
        notify, audience, max_uses_per_customer, status, created_at, updated_at)
     VALUES (0, '批量礼包', 'gift', 'amount', 0, ?, 'auto', 0, 'all', 1, 'active', ?, ?)`,
  )
    .bind(JSON.stringify(rewards), iso, iso)
    .run();
  return Number(res.meta.last_row_id ?? 0);
}

let withSub: number[] = [];
let withoutSub: number[] = [];
let giftId = 0;

beforeAll(async () => {
  for (let i = 0; i < 3; i += 1) withSub.push(await makeCustomer(`run-with-${i}@test.com`));
  for (let i = 0; i < 4; i += 1) withoutSub.push(await makeCustomer(`run-without-${i}@test.com`));
  for (const id of withSub) await giveSubscription(id);
  giftId = await makeGift({ days: 2 });
});

describe("批量任务：建 → 分批 → 完成", () => {
  it("建任务只冻结范围与总数，不发放", async () => {
    const { startRun } = await import("../../src/promotions/runs");
    const { run, alreadyRunning } = await startRun(env, { promotionId: giftId });

    expect(alreadyRunning).toBe(false);
    expect(run.status).toBe("running");
    expect(run.total).toBe(withSub.length + withoutSub.length);
    expect(run.processed).toBe(0);
    // 一个都没发
    const count = await env.DB.prepare(
      `SELECT COUNT(*) AS n FROM redemptions WHERE promotion_id = ?`,
    )
      .bind(giftId)
      .first<{ n: number }>();
    expect(Number(count?.n ?? 0)).toBe(0);
  });

  it("重复建任务不会开第二个（幂等）", async () => {
    const { startRun } = await import("../../src/promotions/runs");
    const { alreadyRunning, run } = await startRun(env, { promotionId: giftId });
    expect(alreadyRunning).toBe(true);
    expect(run.id).toBeGreaterThan(0);

    const rows = await env.DB.prepare(
      `SELECT COUNT(*) AS n FROM promotion_runs WHERE promotion_id = ?`,
    )
      .bind(giftId)
      .first<{ n: number }>();
    expect(Number(rows?.n ?? 0)).toBe(1);
  });

  it("一批只处理有界的一小片，游标前进", async () => {
    const { runNextBatch } = await import("../../src/promotions/runs");
    const report = await runNextBatch(env, { batch: 3 });

    expect(report).toBeTruthy();
    expect(report!.processed).toBeLessThanOrEqual(3);
    expect(report!.hasMore).toBe(true);

    const run = await env.DB.prepare(
      `SELECT cursor, processed, status FROM promotion_runs WHERE id = ?`,
    )
      .bind(report!.runId)
      .first<{ cursor: number; processed: number; status: string }>();
    expect(run!.cursor).toBeGreaterThan(0);
    expect(run!.processed).toBe(report!.processed);
    expect(run!.status).toBe("running");
  });

  it("继续分批直到完成：有订阅的到账，没订阅的跳过（不中断整轮）", async () => {
    const { runNextBatch } = await import("../../src/promotions/runs");
    for (let i = 0; i < 10; i += 1) {
      const report = await runNextBatch(env, { batch: 3 });
      if (!report || !report.hasMore) break;
    }

    const run = await env.DB.prepare(
      `SELECT status, total, processed, granted, skipped, failed
         FROM promotion_runs WHERE promotion_id = ? ORDER BY id DESC LIMIT 1`,
    )
      .bind(giftId)
      .first<{
        status: string;
        total: number;
        processed: number;
        granted: number;
        skipped: number;
        failed: number;
      }>();
    expect(run!.status).toBe("done");
    expect(run!.processed).toBe(run!.total);
    expect(run!.granted).toBe(withSub.length);
    expect(run!.skipped).toBe(withoutSub.length);
    expect(run!.failed).toBe(0);

    // 台账：只有"到底了"的那几个人有核销记录
    const rows = await env.DB.prepare(
      `SELECT customer_id FROM redemptions WHERE promotion_id = ? ORDER BY customer_id`,
    )
      .bind(giftId)
      .all<{ customer_id: number }>();
    expect((rows.results ?? []).map((r) => r.customer_id)).toEqual([...withSub].sort((a, b) => a - b));
  });

  it("任务结束后再跑 ⇒ 没有可跑的任务（不会重复发放）", async () => {
    const { runNextBatch } = await import("../../src/promotions/runs");
    expect(await runNextBatch(env, { batch: 3 })).toBeNull();

    const count = await env.DB.prepare(
      `SELECT COUNT(*) AS n FROM redemptions WHERE promotion_id = ?`,
    )
      .bind(giftId)
      .first<{ n: number }>();
    expect(Number(count?.n ?? 0)).toBe(withSub.length);
  });

  it("进度文案由 CRM 组织（后台直接显示）", async () => {
    const { latestRun, runProgressText } = await import("../../src/promotions/runs");
    const run = await latestRun(env, giftId);
    expect(run).toBeTruthy();
    const text = runProgressText(run!);
    expect(text).toContain("已完成");
    expect(text).toContain(`到账 ${withSub.length}`);
  });
});
