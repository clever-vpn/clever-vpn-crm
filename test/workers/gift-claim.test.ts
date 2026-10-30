/**
 * 无码礼包的两种送达方式：**自动到账** vs **待领取**
 *
 * 为什么要有「待领取」：直接改账用户感知不到 —— 到期日悄悄延长 10 天，用户只会在某天
 * 发现"居然还能用"时才隐约感觉到。要用户看见，就得有个必须自己完成的动作。
 *
 * 这里要钉住的：
 *   1. `delivery='claim'` 触发时**只发券**：订阅一点没动、没有 0 元订单、`redemptions` 空；
 *   2. 用户点领取才到账，且账目齐全（0 元订单 + `redemptions` + 台账 `action='gift'`）；
 *   3. 重复领取幂等：券只能从 pending 跳一次，权益只加一次；
 *   4. 过期领不到（惰性判断，不靠定时任务）；
 *   5. 收不下的礼包**连券都不发**（免得多一张永远领不掉的卡）；
 *   6. `delivery='auto'` 的行为一个字都没变（回归）。
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

const CLAIMER = "claim-user@test.com";
const REPEATER = "claim-twice@test.com";
const EXPIRER = "claim-expired@test.com";
const FOREVER = "claim-forever@test.com";
const AUTO_USER = "claim-auto@test.com";

const worker = rawExports as unknown as {
  default: { fetch(request: Request): Promise<Response> };
};

interface GiftView {
  id: number;
  promotion_id: number;
  title: string;
  rewards_text: string;
  source_text: string;
  status: string;
  status_text: string;
  action: string | null;
}

interface ClaimResponse {
  ok: boolean;
  reason: string | null;
  status: string;
  applied?: { days: number; gb: number };
  gift: GiftView | null;
}

let adminCookie = "";

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

const appCall = (path: string, token: string, init: { method?: string; body?: unknown } = {}) =>
  fetchJson(path, { ...init, headers: { authorization: `Bearer ${token}` } });

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

/** 卖一张月付（30 天）把订阅造出来，礼包才有地方放 */
async function payMonthly(token: string, planId = "claim_30d"): Promise<void> {
  const quote = await appCall("/api/app/v1/quote", token, {
    method: "POST",
    body: { plan_id: planId },
  });
  const q = (await quote.json()) as { allowed: boolean; payable_minor: number | null };
  expect(q.allowed).toBe(true);
  const created = await appCall("/api/app/v1/orders", token, {
    method: "POST",
    body: {
      plan_id: planId,
      payment_method: "alipay",
      expected_payable_minor: q.payable_minor,
      origin: "web",
    },
  });
  expect(created.status).toBe(201);
  const order = (await created.json()) as { pay_url: string };
  const paid = await worker.default.fetch(new Request(`${order.pay_url}/paid`, { method: "POST" }));
  expect(paid.status).toBe(200);
}

async function subOf(customerId: number) {
  return env.DB.prepare(
    `SELECT plan_id, expires_at, period_extra_gb, traffic_total_gb, traffic_remaining_gb
       FROM platform_subscriptions WHERE customer_id = ?`,
  )
    .bind(customerId)
    .first<{
      plan_id: string;
      expires_at: string | null;
      period_extra_gb: number | null;
      traffic_total_gb: number | null;
      traffic_remaining_gb: number | null;
    }>();
}

async function createGift(body: Record<string, unknown>): Promise<number> {
  const created = await adminCall("/api/admin/promotions", { method: "POST", body });
  expect(created.status, JSON.stringify(await created.clone().text())).toBe(201);
  const { promotion } = (await created.json()) as { promotion: { id: number } };
  const published = await adminCall(`/api/admin/promotions/${promotion.id}/publish`, {
    method: "POST",
  });
  expect(published.status).toBe(200);
  return promotion.id;
}

const giftsOf = async (token: string): Promise<GiftView[]> =>
  ((await (await appCall("/api/app/v1/me/gifts", token)).json()) as { gifts: GiftView[] }).gifts;

const claim = async (token: string, giftId: number): Promise<ClaimResponse> => {
  const res = await appCall(`/api/app/v1/me/gifts/${giftId}/claim`, token, { method: "POST" });
  expect(res.status, await res.clone().text()).toBe(200);
  return (await res.json()) as ClaimResponse;
};

beforeAll(async () => {
  (env as unknown as Record<string, unknown>).ALLOW_MOCK_PAYMENTS = "true";
  // 装了假 cf-api：不然"权益到账"只改了本地库，落账根本没发生
  const cfApi: FakeCfApi = installFakeCfApi();
  (env as unknown as Record<string, unknown>).CF_API_BASE = cfApi.base;
  (env as unknown as Record<string, unknown>).CF_API_TOKEN = cfApi.token;
  const now = new Date().toISOString();

  await env.DB.batch([
    env.DB.prepare(
      `INSERT INTO admin_users (email, password_hash, totp_enabled, created_at, updated_at)
       VALUES ('ops@example.com', ?, 0, ?, ?)`,
    ).bind(DEV_PASSWORD_HASH, now, now),
    env.DB.prepare(
      `INSERT INTO payment_gateways (driver, name, endpoint, merchant_id, secret_enc, methods,
         mapping, priority, status, currency, allowed_emails, created_at, updated_at)
       VALUES ('mock', '测试网关（演示）', NULL, 'MOCK-CLAIM', NULL, '["alipay"]',
         NULL, 999, 'live', 'CNY', ?, ?, ?)`,
    ).bind(JSON.stringify([CLAIMER, REPEATER, EXPIRER, FOREVER, AUTO_USER]), now, now),
    // 有期限、有额度的月付：两个维度都收得下
    env.DB.prepare(
      `INSERT INTO plans (id, name, kind, price_minor, currency, licence_limit, term_days,
         monthly_quota_gb, traffic_gb, validity_days, line_ids, sales_channels,
         store_product_id, sort_order, status, visibility, created_at, updated_at)
       VALUES ('claim_30d', '月付 · 10 元', 'period', 1000, 'CNY', 1, 30, 100,
         NULL, NULL, '[]', '[{"channel":"web_checkout","methods":["alipay"]}]',
         '{}', 1, 'active', 'public', ?, ?)`,
    ).bind(now, now),
    // 不限量套餐：只送流量的礼包对它无计可施（连券都不该发）
    env.DB.prepare(
      `INSERT INTO plans (id, name, kind, price_minor, currency, licence_limit, term_days,
         monthly_quota_gb, traffic_gb, validity_days, line_ids, sales_channels,
         store_product_id, sort_order, status, visibility, created_at, updated_at)
       VALUES ('claim_unl', '不限量 · 30 天', 'period', 5000, 'CNY', 1, 30, NULL,
         NULL, NULL, '[]', '[{"channel":"web_checkout","methods":["alipay"]}]',
         '{}', 2, 'active', 'public', ?, ?)`,
    ).bind(now, now),
  ]);

  const loginRes = await fetchJson("/api/admin/login", {
    method: "POST",
    headers: { ...CSRF },
    body: { email: "ops@example.com", password: "crm-admin-2026" },
  });
  expect(loginRes.status).toBe(200);
  adminCookie = (loginRes.headers.get("set-cookie") ?? "").split(";")[0] ?? "";
  expect(adminCookie).toContain("crm_admin=");
});

describe("delivery=claim：只发券，不发权益", () => {
  it("后台点名发放 ⇒ pending，订阅一点没动，也没有 0 元订单", async () => {
    const promoId = await createGift({
      name: "待领取 · 国庆礼物",
      kind: "gift",
      audience: "all",
      rewards: { days: 7, gb: 5 },
      delivery: "claim",
      claim_valid_days: 30,
      badge_label: "国庆礼物",
    });

    const token = await login(CLAIMER);
    await payMonthly(token);
    const customerId = await customerIdOf(CLAIMER);

    const before = await subOf(customerId);
    const granted = await adminCall(`/api/admin/promotions/${promoId}/grant`, {
      method: "POST",
      body: { customer_ids: [customerId] },
    });
    const body = (await granted.json()) as {
      granted: number;
      pending: number;
      total: number;
      results: { pending?: boolean; claim_expires_at?: string }[];
    };
    expect(body.pending).toBe(1);
    expect(body.granted).toBe(0);
    expect(body.total).toBe(1);
    expect(body.results[0]?.pending).toBe(true);

    // 权益**没动**：到期日一样、没有额外流量
    expect(await subOf(customerId)).toEqual(before);
    const orders = await env.DB.prepare(
      `SELECT COUNT(*) AS n FROM orders WHERE customer_id = ? AND source = 'gift'`,
    )
      .bind(customerId)
      .first<{ n: number }>();
    expect(Number(orders?.n ?? 0)).toBe(0);
    const used = await env.DB.prepare(
      `SELECT COUNT(*) AS n FROM redemptions WHERE promotion_id = ?`,
    )
      .bind(promoId)
      .first<{ n: number }>();
    expect(Number(used?.n ?? 0)).toBe(0); // 名额没被占：券不等于核销

    // App 能看见一张可点的卡（文案由 CRM 给）
    const gifts = await giftsOf(token);
    expect(gifts).toHaveLength(1);
    expect(gifts[0]!.status).toBe("pending");
    expect(gifts[0]!.action).toBe("claim");
    expect(gifts[0]!.title).toBe("国庆礼物"); // 有角标就用角标，不暴露后台备注
    expect(gifts[0]!.rewards_text).toBe("+7 天 · +5 GB");
    expect(gifts[0]!.status_text).toContain("天后作废");

    // `/me` 的红点数量
    const me = (await (await appCall("/api/app/v1/me", token)).json()) as { pending_gifts: number };
    expect(me.pending_gifts).toBe(1);
  });

  it("领取 ⇒ 加天数加流量，账目齐全，券变已领取", async () => {
    const token = await login(CLAIMER);
    const customerId = await customerIdOf(CLAIMER);
    const before = await subOf(customerId);

    const gifts = await giftsOf(token);
    const gift = gifts.find((g) => g.status === "pending");
    expect(gift).toBeTruthy();

    const result = await claim(token, gift!.id);
    expect(result.ok).toBe(true);
    expect(result.status).toBe("claimed");
    expect(result.applied).toEqual({ days: 7, gb: 5 });
    expect(result.gift?.status_text).toContain("已领取");

    const after = await subOf(customerId);
    // 天数加在**原到期日**上
    const addedDays = Math.round(
      (Date.parse(after!.expires_at!) - Date.parse(before!.expires_at!)) / 86_400_000,
    );
    expect(addedDays).toBe(7);
    expect(after!.period_extra_gb).toBe(5);
    expect(after!.traffic_remaining_gb).toBe((before!.traffic_remaining_gb ?? 0) + 5);

    // 账簿：一张 0 元礼包订单 + 一行核销 + 台账
    const order = await env.DB.prepare(
      `SELECT amount_minor, source, status FROM orders WHERE customer_id = ? AND source = 'gift'`,
    )
      .bind(customerId)
      .first<{ amount_minor: number; source: string; status: string }>();
    expect(order).toEqual({ amount_minor: 0, source: "gift", status: "paid" });

    const claimRow = await env.DB.prepare(
      `SELECT status, order_id, granted_json FROM promotion_claims WHERE customer_id = ?`,
    )
      .bind(customerId)
      .first<{ status: string; order_id: number | null; granted_json: string }>();
    expect(claimRow!.status).toBe("claimed");
    expect(claimRow!.order_id).toBeGreaterThan(0);
    expect(JSON.parse(claimRow!.granted_json)).toEqual({ days: 7, gb: 5 });

    // 领完之后红点清零
    const me = (await (await appCall("/api/app/v1/me", token)).json()) as { pending_gifts: number };
    expect(me.pending_gifts).toBe(0);
  });

  it("重复领取幂等：第二次 ok:false，权益只加一次", async () => {
    const token = await login(CLAIMER);
    const customerId = await customerIdOf(CLAIMER);
    const before = await subOf(customerId);

    const gifts = await giftsOf(token);
    const claimed = gifts.find((g) => g.status === "claimed");
    const again = await claim(token, claimed!.id);
    expect(again.ok).toBe(false);
    expect(again.reason).toContain("已经领过");
    expect(again.status).toBe("claimed");
    expect(await subOf(customerId)).toEqual(before);
  });

  it("别人手里的券领不到（404）", async () => {
    const otherToken = await login(AUTO_USER);
    const mine = await giftsOf(await login(CLAIMER));
    const res = await appCall(`/api/app/v1/me/gifts/${mine[0]!.id}/claim`, otherToken, {
      method: "POST",
    });
    expect(res.status).toBe(404);
  });
});

describe("过期与并发", () => {
  it("过了领取截止时间 ⇒ 卡片显示已过期、点不动，也领不到", async () => {
    const promoId = await createGift({
      name: "限时领取礼包",
      kind: "gift",
      audience: "all",
      rewards: { days: 3 },
      delivery: "claim",
      claim_valid_days: 1,
    });

    const token = await login(EXPIRER);
    await payMonthly(token);
    const customerId = await customerIdOf(EXPIRER);

    await adminCall(`/api/admin/promotions/${promoId}/grant`, {
      method: "POST",
      body: { customer_ids: [customerId] },
    });

    // 把截止时间拨到过去（等价于过了 N 天）—— 过期是**算**出来的，不需要定时任务
    await env.DB.prepare(
      `UPDATE promotion_claims SET expires_at = ? WHERE customer_id = ? AND promotion_id = ?`,
    )
      .bind(new Date(Date.now() - 86_400_000).toISOString(), customerId, promoId)
      .run();

    const gifts = await giftsOf(token);
    expect(gifts[0]!.status).toBe("expired");
    expect(gifts[0]!.action).toBeNull(); // 没有按钮可点
    expect(gifts[0]!.status_text).toContain("已过期");

    const before = await subOf(customerId);
    const res = await claim(token, gifts[0]!.id);
    expect(res.ok).toBe(false);
    expect(res.reason).toContain("过期");
    expect(await subOf(customerId)).toEqual(before);
  });

  it("同一活动重复触发只刷新同一张券，不堆一叠", async () => {
    const promoId = await createGift({
      name: "重复触发礼包",
      kind: "gift",
      audience: "all",
      rewards: { gb: 1 },
      delivery: "claim",
      claim_valid_days: 7,
    });
    const customerId = await customerIdOf(EXPIRER);
    for (let i = 0; i < 3; i += 1) {
      await adminCall(`/api/admin/promotions/${promoId}/grant`, {
        method: "POST",
        body: { customer_ids: [customerId] },
      });
    }
    const rows = await env.DB.prepare(
      `SELECT COUNT(*) AS n FROM promotion_claims WHERE promotion_id = ? AND customer_id = ?`,
    )
      .bind(promoId, customerId)
      .first<{ n: number }>();
    expect(Number(rows?.n ?? 0)).toBe(1);
  });
});

describe("收不下的礼包不发券", () => {
  it("不限量套餐 + 只送流量的礼包 ⇒ 券都不发（免得用户看到一张永远领不掉的卡）", async () => {
    const promoId = await createGift({
      name: "对不限量无效的礼包",
      kind: "gift",
      audience: "all",
      rewards: { gb: 5 },
      delivery: "claim",
    });

    const token = await login(FOREVER);
    await payMonthly(token, "claim_unl");
    const customerId = await customerIdOf(FOREVER);

    const res = await adminCall(`/api/admin/promotions/${promoId}/grant`, {
      method: "POST",
      body: { customer_ids: [customerId] },
    });
    const body = (await res.json()) as {
      pending: number;
      results: { skipped: string | null }[];
    };
    expect(body.pending).toBe(0);
    expect(body.results[0]!.skipped).toContain("不适用");
    expect(await giftsOf(token)).toHaveLength(0);
  });
});

describe("delivery=auto：行为不变（回归）", () => {
  it("直接到账，不产生待领取卡片", async () => {
    const promoId = await createGift({
      name: "直接到账礼包",
      kind: "gift",
      audience: "all",
      rewards: { days: 2 },
    });

    const token = await login(AUTO_USER);
    await payMonthly(token);
    const customerId = await customerIdOf(AUTO_USER);
    const before = await subOf(customerId);

    const res = await adminCall(`/api/admin/promotions/${promoId}/grant`, {
      method: "POST",
      body: { customer_ids: [customerId] },
    });
    const body = (await res.json()) as { granted: number; pending: number };
    expect(body.granted).toBe(1);
    expect(body.pending).toBe(0);

    const after = await subOf(customerId);
    const addedDays = Math.round(
      (Date.parse(after!.expires_at!) - Date.parse(before!.expires_at!)) / 86_400_000,
    );
    expect(addedDays).toBe(2);
    expect(await giftsOf(token)).toHaveLength(0);
  });
});

describe("后台校验", () => {
  it("claim 模式不填有效期就按默认 7 天；填 0 或 100 天被拒", async () => {
    const created = await adminCall("/api/admin/promotions", {
      method: "POST",
      body: {
        name: "不填有效期",
        kind: "gift",
        audience: "all",
        rewards: { days: 1 },
        delivery: "claim",
      },
    });
    expect(created.status).toBe(201);
    const { promotion } = (await created.json()) as {
      promotion: { delivery: string; claim_valid_days: number | null };
    };
    expect(promotion.delivery).toBe("claim");
    expect(promotion.claim_valid_days).toBe(7);

    const bad = await adminCall("/api/admin/promotions", {
      method: "POST",
      body: {
        name: "有效期越界",
        kind: "gift",
        audience: "all",
        rewards: { days: 1 },
        delivery: "claim",
        claim_valid_days: 100,
      },
    });
    expect(bad.status).toBe(400);
  });

  it("优惠券不会被写成 claim（这一列只属于礼包）", async () => {
    const created = await adminCall("/api/admin/promotions", {
      method: "POST",
      body: {
        name: "自动券",
        kind: "coupon",
        auto_apply: true,
        benefit_type: "amount",
        benefit_value: 300,
        badge_label: "立减 3 元",
        audience: "all",
        delivery: "claim", // 传了也不生效
        claim_valid_days: 30,
      },
    });
    expect(created.status).toBe(201);
    const { promotion } = (await created.json()) as {
      promotion: { delivery: string; claim_valid_days: number | null };
    };
    expect(promotion.delivery).toBe("auto");
    expect(promotion.claim_valid_days).toBeNull();
  });
});
