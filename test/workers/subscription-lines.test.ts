/**
 * 单客户线路权益：`GET /api/admin/platform/lines` + `POST /api/admin/customers/:id/lines`
 *
 * 要钉住的（`crm-api.md` §3.2 / §5.2.1）：
 *   1. 目录是**只读直通 cf-api**，不在 CRM 落库；读不到时给出可操作的错误，而不是 500；
 *   2. 改线路写的是**订阅快照**（`platform_subscriptions.line_ids`），所以后续落账不会丢；
 *   3. 顺序是**先推平台、再写本地**：平台失败 ⇒ 本地不变（不允许"本地改了、平台没改"）；
 *   4. 必须写原因：`subscription_changes(action='adjust')` + `audit_log` 各一行。
 */
import { exports as rawExports } from "cloudflare:workers";
import { beforeAll, describe, expect, it } from "vitest";

import { env } from "./apply-migrations";
import { installFakeCfApi, seedPlatformCreds, FAKE_LINES } from "./fake-cf-api";

import type { FakeCfApi } from "./fake-cf-api";

const BASE = "https://crm.test";
const CSRF = { "x-crm-request": "1" };
const DEV_PASSWORD_HASH =
  "pbkdf2$sha256$50000$Y2xldmVydnBuLWRldi1zYQ$pNN_GLa4DQySXqMVpf9UB8ETxhsV6Z64uKaqiB190Mo";
const PLATFORM_ID = 8801;
const EMAIL = "lines-me@test.com";

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

/** 订阅快照里的线路（JSON 文本，与 `store.ts` 的存储形态一致） */
async function storedLineIds(): Promise<number[]> {
  const row = await env.DB.prepare(
    `SELECT line_ids FROM platform_subscriptions WHERE customer_id = ?`,
  )
    .bind(customerId)
    .first<{ line_ids: string }>();
  expect(row).toBeTruthy();
  return JSON.parse(row!.line_ids) as number[];
}

beforeAll(async () => {
  cf = installFakeCfApi();
  await seedPlatformCreds(env.DB, cf);

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

  const plan = await adminCall("/api/admin/plans", {
    method: "POST",
    body: {
      id: "lines_30d",
      name: "月付 · 指定线路",
      kind: "period",
      price_minor: 1500,
      currency: "CNY",
      licence_limit: 1,
      term_days: 30,
      monthly_quota_gb: 100,
      line_ids: [1, 2],
      sales_channels: [{ channel: "web_checkout", methods: ["alipay"] }],
    },
  });
  expect(plan.status).toBe(201);

  const created = await adminCall("/api/admin/customers", {
    method: "POST",
    body: { email: EMAIL },
  });
  customerId = ((await created.json()) as { customer: { id: number } }).customer.id;

  const sub = await adminCall("/api/admin/subscriptions", {
    method: "POST",
    body: { customer_id: customerId, plan_id: "lines_30d", paid_minor: 1500 },
  });
  expect(sub.status).toBe(201);

  // 手工开通不走平台；这里补上"已落账"的状态（推送路径才有意义）
  await env.DB.prepare(
    `UPDATE platform_subscriptions SET platform_customer_id = ? WHERE customer_id = ?`,
  )
    .bind(PLATFORM_ID, customerId)
    .run();
  cf.customers.set(PLATFORM_ID, {
    id: PLATFORM_ID,
    code: "7391000000000888",
    name: "lines",
    email: EMAIL,
    auth_id: `crm:${customerId}`,
    licence_limit: 1,
    frozen: 0,
    expire_date: null,
    traffic_balance: 100 * 1024 ** 3,
    quota: null,
    line_ids: [1, 2],
    _is_deleted: 0,
  });
});

describe("GET /api/admin/platform/lines", () => {
  it("直通 cf-api 的线路目录（只读，不落库）", async () => {
    const res = await adminCall("/api/admin/platform/lines");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; lines: { id: number; label: string }[] };
    expect(body.ok).toBe(true);
    expect(body.lines.map((l) => l.id)).toEqual([1, 2]);
    expect(body.lines[1]).toMatchObject({ label: FAKE_LINES[1]!.label });
  });

  it("cf-api 拒绝 token ⇒ 400，并指向「设置 → cf-api 对接」", async () => {
    const realFetch = globalThis.fetch;
    globalThis.fetch = async () =>
      new Response(JSON.stringify({ error: "invalid api token" }), {
        status: 401,
        headers: { "content-type": "application/json" },
      });
    try {
      const res = await adminCall("/api/admin/platform/lines");
      expect(res.status).toBe(400);
      const body = (await res.json()) as { error: string; message: string };
      expect(body.error).toBe("invalid_token");
      expect(body.message).toContain("cf-api 对接");
    } finally {
      globalThis.fetch = realFetch;
    }
  });
});

describe("POST /api/admin/customers/:id/lines", () => {
  it("改线路：先推平台，再写快照；写变更流水与审计", async () => {
    const res = await adminCall(`/api/admin/customers/${customerId}/lines`, {
      method: "POST",
      body: { line_ids: [1], reason: "只允许 HK 线路" },
    });
    expect(res.status, await res.clone().text()).toBe(200);
    const body = (await res.json()) as { ok: boolean; applied: number[]; platform_synced: boolean };
    expect(body.platform_synced).toBe(true);
    expect(body.applied).toEqual([1]);

    // 平台：绝对值写入
    expect(cf.patches.at(-1)).toMatchObject({ id: PLATFORM_ID, body: { line_ids: [1] } });
    expect(cf.customers.get(PLATFORM_ID)?.line_ids).toEqual([1]);

    // 本地：订阅快照（后续落账读它）
    expect(await storedLineIds()).toEqual([1]);

    const change = await env.DB.prepare(
      `SELECT action, detail FROM subscription_changes WHERE customer_id = ? ORDER BY id DESC LIMIT 1`,
    )
      .bind(customerId)
      .first<{ action: string; detail: string }>();
    expect(change?.action).toBe("adjust");
    expect(JSON.parse(change!.detail)).toMatchObject({
      lines: { before: [1, 2], after: [1] },
      reason: "只允许 HK 线路",
    });

    const audit = await env.DB.prepare(
      `SELECT action, target FROM audit_log ORDER BY id DESC LIMIT 1`,
    ).first<{ action: string; target: string }>();
    expect(audit).toMatchObject({ action: "subscription_lines_changed", target: String(customerId) });
  });

  it("空数组 = 全部线路：平台收到 null，快照存 []", async () => {
    const res = await adminCall(`/api/admin/customers/${customerId}/lines`, {
      method: "POST",
      body: { line_ids: [], reason: "恢复全部线路" },
    });
    expect(res.status).toBe(200);
    expect(cf.patches.at(-1)).toMatchObject({ id: PLATFORM_ID, body: { line_ids: null } });
    expect(cf.customers.get(PLATFORM_ID)?.line_ids).toBeNull();
    expect(await storedLineIds()).toEqual([]);
  });

  it("没写原因 ⇒ 400，且什么都没改", async () => {
    const before = await storedLineIds();
    const res = await adminCall(`/api/admin/customers/${customerId}/lines`, {
      method: "POST",
      body: { line_ids: [2] },
    });
    expect(res.status).toBe(400);
    expect(await storedLineIds()).toEqual(before);
  });

  it("平台写入失败 ⇒ 502 且本地不变（不允许半截状态）", async () => {
    const before = await storedLineIds();
    const realFetch = globalThis.fetch;
    globalThis.fetch = async () =>
      new Response(JSON.stringify({ error: "boom" }), {
        status: 500,
        headers: { "content-type": "application/json" },
      });
    try {
      const res = await adminCall(`/api/admin/customers/${customerId}/lines`, {
        method: "POST",
        body: { line_ids: [2], reason: "试试平台挂了" },
      });
      expect(res.status).toBe(502);
      const body = (await res.json()) as { error: string };
      expect(body.error).toBe("platform_failed");
    } finally {
      globalThis.fetch = realFetch;
    }
    expect(await storedLineIds()).toEqual(before);
  });

  it("没有订阅的客户 ⇒ 404", async () => {
    const created = await adminCall("/api/admin/customers", {
      method: "POST",
      body: { email: "no-sub-lines@test.com" },
    });
    const id = ((await created.json()) as { customer: { id: number } }).customer.id;
    const res = await adminCall(`/api/admin/customers/${id}/lines`, {
      method: "POST",
      body: { line_ids: [1], reason: "x" },
    });
    expect(res.status).toBe(404);
  });
});
