/**
 * 平台剩余的**缓存**语义（`traffic_remaining_gb` + `traffic_synced_at`）。
 *
 * 要钉死的三件事：
 *   1. 展示/报价用的是缓存，TTL 15 分钟内**不回源**（否则每个页面都打一次 cf-api）；
 *   2. 过期了要**自动回源并落库**（懒同步）；
 *   3. 写平台之前必须**强制**回源（`freshenTraffic` 不看 TTL），
 *      拿旧缓存加量会把用户已经用掉的流量还回去；读不到平台就返回 null、**不写库**。
 */

import { beforeAll, beforeEach, describe, expect, it } from "vitest";

import { env } from "./apply-migrations";
import { installFakeCfApi } from "./fake-cf-api";

import { GIGA } from "../../src/platform/client";
import {
  customerSubscription,
  ensureTrafficFresh,
  freshenTraffic,
  TRAFFIC_CACHE_TTL_MS,
  trafficCacheFresh,
} from "../../src/subscriptions/store";

import type { FakeCfApi } from "./fake-cf-api";

const PLATFORM_ID = 4201;
let cf: FakeCfApi;

/** 造一个已落账的 period 订阅：平台上真实剩 `platformGb`，本地缓存是 `cachedGb` */
async function seedSubscription(opts: {
  cachedGb: number | null;
  syncedAgoMs: number | null;
  platformGb: number | null;
}): Promise<number> {
  const now = new Date();
  const res = await env.DB.prepare(
    `INSERT INTO customers (email, status, created_at) VALUES (?, 'active', ?)`,
  )
    .bind(`cache-${crypto.randomUUID().slice(0, 8)}@test.com`, now.toISOString())
    .run();
  const customerId = Number(res.meta.last_row_id ?? 0);

  const syncedAt =
    opts.syncedAgoMs === null ? null : new Date(now.getTime() - opts.syncedAgoMs).toISOString();

  await env.DB.prepare(
    `INSERT INTO platform_subscriptions
       (customer_id, plan_id, kind, hold, paid_minor, currency, licence_limit, period_term_days,
        period_quota_gb, period_extra_gb, period_settled_at, started_at, expires_at,
        period_anchor_day, traffic_remaining_gb, traffic_synced_at,
        platform_customer_id, activation_code, created_at, updated_at)
     VALUES (?, 'p_cache', 'period', 'none', 1500, 'CNY', 1, 30, 100, 0, ?, ?, ?, 1, ?, ?, ?, '7391000000000009', ?, ?)`,
  )
    .bind(
      customerId,
      now.toISOString(),
      now.toISOString(),
      new Date(now.getTime() + 30 * 86_400_000).toISOString(),
      opts.cachedGb,
      syncedAt,
      PLATFORM_ID,
      now.toISOString(),
      now.toISOString(),
    )
    .run();

  cf.customers.set(PLATFORM_ID, {
    id: PLATFORM_ID,
    code: "7391000000000009",
    name: "cache",
    email: null,
    auth_id: `crm:${PLATFORM_ID}`,
    licence_limit: 1,
    frozen: 0,
    expire_date: null,
    traffic_balance: opts.platformGb === null ? null : opts.platformGb * GIGA,
    quota: null,
    _is_deleted: 0,
  });

  return customerId;
}

beforeAll(() => {
  cf = installFakeCfApi();
  (env as unknown as Record<string, unknown>).CF_API_BASE = cf.base;
  (env as unknown as Record<string, unknown>).CF_API_TOKEN = cf.token;
});

beforeEach(() => {
  cf.customers.clear();
  cf.patches.length = 0;
});

describe("trafficCacheFresh", () => {
  it("没有 synced_at ⇒ 视为过期（值可能是本地推算的）", async () => {
    const id = await seedSubscription({ cachedGb: 100, syncedAgoMs: null, platformGb: 40 });
    const sub = (await customerSubscription(env, id))!;
    expect(trafficCacheFresh(sub)).toBe(false);
  });

  it("按 TTL 判定（15 分钟）", async () => {
    const fresh = (await customerSubscription(
      env,
      await seedSubscription({ cachedGb: 100, syncedAgoMs: 60_000, platformGb: 40 }),
    ))!;
    expect(trafficCacheFresh(fresh)).toBe(true);

    const stale = (await customerSubscription(
      env,
      await seedSubscription({
        cachedGb: 100,
        syncedAgoMs: TRAFFIC_CACHE_TTL_MS + 1000,
        platformGb: 40,
      }),
    ))!;
    expect(trafficCacheFresh(stale)).toBe(false);
  });
});

describe("ensureTrafficFresh：缓存新鲜就不打 cf-api", () => {
  it("15 分钟内不回源，仍返回缓存值", async () => {
    const id = await seedSubscription({ cachedGb: 99, syncedAgoMs: 60_000, platformGb: 10 });
    const sub = (await customerSubscription(env, id))!;
    const out = await ensureTrafficFresh(env, sub);
    expect(out.traffic_remaining_gb).toBe(99); // 平台上是 10，但没到回源时机
  });

  it("过期了就回源，并落库", async () => {
    const id = await seedSubscription({
      cachedGb: 99,
      syncedAgoMs: TRAFFIC_CACHE_TTL_MS + 1000,
      platformGb: 10,
    });
    const sub = (await customerSubscription(env, id))!;
    const out = await ensureTrafficFresh(env, sub);
    expect(out.traffic_remaining_gb).toBe(10);

    const reloaded = (await customerSubscription(env, id))!;
    expect(reloaded.traffic_remaining_gb).toBe(10);
    expect(reloaded.traffic_synced_at).toBeTruthy();
  });
});

describe("freshenTraffic：强制回源（写平台前必用）", () => {
  it("无视 TTL，直接取平台值", async () => {
    const id = await seedSubscription({ cachedGb: 99, syncedAgoMs: 1000, platformGb: 10 });
    const sub = (await customerSubscription(env, id))!;
    const out = (await freshenTraffic(env, sub))!;
    expect(out.traffic_remaining_gb).toBe(10);
    expect((await customerSubscription(env, id))!.traffic_remaining_gb).toBe(10);
  });

  it("读不到平台余额（平台已删该客户）⇒ 返回 null，且**不改库**（宁可不做，也不能错写）", async () => {
    const id = await seedSubscription({ cachedGb: 99, syncedAgoMs: 1000, platformGb: 10 });
    const sub = (await customerSubscription(env, id))!;
    cf.customers.delete(PLATFORM_ID);

    expect(await freshenTraffic(env, sub)).toBeNull();

    const reloaded = (await customerSubscription(env, id))!;
    expect(reloaded.traffic_remaining_gb).toBe(99);
    expect(reloaded.traffic_synced_at).toBe(sub.traffic_synced_at);
  });

  it("平台上是 NULL（不限量 / 未写）⇒ 缓存写成 NULL，不当 0", async () => {
    const id = await seedSubscription({ cachedGb: 99, syncedAgoMs: 1000, platformGb: null });
    const sub = (await customerSubscription(env, id))!;
    const out = (await freshenTraffic(env, sub))!;
    expect(out.traffic_remaining_gb).toBeNull();
    expect(out.traffic_synced_at).toBeTruthy();
  });
});
