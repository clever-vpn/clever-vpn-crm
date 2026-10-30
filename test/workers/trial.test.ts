/**
 * 免费试用（套餐 → 订阅 → cf-api 客户，不走支付网关）
 *
 * 要钉住的：
 *   1. 没配试用套餐时 `GET /trial` 返回 `available:false`，注册也不会凭空多出订阅；
 *   2. 配好之后注册**自动开通**：一行订阅 + 一张 0 元 `source='signup'` 订单 + cf-api 客户；
 *   3. 状态文案由 CRM 组织（"免费试用 · 还剩 N 天"），App 只显示；
 *   4. 试用套餐**不能下单**（403），否则就是绕开注册的 0 元购买入口；
 *   5. 试用不算"付过钱" —— 新人券照常可用（否则一领试用就失去首购优惠）。
 *
 * 这个文件**自己插试用套餐**，不放进 dev 种子：有试用套餐时所有新注册的人都会自动
 * 获得订阅，会改变其它测试的前置条件。
 */
import { exports as rawExports } from "cloudflare:workers";
import { beforeAll, describe, expect, it } from "vitest";

import { env } from "./apply-migrations";
import { installFakeCfApi } from "./fake-cf-api";

import type { FakeCfApi } from "./fake-cf-api";

const BASE = "https://crm.test";
const CSRF = { "x-crm-request": "1" };

/** dev 种子里管理员口令的哈希（`ops@example.com` / `crm-admin-2026`） */
const DEV_PASSWORD_HASH =
  "pbkdf2$sha256$50000$Y2xldmVydnBuLWRldi1zYQ$pNN_GLa4DQySXqMVpf9UB8ETxhsV6Z64uKaqiB190Mo";

const TRIAL_USER = "trial-user@test.com";
const LATE_USER = "trial-late@test.com";

const worker = rawExports as unknown as {
  default: { fetch(request: Request): Promise<Response> };
};

let adminCookie = "";
let cf: FakeCfApi;

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

const appCall = (path: string, token: string) =>
  fetchJson(path, { headers: { authorization: `Bearer ${token}` } });

async function login(email: string): Promise<string> {
  const sent = await fetchJson("/api/app/v1/auth/send-code", { method: "POST", body: { email } });
  const { code } = (await sent.json()) as { code?: string };
  expect(code, "非 production 应回显验证码").toBeTruthy();
  const verified = await fetchJson("/api/app/v1/auth/verify", {
    method: "POST",
    body: { email, code },
  });
  expect(verified.status).toBe(200);
  return ((await verified.json()) as { session_token: string }).session_token;
}

async function customerIdOf(email: string): Promise<number> {
  const row = await env.DB.prepare(`SELECT id FROM customers WHERE email = ?`)
    .bind(email)
    .first<{ id: number }>();
  expect(row, `客户应存在：${email}`).toBeTruthy();
  return row!.id;
}

async function subscriptionOf(customerId: number) {
  return env.DB.prepare(
    `SELECT plan_id, kind, trial, paid_minor, expires_at, period_quota_gb,
            platform_customer_id, activation_code
       FROM platform_subscriptions WHERE customer_id = ?`,
  )
    .bind(customerId)
    .first<{
      plan_id: string;
      kind: string;
      trial: number;
      paid_minor: number;
      expires_at: string;
      period_quota_gb: number | null;
      platform_customer_id: number | null;
      activation_code: string | null;
    }>();
}

/** 后台建一个套餐（默认草稿 → 直接发布） */
async function createPlan(body: Record<string, unknown>): Promise<void> {
  const created = await adminCall("/api/admin/plans", { method: "POST", body });
  expect(created.status, JSON.stringify(await created.clone().text())).toBe(201);
  // 后台视图里套餐主键叫 `plan_id`（与 App 契约一致）
  const { plan } = (await created.json()) as { plan: { plan_id: string } };
  const published = await adminCall(`/api/admin/plans/${plan.plan_id}/publish`, { method: "POST" });
  expect(published.status, await published.clone().text()).toBe(200);
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

  const res = await fetchJson("/api/admin/login", {
    method: "POST",
    headers: { ...CSRF },
    body: { email: "ops@example.com", password: "crm-admin-2026" },
  });
  expect(res.status).toBe(200);
  adminCookie = res.headers.get("set-cookie")?.split(";")[0] ?? "";
});

describe("GET /trial（免登录）", () => {
  it("还没配试用套餐 ⇒ available:false，注册也不会凭空多出订阅", async () => {
    const res = await appCall("/api/app/v1/trial", "");
    expect(res.status).toBe(200);
    expect(((await res.json()) as { available: boolean }).available).toBe(false);

    const token = await login(LATE_USER);
    const sub = await appCall("/api/app/v1/subscription", token);
    const view = (await sub.json()) as { status: string; tag: string | null; tag_tone: string | null };
    expect(view.status).toBe("none");
    expect(view.tag).toBeNull();
    expect(view.tag_tone).toBeNull();
  });

  it("配好之后返回 CRM 组织好的文案（App 不需要自己拼）", async () => {
    await createPlan({
      id: "trial_7d",
      name: "7 天体验",
      kind: "period",
      price_minor: 999, // 会被强制成 0
      currency: "CNY",
      licence_limit: 1,
      term_days: 7,
      monthly_quota_gb: 10,
      trial: true,
    });

    const info = (await (await appCall("/api/app/v1/trial", "")).json()) as Record<string, unknown>;
    expect(info.available).toBe(true);
    expect(info.days).toBe(7);
    expect(info.quota_gb).toBe(10);
    expect(info.text).toBe("注册即送 7 天免费试用（10GB）");
    // 被强制成 0 元 + 隐藏
    expect(info.plan_name).toBe("7 天体验");
    const row = await env.DB.prepare(`SELECT price_minor, visibility FROM plans WHERE id = 'trial_7d'`)
      .first<{ price_minor: number; visibility: string }>();
    expect(row).toEqual({ price_minor: 0, visibility: "hidden" });
  });

  it("试用套餐不能出现在 /plans（正式列表里没有它）", async () => {
    const plans = (await (await appCall("/api/app/v1/plans", "")).json()) as { plan_id: string }[];
    expect(plans.some((p) => p.plan_id === "trial_7d")).toBe(false);
  });
});

describe("注册自动开通", () => {
  it("建号即开通：一行订阅 + 0 元 signup 订单 + cf-api 客户 + 试用文案", async () => {
    const token = await login(TRIAL_USER);
    const customerId = await customerIdOf(TRIAL_USER);

    const sub = await subscriptionOf(customerId);
    expect(sub).toBeTruthy();
    expect(sub!.plan_id).toBe("trial_7d");
    expect(sub!.trial).toBe(1);
    expect(sub!.paid_minor).toBe(0); // 试用不产生残值，转正时全价
    expect(sub!.platform_customer_id).toBeTruthy();
    expect(sub!.activation_code).toBeTruthy();
    // 7 天（config 的 term_days）
    const days = Math.round((Date.parse(sub!.expires_at) - Date.now()) / 86_400_000);
    expect(days).toBe(7);

    // 账簿有据：0 元、source='signup'、已生效
    const order = await env.DB.prepare(
      `SELECT amount_minor, status, source, payment_method, subscription_id
         FROM orders WHERE customer_id = ? AND source = 'signup'`,
    )
      .bind(customerId)
      .first<{
        amount_minor: number;
        status: string;
        source: string;
        payment_method: string;
        subscription_id: number | null;
      }>();
    expect(order).toBeTruthy();
    expect(order!.amount_minor).toBe(0);
    expect(order!.status).toBe("active");
    expect(order!.payment_method).toBe("gift"); // 没有经过任何网关
    expect(order!.subscription_id).toBeGreaterThan(0);

    // 状态与文案由 CRM 组织
    const view = (await (await appCall("/api/app/v1/subscription", token)).json()) as {
      status: string;
      status_text: string;
      tag: string | null;
      tag_tone: string | null;
      code?: string;
    };
    expect(view.status).toBe("active");
    expect(view.status_text).toContain("免费试用");
    // 卡片小标签由 CRM 给：App 只渲染，不判断 isTrial
    expect(view.tag).toBe("试用中");
    expect(view.tag_tone).toBe("info");
    expect(view.code).toBeTruthy();
  });

  it("试用套餐不能下单（403，不是 404）", async () => {
    const token = await login("trial-buyer@test.com");
    const res = await fetchJson("/api/app/v1/orders", {
      method: "POST",
      headers: { authorization: `Bearer ${token}` },
      body: { plan_id: "trial_7d", payment_method: "alipay" },
    });
    expect(res.status).toBe(403);
    // 错误体是 `{ error: { code, message } }`（与 /quote 等一致）
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("trial_plan_not_for_sale");
  });

  it("重复调用不会双开（同一客户只有一行订阅、一张 signup 单）", async () => {
    const { startTrial } = await import("../../src/subscriptions/trial");
    const customerId = await customerIdOf(TRIAL_USER);
    const again = await startTrial(env, customerId);
    expect(again.granted).toBe(false);
    expect(again.reason).toBe("已有订阅");

    const count = await env.DB.prepare(
      `SELECT COUNT(*) AS n FROM orders WHERE customer_id = ? AND source = 'signup'`,
    )
      .bind(customerId)
      .first<{ n: number }>();
    expect(Number(count?.n ?? 0)).toBe(1);
  });

  it("试用不算“付过钱”：新人券照常可用", async () => {
    // 一个公开的付费套餐 + 一张只给新客的 5 折自动券
    await createPlan({
      id: "paid_30d",
      name: "月付 · 15 元",
      kind: "period",
      price_minor: 1500,
      currency: "CNY",
      licence_limit: 1,
      term_days: 30,
      monthly_quota_gb: 100,
      sales_channels: [{ channel: "web_checkout", methods: ["alipay"] }],
    });
    const coupon = await adminCall("/api/admin/promotions", {
      method: "POST",
      body: {
        name: "新人 5 折",
        kind: "coupon",
        benefit_type: "percent",
        benefit_value: 50,
        audience: "new",
        limit_plan_ids: ["paid_30d"],
        badge_label: "新人 5 折",
        auto_apply: true,
      },
    });
    expect(coupon.status, JSON.stringify(await coupon.clone().text())).toBe(201);
    const { promotion } = (await coupon.json()) as { promotion: { id: number } };
    await adminCall(`/api/admin/promotions/${promotion.id}/publish`, { method: "POST" });

    // 这个客户**已经领了试用**（0 元 signup 单），但仍应算新客
    const token = await login(TRIAL_USER);
    const plans = (await (await appCall("/api/app/v1/plans", token)).json()) as {
      plan_id: string;
      promo_price_minor: number | null;
    }[];
    const paid = plans.find((p) => p.plan_id === "paid_30d");
    expect(paid?.promo_price_minor).toBe(750);
  });

  it("试用到期：同一个接口给出「试用已结束」的文案与标签", async () => {
    const token = await login("trial-expired@test.com");
    const customerId = await customerIdOf("trial-expired@test.com");
    // 把它拨到过去（等价于时间流逝）
    await env.DB.prepare(
      `UPDATE platform_subscriptions SET expires_at = ?, period_settled_at = ? WHERE customer_id = ?`,
    )
      .bind("2026-01-01T00:00:00.000Z", "2026-01-01T00:00:00.000Z", customerId)
      .run();

    const view = (await (await appCall("/api/app/v1/subscription", token)).json()) as {
      status: string;
      reason: string;
      status_text: string;
      tag: string;
      tag_tone: string;
    };
    expect(view.status).toBe("inactive");
    expect(view.reason).toBe("expired");
    expect(view.status_text).toContain("试用已于");
    expect(view.tag).toBe("试用已结束");
    expect(view.tag_tone).toBe("muted");
  });

  it("cf-api 侧真的建了客户（字节单位、quota 恒 NULL）", async () => {
    const customerId = await customerIdOf(TRIAL_USER);
    const sub = await subscriptionOf(customerId);
    const platform = cf.customers.get(sub!.platform_customer_id!);
    expect(platform).toBeTruthy();
    expect(platform!.traffic_balance).toBe(10 * 1024 ** 3);
    expect(platform!.quota).toBeNull();
    expect(platform!.expire_date).toBe(sub!.expires_at.slice(0, 10));
  });
});
