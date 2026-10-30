/**
 * 集成测试：测试网关（mock）的完整链路
 *
 * 真 D1、真路由、真签名：
 *   下单 → 演示页 → 点「模拟支付成功」 → 回调（验签+金额核对） → 订单 active + 订阅生效
 *
 * 这条链路的价值：后面接真实网关时，**除了驱动之外的所有环节都已经验证过**。
 */
import { exports as rawExports } from "cloudflare:workers";
import { beforeAll, describe, expect, it } from "vitest";

import { sha256Hex } from "../../src/admin/crypto";
import { createCharge } from "../../src/payments/checkout";
import { handlePayNotify } from "../../src/payments/notify";
import { provisionOrder } from "../../src/platform/provision";
import { EPAY_V1_MAPPING } from "../../src/payments/builtin/epay";
import { encryptSecret } from "../../src/payments/secret";
import { signParams } from "../../src/payments/sign";
import { env } from "./apply-migrations";
import { installFakeCfApi } from "./fake-cf-api";

import type { FakeCfApi } from "./fake-cf-api";

import type { Plan } from "../../src/plans/model";

const BASE = "https://crm.test";
const PAYER = "payer@test.com";
const OTHER = "stranger@test.com";
const TOKEN = "test-session-token-payer";

const worker = rawExports as unknown as {
  default: { fetch(request: Request): Promise<Response> };
};

const now = () => new Date().toISOString();

/** 假 cf-api；`beforeAll` 里赋值，`/subscription` 与平台侧断言都用它 */
let cf: FakeCfApi;

function call(path: string, init: { method?: string; body?: unknown; token?: string } = {}) {
  const headers: Record<string, string> = {};
  if (init.body !== undefined) headers["content-type"] = "application/json";
  if (init.token) headers.authorization = `Bearer ${init.token}`;
  return worker.default.fetch(
    new Request(`${BASE}${path}`, {
      method: init.method ?? "GET",
      headers,
      body: init.body === undefined ? undefined : JSON.stringify(init.body),
    }),
  );
}

async function seedCustomer(email: string, token: string): Promise<number> {
  const res = await env.DB.prepare(
    `INSERT INTO customers (email, status, created_at) VALUES (?, 'active', ?)`,
  )
    .bind(email, now())
    .run();
  const id = Number(res.meta.last_row_id ?? 0);
  await env.DB.prepare(
    `INSERT INTO app_sessions (id, customer_id, created_at, last_used_at) VALUES (?, ?, ?, ?)`,
  )
    .bind(await sha256Hex(token), id, now(), now())
    .run();
  return id;
}

beforeAll(async () => {
  // 第一道闸门：打开 mock
  (env as unknown as Record<string, unknown>).ALLOW_MOCK_PAYMENTS = "true";

  // 平台落账：没有 cf-api 就只能是 provisioning（这是契约行为），
  // 所以这里装一个假平台，让付款后真的能拿到 code。
  const cfApi = installFakeCfApi();
  cf = cfApi;
  (env as unknown as Record<string, unknown>).CF_API_BASE = cfApi.base;
  (env as unknown as Record<string, unknown>).CF_API_TOKEN = cfApi.token;

  await env.DB.batch([
    env.DB.prepare(
      `INSERT INTO payment_gateways (driver, name, endpoint, merchant_id, secret_enc, methods,
         mapping, priority, status, currency, allowed_emails, created_at, updated_at)
       VALUES ('mock', '测试网关（演示）', NULL, 'MOCK-M1', NULL, '["alipay","wechat"]',
         NULL, 999, 'live', 'CNY', ?, ?, ?)`,
    ).bind(JSON.stringify([PAYER]), now(), now()),
    env.DB.prepare(
      `INSERT INTO plans (id, name, kind, price_minor, currency, licence_limit, term_days,
         monthly_quota_gb, traffic_gb, validity_days, line_ids, sales_channels,
         store_product_id, sort_order, status, visibility, created_at, updated_at)
       VALUES ('pay_plan_30d', '月付 · 测试', 'period', 1500, 'CNY', 1, 30, 100, NULL, NULL,
         '[]', '[{"channel":"web_checkout","methods":["alipay"]}]', '{}', 1, 'active', 'public', ?, ?)`,
    ).bind(now(), now()),
  ]);

  await seedCustomer(PAYER, TOKEN);
  await seedCustomer(OTHER, "test-session-token-other");
});

describe("契约 v11：/plans 只给一个 action", () => {
  const OTHER_TOKEN = "test-session-token-other";

  it("匿名：能看商品与标价，但 action=login_required 且没有应付", async () => {
    const res = await call("/api/app/v1/plans");
    expect(res.status).toBe(200);
    const items = (await res.json()) as Record<string, unknown>[];
    expect(items.length).toBeGreaterThan(0);
    for (const p of items) {
      expect(p.action).toBe("login_required");
      expect(p.payable_minor).toBeNull();
      expect(p.price_minor).toBeGreaterThan(0);
      // 旧口径必须彻底消失
      expect(p).not.toHaveProperty("purchasable");
      expect(p).not.toHaveProperty("allow_addons");
      expect(p).not.toHaveProperty("residual_minor");
    }
  });

  it("登录但没订阅过：主套餐 buy + 目录价", async () => {
    const res = await call("/api/app/v1/plans", { token: OTHER_TOKEN });
    const items = (await res.json()) as {
      plan_id: string;
      action: string;
      payable_minor: number | null;
    }[];
    const plan = items.find((p) => p.plan_id === "pay_plan_30d");
    expect(plan?.action).toBe("buy");
    expect(plan?.payable_minor).toBe(1500);
  });

  it("expected_payable_minor 与报价不符 → 409 price_changed", async () => {
    const res = await call("/api/app/v1/orders", {
      method: "POST",
      token: OTHER_TOKEN,
      body: { plan_id: "pay_plan_30d", payment_method: "alipay", expected_payable_minor: 1 },
    });
    expect(res.status).toBe(409);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("price_changed");
  });
});

describe("支付方式列表受白名单约束", () => {
  it("白名单内的客户能看到 alipay/wechat", async () => {
    const res = await call("/api/app/v1/payment-methods", { token: TOKEN });
    expect(res.status).toBe(200);
    const items = (await res.json()) as { id: string; label: string; channel: string }[];
    expect(items.map((i) => i.id).sort()).toEqual(["alipay", "wechat"]);
    expect(items.find((i) => i.id === "alipay")?.label).toBe("支付宝");
    // channel 是支付方式的属性，不是订单入参（v11）
    expect(items.every((i) => i.channel === "web_checkout")).toBe(true);
  });

  it("白名单外的客户看不到（否则等于免费开通）", async () => {
    const res = await call("/api/app/v1/payment-methods", { token: "test-session-token-other" });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual([]);
  });

  it("未登录直接 401（白名单按用户算，匿名给不出）", async () => {
    const res = await call("/api/app/v1/payment-methods");
    expect(res.status).toBe(401);
  });
});

describe("mock 支付全链路", () => {
  it("下单 → 演示页 → 模拟支付 → 订阅生效", async () => {
    // 1. 下单
    const created = await call("/api/app/v1/orders", {
      method: "POST",
      token: TOKEN,
      body: { plan_id: "pay_plan_30d", payment_method: "alipay" },
    });
    expect(created.status).toBe(201);
    const order = (await created.json()) as {
      order_code: string;
      pay_url: string;
      amount_minor: number;
      reused: boolean;
    };
    expect(order.amount_minor).toBe(1500);
    expect(order.reused).toBe(false);
    expect(order.pay_url).toContain("/pay/mock/");

    // 2. 演示页
    const page = await worker.default.fetch(new Request(order.pay_url));
    expect(page.status).toBe(200);
    const html = await page.text();
    expect(html).toContain("演示模式");
    expect(html).toContain("支付宝");

    // 3. 模拟支付成功（服务端自己构造带签名的回调）
    const paid = await worker.default.fetch(
      new Request(`${order.pay_url}/paid`, { method: "POST" }),
    );
    expect(paid.status).toBe(200);
    expect(await paid.text()).toContain("已模拟支付成功");

    // 4. 订单与订阅
    const row = await env.DB.prepare(`SELECT status, subscription_id, paid_at FROM orders WHERE code = ?`)
      .bind(order.order_code)
      .first<{ status: string; subscription_id: number | null; paid_at: string | null }>();
    expect(row?.status).toBe("active");
    expect(row?.paid_at).toBeTruthy();
    expect(row?.subscription_id).toBeGreaterThan(0);

    // 状态是算出来的，库里只有 hold（没人冻它就还是 none）
    const sub = await env.DB.prepare(
      `SELECT plan_id, hold, expires_at, paid_minor FROM platform_subscriptions WHERE id = ?`,
    )
      .bind(row?.subscription_id ?? 0)
      .first<{ plan_id: string; hold: string; expires_at: string | null; paid_minor: number }>();
    expect(sub).toMatchObject({ plan_id: "pay_plan_30d", hold: "none", paid_minor: 1500 });
    expect(Date.parse(sub?.expires_at ?? "")).toBeGreaterThan(Date.now());
  });

  it("重复点「模拟支付」不会重复发货", async () => {
    const created = await call("/api/app/v1/orders", {
      method: "POST",
      token: TOKEN,
      body: { plan_id: "pay_plan_30d", payment_method: "wechat" },
    });
    const order = (await created.json()) as { order_code: string; pay_url: string };

    const before = await env.DB.prepare(
      `SELECT COUNT(*) AS n FROM platform_subscriptions WHERE plan_id = 'pay_plan_30d'`,
    ).first<{ n: number }>();

    await worker.default.fetch(new Request(`${order.pay_url}/paid`, { method: "POST" }));
    const second = await worker.default.fetch(new Request(`${order.pay_url}/paid`, { method: "POST" }));
    expect(second.status).toBe(200); // 已处理过，页面只是提示

    const after = await env.DB.prepare(
      `SELECT COUNT(*) AS n FROM platform_subscriptions WHERE plan_id = 'pay_plan_30d'`,
    ).first<{ n: number }>();
    // 单行模型：订阅本来就只有一行，重复回调不该多出任何东西
    expect(after?.n).toBe(before?.n ?? 0);
  });

  it("60 秒内重复下单复用同一张单（防双击）", async () => {
    const a = await call("/api/app/v1/orders", {
      method: "POST",
      token: TOKEN,
      body: { plan_id: "pay_plan_30d", payment_method: "alipay" },
    });
    const b = await call("/api/app/v1/orders", {
      method: "POST",
      token: TOKEN,
      body: { plan_id: "pay_plan_30d", payment_method: "alipay" },
    });
    const oa = (await a.json()) as { order_code: string };
    const ob = (await b.json()) as { order_code: string; reused: boolean };
    expect(ob.reused).toBe(true);
    expect(ob.order_code).toBe(oa.order_code);
  });

  it("白名单外的客户下单被拒（路由闸门）", async () => {
    const res = await call("/api/app/v1/orders", {
      method: "POST",
      token: "test-session-token-other",
      body: { plan_id: "pay_plan_30d", payment_method: "alipay" },
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("payment_method_unavailable");
  });

  it("回调签名被改 → 403，且订单不变", async () => {
    const created = await call("/api/app/v1/orders", {
      method: "POST",
      token: TOKEN,
      body: { plan_id: "pay_plan_30d", payment_method: "alipay" },
    });
    const order = (await created.json()) as { order_code: string };

    const gw = await env.DB.prepare(`SELECT id FROM payment_gateways WHERE driver = 'mock'`)
      .first<{ id: number }>();
    const forged = new URLSearchParams({
      mch: "MOCK-M1",
      out_trade_no: order.order_code,
      amount: "1",
      status: "SUCCESS",
      sign: "deadbeef",
    });
    const res = await worker.default.fetch(
      new Request(`${BASE}/api/pay/notify/${gw?.id}`, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: forged.toString(),
      }),
    );
    expect(res.status).toBe(403);

    const row = await env.DB.prepare(`SELECT status FROM orders WHERE code = ?`)
      .bind(order.order_code)
      .first<{ status: string }>();
    expect(row?.status).toBe("pending");
  });
});

// ─────────────────────────────────────────────────────────────
// 真实网关（epay_v1）：证明"解密 → 签名 → 下单 → 回调 → 查单"整条路径可用
// 出网请求用 stub 替代（测试环境不联外网）
// ─────────────────────────────────────────────────────────────

describe("真实网关 epay_v1（密钥加密 + 查单复核）", () => {
  const EPAY_KEY = "epay-secret-xyz";
  const EPAY_MERCHANT = "M9";
  const EPAY_PAYER = "epay@test.com";
  const EPAY_TOKEN = "test-session-token-epay";
  let gatewayId = 0;
  let customerId = 0;

  const plan: Plan = {
    id: "pay_plan_30d",
    name: "月付 · 测试",
    kind: "period",
    price_minor: 1500,
    currency: "CNY",
    licence_limit: 1,
    term_days: 30,
    monthly_quota_gb: 100,
    traffic_gb: null,
    visibility: "public",
    validity_days: null,
    line_ids: [],
    up_mbps: null,
    down_mbps: null,
    sales_channels: [{ channel: "web_checkout", methods: ["alipay"] }],
    store_product_id: {},
    sort_order: 1,
    status: "active",
    trial: false,
    retired_at: null,
  };

  beforeAll(async () => {
    (env as unknown as Record<string, unknown>).PAYMENT_SECRET_KEY = "master-key-for-tests";
    const cipher = await encryptSecret(env, EPAY_KEY);
    expect(cipher).toMatch(/^v1:/);

    const res = await env.DB.prepare(
      `INSERT INTO payment_gateways (driver, name, endpoint, merchant_id, secret_enc, methods,
         mapping, priority, status, currency, allowed_emails, created_at, updated_at)
       VALUES ('epay_v1', '易支付-测试', 'https://pay.example.com', ?, ?, '["alipay"]',
         NULL, 500, 'live', 'CNY', ?, ?, ?)`,
    )
      .bind(EPAY_MERCHANT, cipher, JSON.stringify([EPAY_PAYER]), now(), now())
      .run();
    gatewayId = Number(res.meta.last_row_id ?? 0);

    customerId = await seedCustomer(EPAY_PAYER, EPAY_TOKEN);
  });

  it("没有主密钥时明确拒绝，不拿空密钥去签名", async () => {
    const saved = (env as unknown as Record<string, unknown>).PAYMENT_SECRET_KEY;
    (env as unknown as Record<string, unknown>).PAYMENT_SECRET_KEY = "";
    const r = await createCharge(env, {
      customerId,
      customerEmail: EPAY_PAYER,
      plan,
      method: "alipay",
      origin: BASE,
    });
    (env as unknown as Record<string, unknown>).PAYMENT_SECRET_KEY = saved;
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe("gateway_not_ready");
  });

  it("下单：请求带正确签名，pay_url 取自网关响应", async () => {
    let sent = "";
    let sentUrl = "";
    const stub = (async (url: string, init: RequestInit) => {
      sentUrl = url;
      sent = String(init.body ?? "");
      return new Response(JSON.stringify({ code: 1, payurl: "https://cashier.example.com/p/1", trade_no: "T1" }), {
        headers: { "content-type": "application/json" },
      });
    }) as unknown as typeof fetch;

    const r = await createCharge(
      env,
      { customerId, customerEmail: EPAY_PAYER, plan, method: "alipay", origin: BASE, fetch: stub },
      );
    expect(r.ok).toBe(true);
    if (!r.ok) return;

    expect(sentUrl).toBe("https://pay.example.com/mapi.php");
    const body = new URLSearchParams(sent);
    expect(body.get("pid")).toBe(EPAY_MERCHANT);
    expect(body.get("money")).toBe("15.00");
    expect(body.get("type")).toBe("alipay");
    // 签名用解密出来的密钥（而不是密文）
    expect(body.get("sign")).toBe(signParams(Object.fromEntries(body), EPAY_KEY, EPAY_V1_MAPPING.sign!));

    const row = await env.DB.prepare(
      `SELECT pay_url, provider_order_no, status, gateway_id FROM orders WHERE code = ?`,
    )
      .bind(r.orderCode)
      .first<{ pay_url: string; provider_order_no: string; status: string; gateway_id: number }>();
    expect(row).toMatchObject({
      pay_url: "https://cashier.example.com/p/1",
      provider_order_no: r.orderCode,
      status: "pending",
      gateway_id: gatewayId,
    });
  });

  it("回调：签名对但**查单说未付** ⇒ 不认账（回调只是触发器）", async () => {
    const r = await createCharge(env, {
      customerId, customerEmail: EPAY_PAYER, plan, method: "alipay", origin: BASE,
      fetch: (async () =>
        new Response(JSON.stringify({ code: 1, payurl: "https://cashier.example.com/p/2", trade_no: "T2" }), {
          headers: { "content-type": "application/json" },
        })) as unknown as typeof fetch,
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;

    const params: Record<string, string> = {
      pid: EPAY_MERCHANT,
      trade_no: "T3",
      out_trade_no: r.orderCode,
      type: "alipay",
      money: "15.00",
      trade_status: "TRADE_SUCCESS",
    };
    params.sign = signParams(params, EPAY_KEY, EPAY_V1_MAPPING.sign!);
    params.sign_type = "MD5";

    const req = new Request(`${BASE}/api/pay/notify/${gatewayId}?${new URLSearchParams(params)}`);
    const queryStub = (async () =>
      new Response(JSON.stringify({ code: 1, status: 0, money: "15.00" }), {
        headers: { "content-type": "application/json" },
      })) as unknown as typeof fetch;

    const res = await handlePayNotify(env, req, String(gatewayId), { fetch: queryStub });
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("success"); // 应答要逐字一致，否则对方一直重发

    const row = await env.DB.prepare(`SELECT status FROM orders WHERE code = ?`)
      .bind(r.orderCode)
      .first<{ status: string }>();
    expect(row?.status).toBe("pending");
  });

  it("回调：查单说已付 ⇒ 认账并发权益", async () => {
    const r = await createCharge(env, {
      customerId, customerEmail: EPAY_PAYER, plan, method: "alipay", origin: BASE,
      fetch: (async () =>
        new Response(JSON.stringify({ code: 1, payurl: "https://cashier.example.com/p/3", trade_no: "T4" }), {
          headers: { "content-type": "application/json" },
        })) as unknown as typeof fetch,
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;

    const params: Record<string, string> = {
      pid: EPAY_MERCHANT,
      trade_no: "T5",
      out_trade_no: r.orderCode,
      type: "alipay",
      money: "15.00",
      trade_status: "TRADE_SUCCESS",
    };
    params.sign = signParams(params, EPAY_KEY, EPAY_V1_MAPPING.sign!);
    params.sign_type = "MD5";

    const req = new Request(`${BASE}/api/pay/notify/${gatewayId}?${new URLSearchParams(params)}`);
    const queryStub = (async () =>
      new Response(JSON.stringify({ code: 1, status: 1, money: "15.00" }), {
        headers: { "content-type": "application/json" },
      })) as unknown as typeof fetch;

    const res = await handlePayNotify(env, req, String(gatewayId), { fetch: queryStub });
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("success");

    const row = await env.DB.prepare(`SELECT status, subscription_id FROM orders WHERE code = ?`)
      .bind(r.orderCode)
      .first<{ status: string; subscription_id: number | null }>();
    expect(row?.status).toBe("active");
    expect(row?.subscription_id).toBeGreaterThan(0);
  });
});

describe("续订：同一套餐再买一次", () => {
  async function buyAndPay() {
    const created = await call("/api/app/v1/orders", {
      method: "POST",
      token: TOKEN,
      body: { plan_id: "pay_plan_30d", payment_method: "alipay" },
    });
    expect(created.status).toBe(201);
    const order = (await created.json()) as { order_code: string; pay_url: string };
    const pay = await worker.default.fetch(new Request(`${order.pay_url}/paid`, { method: "POST" }));
    expect(pay.status).toBe(200);
    return order;
  }

  // 只看这个客户的行（同一个套餐可能还有别的客户买过）
  const readRow = () =>
    env.DB.prepare(
      `SELECT s.id, s.expires_at, s.paid_minor FROM platform_subscriptions s
         JOIN customers c ON c.id = s.customer_id
        WHERE c.email = ? AND s.plan_id = 'pay_plan_30d'`,
    )
      .bind(PAYER)
      .first<{ id: number; expires_at: string; paid_minor: number }>();

  it("只有一行订阅，到期日往后顺延（不是并存两份）", async () => {
    // 自己先买一次，不依赖其他用例留下的状态
    await buyAndPay();
    const before = await readRow();
    expect(before?.id).toBeGreaterThan(0);

    const order = await buyAndPay();
    const after = await readRow();

    // 同一行（单行模型）
    expect(after?.id).toBe(before?.id);
    // 到期日 = 原到期日 + 30 天
    const deltaDays =
      (Date.parse(after?.expires_at ?? "") - Date.parse(before?.expires_at ?? "")) / 86_400_000;
    expect(Math.round(deltaDays)).toBe(30);

    const rows = await env.DB.prepare(
      `SELECT COUNT(*) AS n FROM platform_subscriptions s
         JOIN customers c ON c.id = s.customer_id
        WHERE c.email = ? AND s.plan_id = 'pay_plan_30d'`,
    )
      .bind(PAYER)
      .first<{ n: number }>();
    expect(rows?.n).toBe(1);

    // 流水里能看出"改之前 / 改之后"，退款回滚靠它
    const change = await env.DB.prepare(
      `SELECT action, expires_before, expires_after FROM subscription_changes
        WHERE detail LIKE ?
        ORDER BY id DESC LIMIT 1`,
    )
      .bind(`%${order.order_code}%`)
      .first<{ action: string; expires_before: string | null; expires_after: string | null }>();
    expect(change?.action).toBe("renewal");
    expect(change?.expires_before).toBe(before?.expires_at);
    expect(change?.expires_after).toBe(after?.expires_at);
  });
});

describe("升级：换成别的套餐（残值抵扣）", () => {
  const UPGRADE_PLAN = "pay_plan_200g";

  beforeAll(async () => {
    await env.DB.prepare(
      `INSERT INTO plans (id, name, kind, price_minor, currency, licence_limit, term_days,
         monthly_quota_gb, traffic_gb, validity_days, line_ids, sales_channels,
         store_product_id, sort_order, status, visibility, created_at, updated_at)
       VALUES (?, '月付 · 200GB 测试', 'period', 4000, 'CNY', 3, 30, 200, NULL, NULL,
         '[]', '[{"channel":"web_checkout","methods":["alipay"]}]', '{}', 9, 'active', 'public', ?, ?)`,
    )
      .bind(UPGRADE_PLAN, now(), now())
      .run();
  });

  it("应付 = 新价 − 残值，且订单金额就是应付；升级后还是同一行", async () => {
    // 先保证有一份 pay_plan_30d 生效中
    const created = await call("/api/app/v1/orders", {
      method: "POST",
      token: TOKEN,
      body: { plan_id: "pay_plan_30d", payment_method: "alipay" },
    });
    const base = (await created.json()) as { pay_url: string };
    await worker.default.fetch(new Request(`${base.pay_url}/paid`, { method: "POST" }));

    const before = await env.DB.prepare(
      `SELECT s.id, s.plan_id, s.paid_minor FROM platform_subscriptions s
         JOIN customers c ON c.id = s.customer_id WHERE c.email = ?`,
    )
      .bind(PAYER)
      .first<{ id: number; plan_id: string; paid_minor: number }>();
    expect(before?.plan_id).toBe("pay_plan_30d");

    // /plans 只说“这是 upgrade”，金额必须点开走 /quote（列表不泄露残值）
    const list = await call("/api/app/v1/plans", { token: TOKEN });
    const plans = (await list.json()) as {
      plan_id: string;
      action: string;
      payable_minor: number | null;
      next_expires_at: string | null;
    }[];
    const up = plans.find((p) => p.plan_id === UPGRADE_PLAN);
    expect(up?.action).toBe("upgrade");
    expect(up?.payable_minor).toBeNull();
    expect(up?.next_expires_at).toBeNull();

    const quoted = await call("/api/app/v1/quote", {
      method: "POST",
      token: TOKEN,
      body: { plan_id: UPGRADE_PLAN },
    });
    expect(quoted.status).toBe(200);
    const quote = (await quoted.json()) as {
      action: string;
      payable_minor: number;
      residual_minor: number;
      price_minor: number;
      quote_ttl_s: number;
      quoted_at: string;
    };
    expect(quote.action).toBe("upgrade");
    expect(quote.price_minor).toBe(4000);
    expect(quote.payable_minor).toBeGreaterThan(0);
    expect(quote.payable_minor).toBeLessThan(4000); // 抵掉了残值
    expect(quote.quote_ttl_s).toBe(900);
    expect(Date.parse(quote.quoted_at)).toBeGreaterThan(0);

    const ordered = await call("/api/app/v1/orders", {
      method: "POST",
      token: TOKEN,
      body: {
        plan_id: UPGRADE_PLAN,
        payment_method: "alipay",
        expected_payable_minor: quote.payable_minor,
      },
    });
    expect(ordered.status).toBe(201);
    const order = (await ordered.json()) as { order_code: string; pay_url: string; amount_minor: number };
    // 收的钱必须是应付，不是目录价 4000
    expect(order.amount_minor).toBe(quote.payable_minor);

    await worker.default.fetch(new Request(`${order.pay_url}/paid`, { method: "POST" }));

    const after = await env.DB.prepare(
      `SELECT s.id, s.plan_id, s.paid_minor FROM platform_subscriptions s
         JOIN customers c ON c.id = s.customer_id WHERE c.email = ?`,
    )
      .bind(PAYER)
      .first<{ id: number; plan_id: string; paid_minor: number }>();

    expect(after?.id).toBe(before?.id); // 同一行
    expect(after?.plan_id).toBe(UPGRADE_PLAN);
    expect(after?.paid_minor).toBe(order.amount_minor);

    const change = await env.DB.prepare(
      `SELECT action, plan_before, plan_after, residual_minor FROM subscription_changes
        WHERE detail LIKE ? ORDER BY id DESC LIMIT 1`,
    )
      .bind(`%${order.order_code}%`)
      .first<{ action: string; plan_before: string; plan_after: string; residual_minor: number }>();
    expect(change?.action).toBe("upgrade");
    expect(change?.plan_before).toBe("pay_plan_30d");
    expect(change?.plan_after).toBe(UPGRADE_PLAN);
    expect(change?.residual_minor).toBe(quote.residual_minor);
  });
});

describe("落账：付款后真的拿到码", () => {
  it("订阅 active + 带 code；平台侧写的是字节，quota 恒 NULL", async () => {
    const res = await call("/api/app/v1/subscription", { token: TOKEN });
    expect(res.status).toBe(200);
    const view = (await res.json()) as { status: string; code?: string };
    // 落账成功才会从 provisioning 变成 active，并且此时才下发 code
    expect(view.status).toBe("active");
    expect(view.code).toBeTruthy();

    // 换档会删旧建新（同一 email 可能有多条，只看未删的）
    const payer = [...cf.customers.values()].find((c) => c.email === PAYER && c._is_deleted === 0);
    expect(payer).toBeTruthy();
    // 关键：单位是字节。若误写成 GB（例如 100），下面这条立刻失败
    expect((payer?.traffic_balance ?? 0) % 1024 ** 3).toBe(0);
    expect(payer?.traffic_balance).toBeGreaterThan(0);
    // 月度重置归 CRM：平台的 quota 必须一直是 NULL
    expect(payer?.quota).toBeNull();
  });

  it("平台不可用时：provisionOrder 抛错，订单停在 provisioning", async () => {
    const anyOrder = await env.DB.prepare(
      `SELECT id FROM orders WHERE status = 'active' ORDER BY id ASC LIMIT 1`,
    ).first<{ id: number }>();
    expect(anyOrder).toBeTruthy();
    const orderId = anyOrder!.id;
    await env.DB.prepare(`UPDATE orders SET status = 'provisioning' WHERE id = ?`).bind(orderId).run();

    const backup = (env as unknown as Record<string, unknown>).CF_API_TOKEN;
    (env as unknown as Record<string, unknown>).CF_API_TOKEN = "";
    try {
      await expect(provisionOrder(env, orderId)).rejects.toThrow(/CF_API_TOKEN/);
    } finally {
      (env as unknown as Record<string, unknown>).CF_API_TOKEN = backup;
    }

    const after = await env.DB.prepare(`SELECT status FROM orders WHERE id = ?`)
      .bind(orderId)
      .first<{ status: string }>();
    // 钱已收：失败绝不能把订单推成 active
    expect(after?.status).toBe("provisioning");

    // 恢复现场，避免影响后续用例
    await env.DB.prepare(`UPDATE orders SET status = 'active' WHERE id = ?`).bind(orderId).run();
  });
});

describe("隐藏套餐（礼品包）不能出现在 App 里", () => {
  const HIDDEN = "pay_hidden_gift";

  beforeAll(async () => {
    await env.DB.prepare(
      `INSERT INTO plans (id, name, kind, price_minor, currency, licence_limit, term_days,
         monthly_quota_gb, traffic_gb, validity_days, line_ids, sales_channels,
         store_product_id, sort_order, status, visibility, created_at, updated_at)
       VALUES (?, '礼品包（隐藏）', 'addon', 0, 'CNY', 1, NULL, NULL, 20, NULL,
         '[]', '[{"channel":"web_checkout","methods":["alipay"]}]', '{}', 99, 'active', 'hidden', ?, ?)`,
    )
      .bind(HIDDEN, now(), now())
      .run();
  });

  it("列表里看不到", async () => {
    const res = await call("/api/app/v1/plans", { token: TOKEN });
    const plans = (await res.json()) as { plan_id: string }[];
    expect(plans.some((p) => p.plan_id === HIDDEN)).toBe(false);
  });

  it("直接拿 id 下单也下不了（404）", async () => {
    const res = await call("/api/app/v1/orders", {
      method: "POST",
      token: TOKEN,
      body: { plan_id: HIDDEN, payment_method: "alipay" },
    });
    expect(res.status).toBe(404);
  });
});
