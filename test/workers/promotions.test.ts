/**
 * 集成测试：促销两层（优惠码 / 邀请码）跑在真 D1 + 真路由上
 *
 * 要钉住的行为（契约 `app-crm.md` §2.9）：
 *   - `/plans` 的 `original_price_minor` / `promo_badge` 是**公开**信息；个人应付只给登录用户
 *   - `/quote` 是唯一金额来源：带码折扣、错码拒绝（200 + allowed:false，不是 5xx）
 *   - `/orders` 下单时**重新校验**，金额按促销后收，并把 `promotion_id` 落单
 *   - **支付成功才核销**：`redemptions` 只在回调里写，重放不重复
 *   - 邀请码：选填、只在建号那一刻生效、输错静默忽略；被邀请人首单后推荐人拿权益奖励
 */
import { exports as rawExports } from "cloudflare:workers";
import { beforeAll, describe, expect, it } from "vitest";

import { env } from "./apply-migrations";

const BASE = "https://crm.test";
const CSRF = { "x-crm-request": "1" };

/** dev 种子里管理员口令的哈希（`ops@example.com` / `crm-admin-2026`） */
const DEV_PASSWORD_HASH =
  "pbkdf2$sha256$50000$Y2xldmVydnBuLWRldi1zYQ$pNN_GLa4DQySXqMVpf9UB8ETxhsV6Z64uKaqiB190Mo";

const PAYER = "promo-payer@test.com";
const FRIEND = "promo-friend@test.com";
const REFERRER = "promo-referrer@test.com";

const worker = rawExports as unknown as {
  default: { fetch(request: Request): Promise<Response> };
};

let adminCookie = "";

function fetchJson(path: string, init: { method?: string; body?: unknown; headers?: Record<string, string> } = {}) {
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

/** App 侧：Bearer（原生壳口径） */
const appCall = (path: string, token: string, init: { method?: string; body?: unknown } = {}) =>
  fetchJson(path, { ...init, headers: { authorization: `Bearer ${token}` } });

/** 走真实登录：发码（非 production 回显）→ verify */
async function login(email: string, referralCode?: string): Promise<string> {
  const sent = await fetchJson("/api/app/v1/auth/send-code", { method: "POST", body: { email } });
  const { code } = (await sent.json()) as { code?: string };
  expect(code, "非 production 应回显验证码").toBeTruthy();
  const verified = await fetchJson("/api/app/v1/auth/verify", {
    method: "POST",
    body: { email, code, ...(referralCode ? { referral_code: referralCode } : {}) },
  });
  expect(verified.status).toBe(200);
  return ((await verified.json()) as { session_token: string }).session_token;
}

/** 后台建活动并上线 */
async function createPromotion(body: Record<string, unknown>): Promise<number> {
  const created = await adminCall("/api/admin/promotions", { method: "POST", body });
  expect(created.status, JSON.stringify(await created.clone().text())).toBe(201);
  const { promotion } = (await created.json()) as { promotion: { id: number } };
  const published = await adminCall(`/api/admin/promotions/${promotion.id}/publish`, { method: "POST" });
  expect(published.status).toBe(200);
  return promotion.id;
}

/** 下单 → 演示收银台 → 模拟支付成功 */
async function payOrder(token: string, planId: string, promoCode?: string): Promise<{ order_code: string; amount_minor: number; pay_url: string }> {
  const quote = await appCall("/api/app/v1/quote", token, {
    method: "POST",
    body: { plan_id: planId, ...(promoCode ? { promo_code: promoCode } : {}) },
  });
  const q = (await quote.json()) as { allowed: boolean; payable_minor: number | null; reason: string | null };
  expect(q.allowed, q.reason ?? "").toBe(true);

  const created = await appCall("/api/app/v1/orders", token, {
    method: "POST",
    body: {
      plan_id: planId,
      payment_method: "alipay",
      expected_payable_minor: q.payable_minor,
      origin: "web",
      ...(promoCode ? { promo_code: promoCode } : {}),
    },
  });
  expect(created.status).toBe(201);
  const order = (await created.json()) as { order_code: string; pay_url: string; amount_minor: number };

  const paid = await worker.default.fetch(new Request(`${order.pay_url}/paid`, { method: "POST" }));
  expect(paid.status).toBe(200);
  return { order_code: order.order_code, amount_minor: order.amount_minor, pay_url: order.pay_url };
}

beforeAll(async () => {
  (env as unknown as Record<string, unknown>).ALLOW_MOCK_PAYMENTS = "true";
  const now = new Date().toISOString();

  await env.DB.batch([
    env.DB.prepare(
      `INSERT INTO admin_users (email, password_hash, totp_enabled, created_at, updated_at)
       VALUES ('ops@example.com', ?, 0, ?, ?)`,
    ).bind(DEV_PASSWORD_HASH, now, now),
    env.DB.prepare(
      `INSERT INTO payment_gateways (driver, name, endpoint, merchant_id, secret_enc, methods,
         mapping, priority, status, currency, allowed_emails, created_at, updated_at)
       VALUES ('mock', '测试网关（演示）', NULL, 'MOCK-P1', NULL, '["alipay"]',
         NULL, 999, 'live', 'CNY', ?, ?, ?)`,
    ).bind(JSON.stringify([PAYER, FRIEND, REFERRER]), now, now),
    // 标价 15 元 / 30 元两个周期套餐
    env.DB.prepare(
      `INSERT INTO plans (id, name, kind, price_minor, currency, licence_limit, term_days,
         monthly_quota_gb, traffic_gb, validity_days, line_ids, sales_channels,
         store_product_id, sort_order, status, visibility, created_at, updated_at)
       VALUES ('promo_30d', '月付 · 15 元', 'period', 1500, 'CNY', 1, 30, 100,
         NULL, NULL, '[]', '[{"channel":"web_checkout","methods":["alipay"]}]', '{}', 1, 'active', 'public', ?, ?)`,
    ).bind(now, now),
    env.DB.prepare(
      `INSERT INTO plans (id, name, kind, price_minor, currency, licence_limit, term_days,
         monthly_quota_gb, traffic_gb, validity_days, line_ids, sales_channels,
         store_product_id, sort_order, status, visibility, created_at, updated_at)
       VALUES ('promo_90d', '季付 · 30 元', 'period', 3000, 'CNY', 1, 90, 300,
         NULL, NULL, '[]', '[{"channel":"web_checkout","methods":["alipay"]}]', '{}', 2, 'active', 'public', ?, ?)`,
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

  // 邀请活动：被邀请人首单减 5 元，推荐人得 7 天。
  // 注意**不给 code** —— 关系层靠 `customers.referral_code`，不靠促销码。
  await createPromotion({
    name: "邀请好友",
    kind: "referral",
    benefit_type: "amount",
    benefit_value: 500,
    first_purchase_only: true,
    referrer_reward_type: "days",
    referrer_reward_value: 7,
  });
});

describe("后台建活动", () => {
  it("自动活动（无码）：默认草稿，publish 后上线", async () => {
    const created = await adminCall("/api/admin/promotions", {
      method: "POST",
      body: {
        name: "首单立减 3 元",
        kind: "coupon",
        benefit_type: "amount",
        benefit_value: 300,
        first_purchase_only: true,
        badge_label: "首单立减 3 元",
      },
    });
    expect(created.status).toBe(201);
    const { promotion } = (await created.json()) as { promotion: { id: number; status: string } };
    expect(promotion.status).toBe("draft");

    const published = await adminCall(`/api/admin/promotions/${promotion.id}/publish`, { method: "POST" });
    expect(published.status).toBe(200);
  });

  it("带码活动：码唯一、非法值一次报全", async () => {
    const bad = await adminCall("/api/admin/promotions", {
      method: "POST",
      body: { name: "", benefit_type: "percent", benefit_value: 120 },
    });
    expect(bad.status).toBe(400);
    const body = (await bad.json()) as { errors: string[] };
    expect(body.errors.length).toBeGreaterThan(1);

    await createPromotion({
      code: "NEW300",
      name: "新人券",
      kind: "coupon",
      benefit_type: "amount",
      benefit_value: 300,
      badge_label: "领券立减 3 元",
    });

    const dup = await adminCall("/api/admin/promotions", {
      method: "POST",
      body: { code: "NEW300", name: "重名码", benefit_type: "amount", benefit_value: 100 },
    });
    expect(dup.status).toBe(409);
  });
});

describe("/plans 的促销展示位", () => {
  it("匿名也能看角标（公开信息），但仍没有应付", async () => {
    const res = await fetchJson("/api/app/v1/plans");
    const items = (await res.json()) as {
      plan_id: string;
      original_price_minor: number;
      promo_badge: string | null;
      payable_minor: number | null;
      action: string;
    }[];
    const plan = items.find((p) => p.plan_id === "promo_30d");
    expect(plan?.action).toBe("login_required");
    expect(plan?.payable_minor).toBeNull();
    expect(plan?.original_price_minor).toBe(1500);
    // 两个公开活动都带 badge，取更优的那个（新人券 300 > 首单券 300 ⇒ 同额按 id）
    expect(plan?.promo_badge).toBeTruthy();
  });

  it("登录后：新客拿到折扣后的应付", async () => {
    const token = await login(PAYER);
    const res = await appCall("/api/app/v1/plans", token);
    const items = (await res.json()) as {
      plan_id: string;
      action: string;
      payable_minor: number | null;
    }[];
    const plan = items.find((p) => p.plan_id === "promo_30d");
    expect(plan?.action).toBe("buy");
    // 1500 − 300
    expect(plan?.payable_minor).toBe(1200);
  });
});

describe("/quote：唯一的金额来源", () => {
  it("带码：给出 discount 明细，应付已扣减", async () => {
    const token = await login(PAYER);
    const res = await appCall("/api/app/v1/quote", token, {
      method: "POST",
      body: { plan_id: "promo_30d", promo_code: "new300" }, // 大小写不敏感
    });
    expect(res.status).toBe(200);
    const q = (await res.json()) as {
      allowed: boolean;
      payable_minor: number;
      discount_minor: number;
      discount_label: string;
      applied_promotions: { code: string | null; label: string }[];
      price_minor: number;
    };
    expect(q.allowed).toBe(true);
    expect(q.price_minor).toBe(1500);
    expect(q.discount_minor).toBe(300);
    expect(q.payable_minor).toBe(1200);
    expect(q.discount_label).toContain("−¥3.00");
    expect(q.applied_promotions[0]?.code).toBe("NEW300");
  });

  it("错码：200 + allowed:false + 整句理由（不是 5xx）", async () => {
    const token = await login(PAYER);
    for (const code of ["NOPE", "NEW300X"]) {
      const res = await appCall("/api/app/v1/quote", token, {
        method: "POST",
        body: { plan_id: "promo_30d", promo_code: code },
      });
      expect(res.status).toBe(200);
      const q = (await res.json()) as { allowed: boolean; reason: string; payable_minor: null };
      expect(q.allowed).toBe(false);
      expect(q.reason.length).toBeGreaterThan(0);
      expect(q.payable_minor).toBeNull();
    }
  });

  it("0 元单直接被拒（任何网关都收不了）", async () => {
    // 100% off 的活动
    await createPromotion({
      code: "FREE100",
      name: "全免券",
      kind: "coupon",
      benefit_type: "percent",
      benefit_value: 100,
      limit_plan_ids: ["promo_90d"],
    });
    const token = await login(PAYER);
    const res = await appCall("/api/app/v1/quote", token, {
      method: "POST",
      body: { plan_id: "promo_90d", promo_code: "FREE100" },
    });
    const q = (await res.json()) as { allowed: boolean; reason: string };
    expect(q.allowed).toBe(false);
    expect(q.reason).toContain("抵扣全部金额");
  });
});

describe("/orders + 支付回调", () => {
  it("按促销后金额收钱，订单落 promotion_id / discount_minor / entry", async () => {
    const token = await login(PAYER);
    const order = await payOrder(token, "promo_30d", "NEW300");
    expect(order.amount_minor).toBe(1200);

    const row = await env.DB.prepare(
      `SELECT amount_minor, discount_minor, promotion_id, entry, status FROM orders WHERE code = ?`,
    )
      .bind(order.order_code)
      .first<{ amount_minor: number; discount_minor: number; promotion_id: number; entry: string; status: string }>();
    expect(row?.amount_minor).toBe(1200);
    expect(row?.discount_minor).toBe(300);
    expect(row?.promotion_id).toBeGreaterThan(0);
    expect(row?.entry).toBe("web");
    expect(row?.status).toBe("active");
  });

  it("核销只在支付成功后写，且回调重放不重复", async () => {
    await createPromotion({
      code: "ONCE",
      name: "核销测试券",
      kind: "coupon",
      benefit_type: "amount",
      benefit_value: 200,
    });

    const token = await login(PAYER);
    const order = await payOrder(token, "promo_30d", "ONCE");
    expect(order.amount_minor).toBe(1300);

    const countFor = async (): Promise<number> => {
      const row = await env.DB.prepare(
        `SELECT COUNT(*) AS n FROM redemptions r
          JOIN orders o ON o.id = r.order_id
         WHERE o.customer_id = (SELECT id FROM customers WHERE email = ?)`,
      )
        .bind(PAYER)
        .first<{ n: number }>();
      return Number(row?.n ?? 0);
    };
    const before = await countFor();
    expect(before).toBe(2); // 两个用码的订单各一条

    // 重放同一个回调：订单已 active ⇒ 直接应答，不重复核销
    const replay = await worker.default.fetch(new Request(`${order.pay_url}/paid`, { method: "POST" }));
    expect(replay.status).toBe(200);
    expect(await countFor()).toBe(before);
  });

  it("同一个码本人只能用一次（per-customer 上限）", async () => {
    const token = await login(PAYER);
    const res = await appCall("/api/app/v1/quote", token, {
      method: "POST",
      body: { plan_id: "promo_30d", promo_code: "NEW300" },
    });
    const q = (await res.json()) as { allowed: boolean; reason: string };
    expect(q.allowed).toBe(false);
    expect(q.reason).toContain("已经用过");
  });
});

describe("邀请码（关系层）", () => {
  it("建号时带码 → 建立关系；码不存在/自邀一律静默忽略", async () => {
    // 推荐人先注册，拿到自己的码
    const referrerToken = await login(REFERRER);
    const me = (await (await appCall("/api/app/v1/me", referrerToken)).json()) as {
      referral: { code: string; invited: number; reward_days: number; reward_gb: number };
    };
    expect(me.referral.code).toBeTruthy();
    const code = me.referral.code;

    // 好友带码注册
    const friendToken = await login(FRIEND, code.toLowerCase());
    const rel = await env.DB.prepare(
      `SELECT referrer_id, code, rewarded_at FROM referrals
        WHERE customer_id = (SELECT id FROM customers WHERE email = ?)`,
    )
      .bind(FRIEND)
      .first<{ referrer_id: number; code: string; rewarded_at: string | null }>();
    expect(rel?.code).toBe(code);
    expect(rel?.rewarded_at).toBeNull();

    // 不存在的码：照样能登录（选填字段不能挡注册）
    const other = await login("promo-other@test.com", "NOSUCHCODE");
    expect(other).toBeTruthy();
    // 已注册用户再传码：忽略，不报错
    expect(await login(FRIEND, "NOSUCHCODE")).toBeTruthy();
    // 自己邀自己：忽略
    const selfRel = await env.DB.prepare(
      `SELECT COUNT(*) AS n FROM referrals WHERE customer_id = referrer_id`,
    ).first<{ n: number }>();
    expect(selfRel?.n).toBe(0);
  });

  it("被邀请人首单支付后，推荐人拿到权益奖励", async () => {
    // 给推荐人一条真实订阅（否则奖励无处可发）
    const now = new Date().toISOString();
    const referrer = await env.DB.prepare(`SELECT id FROM customers WHERE email = ?`)
      .bind(REFERRER)
      .first<{ id: number }>();
    expect(referrer?.id).toBeTruthy();
    await env.DB.prepare(
      `INSERT INTO platform_subscriptions (customer_id, plan_id, kind, hold, paid_minor, currency,
         licence_limit, term_days, quota_gb, line_ids, started_at, expires_at, created_at, updated_at)
       VALUES (?, 'promo_30d', 'period', 'none', 1200, 'CNY', 1, 30, 100, '[]', ?, ?, ?, ?)`,
    )
      .bind(referrer!.id, now, now, now, now)
      .run();
    const before = await env.DB.prepare(
      `SELECT expires_at FROM platform_subscriptions WHERE customer_id = ?`,
    )
      .bind(referrer!.id)
      .first<{ expires_at: string }>();

    // 好友付款（首单）⇒ 推荐人 +7 天
    const friendToken = await login(FRIEND);
    await payOrder(friendToken, "promo_30d");

    const after = await env.DB.prepare(
      `SELECT expires_at FROM platform_subscriptions WHERE customer_id = ?`,
    )
      .bind(referrer!.id)
      .first<{ expires_at: string }>();
    const gained = (Date.parse(after!.expires_at) - Date.parse(before!.expires_at)) / 86_400_000;
    expect(gained).toBe(7);

    const panel = (await (await appCall("/api/app/v1/me", await login(REFERRER))).json()) as {
      referral: { invited: number; reward_days: number };
    };
    expect(panel.referral.invited).toBe(1);
    expect(panel.referral.reward_days).toBe(7);
  });
});
