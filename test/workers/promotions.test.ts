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
import { installFakeCfApi } from "./fake-cf-api";

const BASE = "https://crm.test";
const CSRF = { "x-crm-request": "1" };

/** dev 种子里管理员口令的哈希（`ops@example.com` / `crm-admin-2026`） */
const DEV_PASSWORD_HASH =
  "pbkdf2$sha256$50000$Y2xldmVydnBuLWRldi1zYQ$pNN_GLa4DQySXqMVpf9UB8ETxhsV6Z64uKaqiB190Mo";

const PAYER = "promo-payer@test.com";
const FRIEND = "promo-friend@test.com";
const REFERRER = "promo-referrer@test.com";
/** 礼包用例的收件人（网关白名单要一并放行） */
const GIFT_TO = "gift-receiver@test.com";
const GIFT_SIGNUP = "gift-signup@test.com";
const GIFT_NO_SUB = "gift-no-sub@test.com";
/** 兑换码用例的收件人（网关白名单一并放行） */
const REDEEM_WITH_SUB = "redeem-sub@test.com";
const REDEEM_NEW_USER = "redeem-new@test.com";
const REDEEM_NO_PLAN = "redeem-noplan@test.com";
const REDEEM_BRUTE = "redeem-brute@test.com";
/** 批次码用例 */
const BATCH_A = "batch-a@test.com";
const BATCH_B = "batch-b@test.com";
const BATCH_C = "batch-c@test.com";
const BATCH_COUPON = "batch-coupon@test.com";

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

/**
 * 后台建活动并上线。
 *
 * v18 起码不再由后台手填，所以测试里如果指定了 `code`，就在建好活动之后
 * 把那个**指定码**直接写进 `promotion_codes`（只为了断言可读，生产走生成接口）。
 */
async function createPromotion(body: Record<string, unknown>): Promise<number> {
  const { code, ...rest } = body as { code?: string } & Record<string, unknown>;
  // v18：没有码的优惠券默认就是「自动生效」（对应 v17 的 code IS NULL）
  const isCoupon = (rest.kind ?? "coupon") === "coupon";
  // v19：自动券必须有角标；默认 `visible:false` —— 展示位只在专门讲展示的用例里开
  const auto = isCoupon && !code && rest.auto_apply !== false;
  const payload = auto
    ? { badge_label: "限时优惠", visible: false, ...rest, auto_apply: true }
    : rest;
  const created = await adminCall("/api/admin/promotions", { method: "POST", body: payload });
  expect(created.status, JSON.stringify(await created.clone().text())).toBe(201);
  const { promotion } = (await created.json()) as { promotion: { id: number } };

  if (typeof code === "string" && code) {
    await env.DB.prepare(
      `INSERT OR IGNORE INTO promotion_codes
         (promotion_id, code, batch_id, max_uses, status, expires_at, note, created_at)
       VALUES (?, ?, NULL, 1000000, 'active', NULL, 'test', ?)`,
    )
      .bind(promotion.id, code, new Date().toISOString())
      .run();
  }

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
  // 没有平台时订单就该停在 provisioning（契约行为），但这里要断言「付款后真的生效」，
  // 所以装一个假 cf-api —— 与 payment-flow / settlement 测试同一个做法。
  const cfApi = installFakeCfApi();
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
       VALUES ('mock', '测试网关（演示）', NULL, 'MOCK-P1', NULL, '["alipay"]',
         NULL, 999, 'live', 'CNY', ?, ?, ?)`,
    ).bind(
      JSON.stringify([
        PAYER, FRIEND, REFERRER, GIFT_TO, GIFT_SIGNUP, GIFT_NO_SUB,
        REDEEM_WITH_SUB, REDEEM_NEW_USER, REDEEM_NO_PLAN, REDEEM_BRUTE,
        BATCH_A, BATCH_B, BATCH_C, BATCH_COUPON,
      ]),
      now,
      now,
    ),
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
    audience: "new",
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
        auto_apply: true,
        benefit_type: "amount",
        benefit_value: 300,
        audience: "new",
        badge_label: "首单立减 3 元",
      },
    });
    expect(created.status).toBe(201);
    const { promotion } = (await created.json()) as { promotion: { id: number; status: string } };
    expect(promotion.status).toBe("draft");

    const published = await adminCall(`/api/admin/promotions/${promotion.id}/publish`, { method: "POST" });
    expect(published.status).toBe(200);
  });

  it("非法值一次报全；码由生成接口产出，不会重复", async () => {
    const bad = await adminCall("/api/admin/promotions", {
      method: "POST",
      body: { name: "", benefit_type: "percent", benefit_value: 120 },
    });
    expect(bad.status).toBe(400);
    const body = (await bad.json()) as { errors: string[] };
    expect(body.errors.length).toBeGreaterThan(1);

    // v18：后台不再手填码，唯一性由生成接口 + `promotion_codes.code` 唯一索引兜底
    const promoId = await createPromotion({
      name: "新人券",
      kind: "coupon",
      // v19：自动生效与发码互斥 —— 要发码就必须是凭码活动
      auto_apply: false,
      benefit_type: "amount",
      benefit_value: 300,
      badge_label: "领券立减 3 元",
    });
    const gen = await adminCall(`/api/admin/promotions/${promoId}/codes`, {
      method: "POST",
      body: { count: 5 },
    });
    expect(gen.status).toBe(201);
    const { codes } = (await gen.json()) as { codes: { code: string }[] };
    expect(new Set(codes.map((c) => c.code)).size).toBe(5);

    // 后面的用例要一个已知码：直接写进码表
    await env.DB.prepare(
      `INSERT OR IGNORE INTO promotion_codes
         (promotion_id, code, batch_id, max_uses, status, expires_at, note, created_at)
       VALUES (?, 'NEW300', NULL, 1000000, 'active', NULL, 'test', ?)`,
    )
      .bind(promoId, new Date().toISOString())
      .run();
  });
});

describe("/plans 的促销展示位", () => {
  type PlanItem = {
    plan_id: string;
    original_price_minor: number;
    promo_price_minor: number | null;
    promo_badge: string | null;
    payable_minor: number | null;
    action: string;
  };

  it("匿名也能看角标 + 活动价（含人群前缀），但仍没有应付", async () => {
    const res = await fetchJson("/api/app/v1/plans");
    const items = (await res.json()) as PlanItem[];
    const plan = items.find((p) => p.plan_id === "promo_30d");
    expect(plan?.action).toBe("login_required");
    // 匿名不知道访客是不是新客 ⇒ 按"该人群最优情形"算，条件写进前缀
    expect(plan?.promo_badge).toBe("限新用户 · 首单立减 3 元");
    expect(plan?.original_price_minor).toBe(1500);
    expect(plan?.promo_price_minor).toBe(1200);
    // 但"这个人要付多少"必须等登录：限人群的券不能当报价
    expect(plan?.payable_minor).toBeNull();
  });

  it("登录后：新客拿到折扣后的应付", async () => {
    const token = await login(PAYER);
    const res = await appCall("/api/app/v1/plans", token);
    const items = (await res.json()) as PlanItem[];
    const plan = items.find((p) => p.plan_id === "promo_30d");
    expect(plan?.action).toBe("buy");
    // 1500 − 300：定价页写的价，与 /quote 必须一模一样
    expect(plan?.payable_minor).toBe(1200);
    expect(plan?.promo_price_minor).toBe(1200);
  });

  it("凭码券是站外渠道：把 visible 传成 true 也不进定价页", async () => {
    const id = await createPromotion({
      name: "博主专属",
      kind: "coupon",
      auto_apply: false,
      visible: true, // 会被服务端强制落成 0
      benefit_type: "amount",
      benefit_value: 800,
      limit_plan_ids: ["promo_90d"],
      badge_label: "博主立减 8 元",
    });
    await adminCall(`/api/admin/promotions/${id}/publish`, { method: "POST" });

    const items = (await (await fetchJson("/api/app/v1/plans")).json()) as PlanItem[];
    const plan = items.find((p) => p.plan_id === "promo_90d");
    expect(plan?.promo_badge).not.toContain("博主");
  });

  it("定向名单永不公开", async () => {
    const id = await createPromotion({
      name: "受邀专享",
      kind: "coupon",
      auto_apply: true,
      visible: true,
      audience: "specific",
      benefit_type: "amount",
      benefit_value: 900,
      badge_label: "受邀立减 9 元",
    });
    await adminCall(`/api/admin/promotions/${id}/publish`, { method: "POST" });

    const items = (await (await fetchJson("/api/app/v1/plans")).json()) as PlanItem[];
    for (const plan of items) {
      expect(plan.promo_badge ?? "").not.toContain("受邀");
    }
  });
});

describe("自动生效与发码互斥（v19）", () => {
  it("自动券没有角标 → 建不出来（它是唯一的曝光入口）", async () => {
    const res = await adminCall("/api/admin/promotions", {
      method: "POST",
      body: {
        name: "无名氏",
        kind: "coupon",
        auto_apply: true,
        benefit_type: "amount",
        benefit_value: 100,
        badge_label: "",
      },
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { errors: string[] };
    expect(body.errors.join()).toContain("角标");
  });

  it("自动生效的活动不能发码（门已经对所有人开了）", async () => {
    const id = await createPromotion({
      name: "全站立减",
      kind: "coupon",
      auto_apply: true,
      visible: true,
      benefit_type: "amount",
      benefit_value: 200,
      badge_label: "全站立减 2 元",
    });
    const res = await adminCall(`/api/admin/promotions/${id}/codes`, {
      method: "POST",
      body: { count: 1 },
    });
    expect(res.status).toBe(409);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("promotion_auto_apply");
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

  it("订单详情可按单号查（只限自己的单）", async () => {
    const token = await login(PAYER);
    const list = await appCall("/api/app/v1/orders", token);
    const { items } = (await list.json()) as { items: { order_code: string }[] };
    expect(items.length).toBeGreaterThan(0);

    const code = items[0]!.order_code;
    const detail = await appCall(`/api/app/v1/orders/${code}`, token);
    expect(detail.status).toBe(200);
    const body = (await detail.json()) as {
      order_code: string;
      status: string;
      amount_minor: number;
      discount_minor: number;
      subscription?: { status: string };
    };
    expect(body.order_code).toBe(code);
    expect(body.status).not.toBe("pending");
    // 已付款的单顺带带回订阅快照，客户端少一次往返
    expect(body.subscription).toBeTruthy();

    // 别人的单查不到（不允许拿单号枚举）
    const otherToken = await login("promo-other@test.com");
    const denied = await appCall(`/api/app/v1/orders/${code}`, otherToken);
    expect(denied.status).toBe(404);
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
         licence_limit, period_term_days, period_quota_gb, line_ids, started_at, expires_at, created_at, updated_at)
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

/**
 * 礼包（契约 `app-crm.md` §2.9.6）
 *
 * 要钉住的是"**权益**这条线"：一次发放 = 一张 0 元已付订单 + 订阅参数真的变了，
 * 并且重复发放不会发第二次。
 */
describe("礼包（gift）", () => {
  const customerIdOf = async (email: string): Promise<number> => {
    const row = await env.DB.prepare(`SELECT id FROM customers WHERE email = ?`)
      .bind(email)
      .first<{ id: number }>();
    expect(row, `客户应存在：${email}`).toBeTruthy();
    return row!.id;
  };

  const snapshotOf = async (customerId: number) =>
    env.DB.prepare(
      `SELECT expires_at, period_extra_gb FROM platform_subscriptions WHERE customer_id = ?`,
    )
      .bind(customerId)
      .first<{ expires_at: string | null; period_extra_gb: number | null }>();

  it("手动发放：加天数加流量、写 0 元订单、再发一次被挡", async () => {
    const promoId = await createPromotion({
      name: "国庆礼包",
      kind: "gift",
      audience: "all",
      rewards: { days: 7, gb: 5 },
      cooldown_hours: 24,
    });

    const email = GIFT_TO;
    const token = await login(email);
    await payOrder(token, "promo_30d"); // 先造一个有效订阅
    const customerId = await customerIdOf(email);

    const before = await snapshotOf(customerId);
    expect(before?.expires_at).toBeTruthy();

    const granted = await adminCall(`/api/admin/promotions/${promoId}/grant`, {
      method: "POST",
      body: { customer_ids: [customerId] },
    });
    expect(granted.status).toBe(200);
    const result = (await granted.json()) as { granted: number; total: number };
    expect(result.granted).toBe(1);
    expect(result.total).toBe(1);

    // ① 订阅参数真的变了：+7 天、+5 GB
    const after = await snapshotOf(customerId);
    expect((Date.parse(after!.expires_at!) - Date.parse(before!.expires_at!)) / 86_400_000).toBe(7);
    expect(after!.period_extra_gb).toBe((before!.period_extra_gb ?? 0) + 5);

    // ② 账簿上留下了一张 0 元已付订单（否则财务永远解释不了这 7 天）
    const order = await env.DB.prepare(
      `SELECT amount_minor, status, source, promotion_id FROM orders
        WHERE customer_id = ? AND source = 'gift'`,
    )
      .bind(customerId)
      .first<{ amount_minor: number; status: string; source: string; promotion_id: number }>();
    expect(order).toBeTruthy();
    expect(order!.amount_minor).toBe(0);
    expect(order!.status).toBe("paid");
    expect(order!.promotion_id).toBe(promoId);

    // ③ 变更留痕：action = gift
    const change = await env.DB.prepare(
      `SELECT action FROM subscription_changes WHERE customer_id = ? ORDER BY id DESC LIMIT 1`,
    )
      .bind(customerId)
      .first<{ action: string }>();
    expect(change?.action).toBe("gift");

    // ④ 再发一次：本人次数用完 ⇒ 跳过，且**不产生第二张订单**
    const again = await adminCall(`/api/admin/promotions/${promoId}/grant`, {
      method: "POST",
      body: { customer_ids: [customerId] },
    });
    expect(((await again.json()) as { granted: number }).granted).toBe(0);
    const count = await env.DB.prepare(
      `SELECT COUNT(*) AS n FROM orders WHERE customer_id = ? AND source = 'gift'`,
    )
      .bind(customerId)
      .first<{ n: number }>();
    expect(Number(count?.n ?? 0)).toBe(1);
  });

  it("没有订阅的人：跳过并给理由，不建订单", async () => {
    const promoId = await createPromotion({
      name: "空订阅礼包",
      kind: "gift",
      audience: "all",
      rewards: { days: 3 },
    });

    const email = GIFT_NO_SUB;
    await login(email); // 只注册，不买
    const customerId = await customerIdOf(email);

    const res = await adminCall(`/api/admin/promotions/${promoId}/grant`, {
      method: "POST",
      body: { customer_ids: [customerId] },
    });
    const body = (await res.json()) as {
      granted: number;
      results: { granted: boolean; skipped: string | null }[];
    };
    expect(body.granted).toBe(0);
    expect(body.results[0]?.skipped).toContain("套餐");

    // 没发出去就**不能留 0 元订单**（否则财务会看到一张对不上权益的单）
    const orders = await env.DB.prepare(
      `SELECT COUNT(*) AS n FROM orders WHERE customer_id = ? AND source = 'gift'`,
    )
      .bind(customerId)
      .first<{ n: number }>();
    expect(Number(orders?.n ?? 0)).toBe(0);
  });

  it("注册礼包（audience=new）：首单开通后自动发，且只发一次", async () => {
    const promoId = await createPromotion({
      name: "新人礼包",
      kind: "gift",
      audience: "new",
      rewards: { gb: 2 },
    });

    const email = GIFT_SIGNUP;
    const token = await login(email);
    await payOrder(token, "promo_30d");
    const customerId = await customerIdOf(email);

    const mine = await env.DB.prepare(
      `SELECT COUNT(*) AS n FROM orders WHERE customer_id = ? AND source = 'gift' AND promotion_id = ?`,
    )
      .bind(customerId, promoId)
      .first<{ n: number }>();
    expect(Number(mine?.n ?? 0)).toBe(1);

    const sub = await snapshotOf(customerId);
    expect(sub!.period_extra_gb).toBe(2);
  });
});

/**
 * 兑换码（契约 §2.9.7）
 *
 * 要钉住的：码错/用完/重复/限流都不抛 5xx（一律 200 + reason），
 * 以及**没有订阅的新客能用载体套餐 0 元开户** —— 这正是「发码领 7 天」的主场景。
 */
describe("兑换码", () => {
  const customerIdOf = async (email: string): Promise<number> => {
    const row = await env.DB.prepare(`SELECT id FROM customers WHERE email = ?`)
      .bind(email)
      .first<{ id: number }>();
    expect(row, `客户应存在：${email}`).toBeTruthy();
    return row!.id;
  };

  const redeem = (token: string, code: string) =>
    appCall("/api/app/v1/redeem", token, { method: "POST", body: { code } });

  /** 隐藏套餐 = 后台赠送专用（契约：绝不出现在 /plans） */
  const insertHiddenPlan = async (id: string, termDays: number) => {
    const now = new Date().toISOString();
    await env.DB.prepare(
      `INSERT INTO plans (id, name, kind, price_minor, currency, licence_limit, term_days,
         monthly_quota_gb, line_ids, sort_order, status, visibility, created_at, updated_at)
       VALUES (?, ?, 'period', 0, 'CNY', 1, ?, 20, '[]', 900, 'active', 'hidden', ?, ?)`,
    )
      .bind(id, `体验 ${termDays} 天`, termDays, now, now)
      .run();
  };

  it("有订阅：加权益 + 0 元订单；重复兑被挡；码错不抛 5xx", async () => {
    const promoId = await createPromotion({
      name: "国庆福利",
      kind: "gift",
      code: "GUOQING7",
      audience: "all",
      rewards: { days: 3, gb: 1 },
      max_uses: 100,
    });

    const email = REDEEM_WITH_SUB;
    const token = await login(email);
    await payOrder(token, "promo_30d");
    const customerId = await customerIdOf(email);

    const before = await env.DB.prepare(
      `SELECT expires_at FROM platform_subscriptions WHERE customer_id = ?`,
    )
      .bind(customerId)
      .first<{ expires_at: string }>();

    // 大小写不敏感（用户手输常是小写）
    const ok = await redeem(token, "guoqing7");
    expect(ok.status).toBe(200);
    const body = (await ok.json()) as {
      ok: boolean;
      promotion_name: string;
      opened: boolean;
      applied: { days: number; gb: number };
    };
    expect(body.ok).toBe(true);
    expect(body.promotion_name).toBe("国庆福利");
    expect(body.opened).toBe(false);
    expect(body.applied.days).toBe(3);

    const after = await env.DB.prepare(
      `SELECT expires_at, period_extra_gb FROM platform_subscriptions WHERE customer_id = ?`,
    )
      .bind(customerId)
      .first<{ expires_at: string; period_extra_gb: number }>();
    expect((Date.parse(after!.expires_at) - Date.parse(before!.expires_at)) / 86_400_000).toBe(3);

    const giftOrders = await env.DB.prepare(
      `SELECT COUNT(*) AS n FROM orders WHERE customer_id = ? AND source = 'gift' AND promotion_id = ?`,
    )
      .bind(customerId, promoId)
      .first<{ n: number }>();
    expect(Number(giftOrders?.n ?? 0)).toBe(1);

    // 同一人再兑一次 ⇒ 每人次数用完（默认 1），仍然是 200 + reason
    const again = await redeem(token, "GUOQING7");
    expect(again.status).toBe(200);
    const againBody = (await again.json()) as { ok: boolean; reason: string };
    expect(againBody.ok).toBe(false);
    expect(againBody.reason).toBeTruthy();

    // 不存在的码：200 + reason（不是 404/500），且**不泄露**"码不存在"与"已结束"的区别
    const bad = await redeem(token, "NOSUCHCODE");
    expect(bad.status).toBe(200);
    const badBody = (await bad.json()) as { ok: boolean; reason: string };
    expect(badBody.ok).toBe(false);
    expect(badBody.reason).toContain("兑换码");
  });

  it("新客没有订阅：用载体套餐 0 元开户，有效期由礼包天数决定", async () => {
    await insertHiddenPlan("trial_7d", 30); // 套餐写 30 天，礼包说 7 天 ⇒ 以礼包为准
    await createPromotion({
      name: "新人 7 天体验",
      kind: "gift",
      code: "TRY7DAYS",
      audience: "all",
      rewards: { days: 7 },
      plan_id: "trial_7d",
      max_uses: 50,
    });

    const email = REDEEM_NEW_USER;
    const token = await login(email);
    const customerId = await customerIdOf(email);

    const res = await redeem(token, "TRY7DAYS");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; opened: boolean; expires_at: string };
    expect(body.ok).toBe(true);
    expect(body.opened).toBe(true);

    const sub = await env.DB.prepare(
      `SELECT plan_id, expires_at, paid_minor, licence_limit FROM platform_subscriptions WHERE customer_id = ?`,
    )
      .bind(customerId)
      .first<{ plan_id: string; expires_at: string; paid_minor: number; licence_limit: number }>();
    expect(sub?.plan_id).toBe("trial_7d");
    expect(sub?.paid_minor).toBe(0); // 0 元开户，残值计算不受影响
    expect(sub?.licence_limit).toBe(1); // 设备数来自载体套餐
    const days = Math.round((Date.parse(sub!.expires_at) - Date.now()) / 86_400_000);
    expect(days).toBe(7);

    // 隐藏套餐绝不能被买：/plans 里不应出现
    const plans = (await (await appCall("/api/app/v1/plans", token)).json()) as {
      plan_id: string;
    }[];
    expect(plans.some((p) => p.plan_id === "trial_7d")).toBe(false);
  });

  it("没有订阅又没配载体套餐：200 + 理由，且不生成订单", async () => {
    await createPromotion({
      name: "无载体礼包",
      kind: "gift",
      code: "NOPLAN99",
      audience: "all",
      rewards: { days: 3 },
    });

    const email = REDEEM_NO_PLAN;
    const token = await login(email);
    const customerId = await customerIdOf(email);

    const res = await redeem(token, "NOPLAN99");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; reason: string };
    expect(body.ok).toBe(false);
    expect(body.reason).toContain("套餐");

    const orders = await env.DB.prepare(
      `SELECT COUNT(*) AS n FROM orders WHERE customer_id = ? AND source = 'gift'`,
    )
      .bind(customerId)
      .first<{ n: number }>();
    expect(Number(orders?.n ?? 0)).toBe(0);
  });

  it("猜码过频：超过 5 次失败返回 429（带 Retry-After）", async () => {
    const token = await login(REDEEM_BRUTE);
    for (let i = 0; i < 5; i += 1) {
      const r = await redeem(token, `WRONG${i}XX`);
      expect(r.status).toBe(200);
    }
    const blocked = await redeem(token, "WRONG9XX");
    expect(blocked.status).toBe(429);
    expect(blocked.headers.get("Retry-After")).toBeTruthy();
    const body = (await blocked.json()) as { error: string };
    expect(body.error).toBe("too_many_attempts");
  });

  it("未登录：401（不暴露码是否存在）", async () => {
    const res = await fetchJson("/api/app/v1/redeem", { method: "POST", body: { code: "GUOQING7" } });
    expect(res.status).toBe(401);
  });
});

/**
 * 批次码（契约 §2.9.7）：一个活动 N 个码，一码一人。
 *
 * 要钉住的是"**码本身是一行数据**"带来的三件事：
 * 生成一批、按码统计用量、单独作废。
 */
describe("批次码", () => {
  const genCodes = (promoId: number, count: number, extra: Record<string, unknown> = {}) =>
    adminCall(`/api/admin/promotions/${promoId}/codes`, {
      method: "POST",
      body: { count, ...extra },
    });

  it("生成 10 个码：唯一、可列、用量从 0 开始", async () => {
    const promoId = await createPromotion({
      name: "渠道批次礼包",
      kind: "gift",
      audience: "all",
      rewards: { days: 1 },
    });

    const res = await genCodes(promoId, 10, { prefix: "TG" });
    expect(res.status).toBe(201);
    const body = (await res.json()) as { codes: { id: number; code: string }[]; requested: number };
    expect(body.codes).toHaveLength(10);
    expect(new Set(body.codes.map((c) => c.code)).size).toBe(10);
    expect(body.codes.every((c) => c.code.startsWith("TG"))).toBe(true);

    const listed = (await (await adminCall(`/api/admin/promotions/${promoId}/codes`)).json()) as {
      codes: { code: string; used: number; status: string }[];
    };
    expect(listed.codes).toHaveLength(10);
    expect(listed.codes.every((c) => c.used === 0 && c.status === "active")).toBe(true);
  });

  it("一码一人：同一个码第二个人兑不了（但不同码可以）", async () => {
    const promoId = await createPromotion({
      name: "批次兑换码",
      kind: "gift",
      audience: "all",
      rewards: { days: 2 },
      plan_id: "trial_7d",
    });
    const { codes } = (await (await genCodes(promoId, 2)).json()) as {
      codes: { id: number; code: string }[];
    };

    const a = await login(BATCH_A);
    const ok1 = await appCall("/api/app/v1/redeem", a, { method: "POST", body: { code: codes[0]!.code } });
    expect(((await ok1.json()) as { ok: boolean }).ok).toBe(true);

    // 同一个人换一个码再兑：仍可（活动 max_uses_per_customer 默认 1 ⇒ 被挡）
    // 所以这里换**另一个人**用同一个码 —— 应当因为"码已用完"被拒
    const b = await login(BATCH_B);
    const reuse = await appCall("/api/app/v1/redeem", b, { method: "POST", body: { code: codes[0]!.code } });
    expect(reuse.status).toBe(200);
    const reused = (await reuse.json()) as { ok: boolean; reason: string };
    expect(reused.ok).toBe(false);
    expect(reused.reason).toContain("领完");

    // 用第二个码就应该成功
    const ok2 = await appCall("/api/app/v1/redeem", b, { method: "POST", body: { code: codes[1]!.code } });
    expect(((await ok2.json()) as { ok: boolean }).ok).toBe(true);

    // 用量能对上
    const listed = (await (await adminCall(`/api/admin/promotions/${promoId}/codes`)).json()) as {
      codes: { code: string; used: number }[];
    };
    expect(listed.codes.map((c) => c.used)).toEqual([1, 1]);
  });

  it("作废：作废后立即失效", async () => {
    const promoId = await createPromotion({
      name: "作废测试",
      kind: "gift",
      audience: "all",
      rewards: { days: 1 },
      plan_id: "trial_7d",
    });
    const { codes } = (await (await genCodes(promoId, 1)).json()) as {
      codes: { id: number; code: string }[];
    };

    const revoke = await adminCall(`/api/admin/promotions/${promoId}/codes/${codes[0]!.id}`, {
      method: "DELETE",
    });
    expect(revoke.status).toBe(200);

    const token = await login(BATCH_C);
    const res = await appCall("/api/app/v1/redeem", token, {
      method: "POST",
      body: { code: codes[0]!.code },
    });
    const body = (await res.json()) as { ok: boolean };
    expect(body.ok).toBe(false);
  });

  it("优惠券也能用批次码结账（一码一人，用量记在码上）", async () => {
    const promoId = await createPromotion({
      name: "渠道大额券",
      kind: "coupon",
      // v19：要发码就必须是凭码活动（自动生效与发码互斥）
      auto_apply: false,
      benefit_type: "amount",
      // 要比自动活动更划算，否则会命中自动活动（多活动取更优）
      benefit_value: 500,
      audience: "all",
    });
    const { codes } = (await (await genCodes(promoId, 1)).json()) as {
      codes: { id: number; code: string }[];
    };

    const token = await login(BATCH_COUPON);
    const quote = await appCall("/api/app/v1/quote", token, {
      method: "POST",
      body: { plan_id: "promo_30d", promo_code: codes[0]!.code },
    });
    const q = (await quote.json()) as { allowed: boolean; payable_minor: number; reason: string };
    expect(q.allowed, q.reason).toBe(true);
    expect(q.payable_minor).toBe(1000); // 1500 - 500

    // 走完整下单 + 支付，核销后码的用量应为 1
    await payOrder(token, "promo_30d", codes[0]!.code);
    const listed = (await (await adminCall(`/api/admin/promotions/${promoId}/codes`)).json()) as {
      codes: { used: number }[];
    };
    expect(listed.codes[0]?.used).toBe(1);
  });
});
