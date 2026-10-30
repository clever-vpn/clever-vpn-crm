/**
 * 管理员**直接调整权益**（特殊补偿通道）
 *
 * 与礼包的边界：礼包是营销活动（人群/名额/统计、产生 0 元订单）；这里是"给某一个人补
 * 一点"。所以要钉住的：
 *   1. 加天数是**在原到期日上加**，不是从现在算；
 *   2. 加流量落在**平台真实剩余**上（本地缓存是 15 分钟的旧值也不能用）；
 *   3. 必须写原因；没有订阅 / 无限期 / 不限量 要给出可读的错；
 *   4. 留痕：`adjustments` 一行一项 + 台账 `action='adjust'` + 审计；
 *   5. 平台写失败时**整体不改**（不允许"本地加了平台没加"）。
 */
import { exports as rawExports } from "cloudflare:workers";
import { beforeAll, describe, expect, it } from "vitest";

import { env } from "./apply-migrations";
import { installFakeCfApi } from "./fake-cf-api";

import type { FakeCfApi } from "./fake-cf-api";

const BASE = "https://crm.test";
const CSRF = { "x-crm-request": "1" };
const DEV_PASSWORD_HASH =
  "pbkdf2$sha256$50000$Y2xldmVydnBuLWRldi1zYQ$pNN_GLa4DQySXqMVpf9UB8ETxhsV6Z64uKaqiB190Mo";
const PLATFORM_ID = 7701;
const EMAIL = "adjust-me@test.com";

const worker = rawExports as unknown as {
  default: { fetch(request: Request): Promise<Response> };
};
let adminCookie = "";
let cf: FakeCfApi;
let customerId = 0;

function fetchJson(
  path: string,
  init: { method?: string; body?: unknown; headers?: Record<string, string> } = {},
) {
  const headers: Record<string, string> = { ...init.headers };
  if (init.body !== undefined) headers["content-type"] = "application/json";
  return worker.default.fetch(
    new Request(`${BASE}${path}`, {
      method: init.method ?? "GET",
      headers,
      body: init.body === undefined ? undefined : JSON.stringify(init.body),
    }),
  );
}

const adminCall = (path: string, init: { method?: string; body?: unknown } = {}) =>
  fetchJson(path, { ...init, headers: { ...CSRF, cookie: adminCookie } });

/** 调整后的订阅（含本次要断言的列） */
async function subRow() {
  const row = await env.DB.prepare(
    `SELECT expires_at, period_quota_gb, period_extra_gb, traffic_total_gb,
            traffic_remaining_gb, platform_customer_id
       FROM platform_subscriptions WHERE customer_id = ?`,
  )
    .bind(customerId)
    .first<{
      expires_at: string;
      period_quota_gb: number | null;
      period_extra_gb: number | null;
      traffic_total_gb: number | null;
      traffic_remaining_gb: number | null;
      platform_customer_id: number | null;
    }>();
  expect(row).toBeTruthy();
  return row!;
}

beforeAll(async () => {
  const cfApi = installFakeCfApi();
  cf = cfApi;
  (env as unknown as Record<string, unknown>).CF_API_BASE = cfApi.base;
  (env as unknown as Record<string, unknown>).CF_API_TOKEN = cfApi.token;

  const now = new Date().toISOString();
  await env.DB.prepare(
    `INSERT INTO admin_users (email, password_hash, totp_enabled, created_at, updated_at)
     VALUES ('ops@example.com', ?, 0, ?, ?)`,
  )
    .bind(DEV_PASSWORD_HASH, now, now)
    .run();
  const login = await fetchJson("/api/admin/login", {
    method: "POST",
    headers: { ...CSRF },
    body: { email: "ops@example.com", password: "crm-admin-2026" },
  });
  expect(login.status).toBe(200);
  adminCookie = login.headers.get("set-cookie")?.split(";")[0] ?? "";

  // 一个公开的周期套餐 + 一个客户 + 一行已落账的订阅
  const plan = await adminCall("/api/admin/plans", {
    method: "POST",
    body: {
      id: "adjust_30d",
      name: "月付 · 100GB",
      kind: "period",
      price_minor: 1500,
      currency: "CNY",
      licence_limit: 1,
      term_days: 30,
      monthly_quota_gb: 100,
      sales_channels: [{ channel: "web_checkout", methods: ["alipay"] }],
    },
  });
  expect(plan.status).toBe(201);
  await adminCall(`/api/admin/plans/adjust_30d/publish`, { method: "POST" });

  const created = await adminCall("/api/admin/customers", {
    method: "POST",
    body: { email: EMAIL },
  });
  customerId = ((await created.json()) as { customer: { id: number } }).customer.id;

  const sub = await adminCall("/api/admin/subscriptions", {
    method: "POST",
    body: { customer_id: customerId, plan_id: "adjust_30d", paid_minor: 1500 },
  });
  expect(sub.status).toBe(201);

  // 手工开通不走平台；这里补上"已落账"的状态（adjust 的推送路径才有意义）
  await env.DB.prepare(`UPDATE platform_subscriptions SET platform_customer_id = ? WHERE customer_id = ?`)
    .bind(PLATFORM_ID, customerId)
    .run();
  cf.customers.set(PLATFORM_ID, {
    id: PLATFORM_ID,
    code: "7391000000000777",
    name: "adjust",
    email: EMAIL,
    auth_id: `crm:${customerId}`,
    licence_limit: 1,
    frozen: 0,
    expire_date: null,
    traffic_balance: 100 * 1024 ** 3,
    quota: null,
    _is_deleted: 0,
  });
});

describe("POST /api/admin/subscriptions/adjust", () => {
  it("加天数：在原到期日上加，平台只写 expire_date", async () => {
    const before = await subRow();
    const beforeExpires = Date.parse(before.expires_at);

    const res = await adminCall("/api/admin/subscriptions/adjust", {
      method: "POST",
      body: { customer_id: customerId, days: 10, reason: "11-03 线路故障补偿" },
    });
    expect(res.status, await res.clone().text()).toBe(200);
    const body = (await res.json()) as {
      applied: { days: number; gb: number };
      platform_synced: boolean;
    };
    expect(body.applied).toEqual({ days: 10, gb: 0 });
    expect(body.platform_synced).toBe(true);

    const after = await subRow();
    expect(Date.parse(after.expires_at) - beforeExpires).toBe(10 * 86_400_000);

    // 平台上只改了到期日，**没有**碰 traffic_balance
    const platform = cf.customers.get(PLATFORM_ID)!;
    expect(platform.expire_date).toBe(after.expires_at.slice(0, 10));
    expect(platform.traffic_balance).toBe(100 * 1024 ** 3);

    // 台账：一行 days 差分 + action='adjust'
    const record = await env.DB.prepare(
      `SELECT field, delta, reason, operator FROM adjustments WHERE customer_id = ? ORDER BY id DESC LIMIT 1`,
    )
      .bind(customerId)
      .first<{ field: string; delta: string; reason: string; operator: string }>();
    expect(record).toEqual({
      field: "days",
      delta: "+10",
      reason: "11-03 线路故障补偿",
      operator: "ops@example.com",
    });

    const change = await env.DB.prepare(
      `SELECT action FROM subscription_changes WHERE customer_id = ? ORDER BY id DESC LIMIT 1`,
    )
      .bind(customerId)
      .first<{ action: string }>();
    expect(change?.action).toBe("adjust");
  });

  it("加流量：基数取平台真实剩余（本地缓存是旧值也不用）", async () => {
    const before = await subRow();
    // 平台只剩 40GB；本地缓存故意写成 100（模拟 15 分钟没回源）
    cf.customers.get(PLATFORM_ID)!.traffic_balance = 40 * 1024 ** 3;
    await env.DB.prepare(
      `UPDATE platform_subscriptions SET traffic_remaining_gb = 100 WHERE customer_id = ?`,
    )
      .bind(customerId)
      .run();

    const res = await adminCall("/api/admin/subscriptions/adjust", {
      method: "POST",
      body: { customer_id: customerId, gb: 5, reason: "投诉安抚" },
    });
    expect(res.status, await res.clone().text()).toBe(200);

    // 40 + 5 = 45（如果用缓存 100 会变成 105 —— 等于凭空造流量）
    expect((cf.customers.get(PLATFORM_ID)!.traffic_balance ?? 0) / 1024 ** 3).toBe(45);

    const after = await subRow();
    expect(after.period_extra_gb).toBe((before.period_extra_gb ?? 0) + 5);
    expect(after.traffic_remaining_gb).toBe(45); // 缓存对齐真值
    expect(after.expires_at).toBe(before.expires_at); // 不碰到期日
  });

  it("必须写原因；没有订阅 / 无 0 元口径的脏请求都给出可读的错", async () => {
    const noReason = await adminCall("/api/admin/subscriptions/adjust", {
      method: "POST",
      body: { customer_id: customerId, days: 1 },
    });
    expect(noReason.status).toBe(400);

    const nothing = await adminCall("/api/admin/subscriptions/adjust", {
      method: "POST",
      body: { customer_id: customerId, reason: "空调整" },
    });
    expect(nothing.status).toBe(400);

    const missing = await adminCall("/api/admin/subscriptions/adjust", {
      method: "POST",
      body: { customer_id: 999999, days: 1, reason: "x" },
    });
    expect(missing.status).toBe(404);
    expect(((await missing.json()) as { error: string }).error).toBe("no_subscription");
  });

  it("不限量订阅收不下 GB：返回 not_applicable，不改任何数据", async () => {
    await env.DB.prepare(
      `UPDATE platform_subscriptions SET period_quota_gb = NULL WHERE customer_id = ?`,
    )
      .bind(customerId)
      .run();

    const res = await adminCall("/api/admin/subscriptions/adjust", {
      method: "POST",
      body: { customer_id: customerId, gb: 5, reason: "对不限量无效" },
    });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toBe("not_applicable");

    // 还原，别影响其它用例
    await env.DB.prepare(
      `UPDATE platform_subscriptions SET period_quota_gb = 100 WHERE customer_id = ?`,
    )
      .bind(customerId)
      .run();
  });

  it("审计留痕：谁在什么时候给谁调了什么、为什么", async () => {
    const row = await env.DB.prepare(
      `SELECT actor, action, detail FROM audit_log WHERE action = 'subscription_adjusted' ORDER BY id LIMIT 1`,
    ).first<{ actor: string; action: string; detail: string }>();
    expect(row?.actor).toBe("ops@example.com");
    expect(JSON.parse(row!.detail)).toMatchObject({ days: 10, gb: 0 });
  });
});
