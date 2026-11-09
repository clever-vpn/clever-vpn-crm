/**
 * `/plans[].payment_methods` —— 支付按钮按**这个访客**算
 *
 * 四条要钉住的（契约 §2.4.5）：
 *   1. 公开网关（白名单为空）对谁都可见，游客也算；
 *   2. 私有网关（白名单非空）**只对名单内的登录用户**可见；
 *   3. **`driver='mock'` 白名单为空 ⇒ 对任何人都不存在**（含登录用户）——
 *      这条是"测试网关不能被访客碰到"的底线，即使有人绕过后台发布检查写进了库；
 *   4. `draft` 永远不算；交集仍在服务端算，客户端不参与。
 */
import { exports as rawExports } from "cloudflare:workers";
import { beforeAll, describe, expect, it } from "vitest";

import { sha256Hex } from "../../src/admin/crypto";
import { env } from "./apply-migrations";

const BASE = "https://crm.test";
const TOKEN = "session-plan-payment-methods";
/** 白名单里的那个测试账号 */
const TESTER_TOKEN = "session-plan-payment-methods-tester";

const worker = rawExports as unknown as {
  default: { fetch(request: Request): Promise<Response> };
};

const now = () => new Date().toISOString();

function call(path: string, init: { token?: string } = {}) {
  const headers: Record<string, string> = {};
  if (init.token) headers.authorization = `Bearer ${init.token}`;
  return worker.default.fetch(new Request(`${BASE}${path}`, { headers }));
}

interface PlanView {
  plan_id: string;
  payment_methods: { id: string; label: string; icon_url: string | null }[] | null;
}

async function seedGateway(opts: {
  name: string;
  methods: string[];
  allowedEmails: string[] | null;
  status?: "live" | "draft";
  /** 真网关用 `epay_v1`；只有要验"测试网关"时才用 `mock` */
  driver?: "mock" | "epay_v1";
}): Promise<void> {
  await env.DB.prepare(
    `INSERT INTO payment_gateways (driver, name, endpoint, merchant_id, secret_enc, methods,
       mapping, priority, status, currency, allowed_emails, created_at, updated_at)
     VALUES (?, ?, NULL, ?, NULL, ?, NULL, 100, ?, 'CNY', ?, ?, ?)`,
  )
    .bind(
      opts.driver ?? "mock",
      opts.name,
      `M-${opts.name}`,
      JSON.stringify(opts.methods),
      opts.status ?? "live",
      opts.allowedEmails === null ? null : JSON.stringify(opts.allowedEmails),
      now(),
      now(),
    )
    .run();
}

async function seedPlan(id: string, channels: unknown): Promise<void> {
  await env.DB.prepare(
    `INSERT INTO plans (id, name, kind, price_minor, currency, licence_limit, term_days,
       monthly_quota_gb, traffic_gb, validity_days, line_ids, sales_channels,
       store_product_id, sort_order, status, visibility, created_at, updated_at)
     VALUES (?, ?, 'period', 1500, 'CNY', 1, 30, 100, NULL, NULL,
       '[]', ?, '{}', 1, 'active', 'public', ?, ?)`,
  )
    .bind(id, `套餐 ${id}`, JSON.stringify(channels), now(), now())
    .run();
}

beforeAll(async () => {
  (env as unknown as Record<string, unknown>).ALLOW_MOCK_PAYMENTS = "true";

  // 公开网关：谁都能用
  await seedGateway({
    name: "公开-支付宝",
    methods: ["alipay"],
    allowedEmails: null,
    driver: "epay_v1",
  });
  // 私有/测试网关：只有 tester 能用
  await seedGateway({
    name: "私有-微信",
    methods: ["wechat"],
    allowedEmails: ["tester@test.com"],
  });
  // 兜底：即使被强行写成 live，空名单的 mock 也必须对所有人不可见
  await seedGateway({ name: "空名单-mock", methods: ["testpay"], allowedEmails: null });
  // draft 不算
  await seedGateway({
    name: "草稿-银行卡",
    methods: ["card"],
    allowedEmails: null,
    status: "draft",
    driver: "epay_v1",
  });

  await seedPlan("web_all", [
    { channel: "web_checkout", methods: ["alipay", "wechat", "testpay", "card"] },
  ]);
  await seedPlan("store_only", [{ channel: "apple_iap" }]);

  const accounts: Array<[string, string]> = [
    ["buyer@test.com", TOKEN],
    ["tester@test.com", TESTER_TOKEN],
  ];
  for (const [email, token] of accounts) {
    const res = await env.DB.prepare(
      `INSERT INTO customers (uuid, email, status, created_at)
       VALUES (lower(hex(randomblob(16))), ?, 'active', ?)`,
    )
      .bind(email, now())
      .run();
    const customerId = Number(res.meta.last_row_id ?? 0);
    await env.DB.prepare(
      `INSERT INTO app_sessions (id, customer_id, created_at, last_used_at) VALUES (?, ?, ?, ?)`,
    )
      .bind(await sha256Hex(token), customerId, now(), now())
      .run();
  }
});

describe("plans[].payment_methods 按访客算", () => {
  const ids = async (token?: string) => {
    const res = await call("/api/app/v1/plans", { token });
    expect(res.status).toBe(200);
    const plans = (await res.json()) as PlanView[];
    const web = plans.find((p) => p.plan_id === "web_all");
    return (web?.payment_methods ?? []).map((m) => m.id);
  };

  it("游客只看到公开网关", async () => {
    expect(await ids()).toEqual(["alipay"]);
  });

  it("名单外的登录用户也只看到公开网关", async () => {
    expect(await ids(TOKEN)).toEqual(["alipay"]);
  });

  it("名单内的登录用户能看到测试网关", async () => {
    expect(await ids(TESTER_TOKEN)).toEqual(["alipay", "wechat"]);
  });

  it("白名单为空的测试网关对任何人都不存在（含登录用户）", async () => {
    for (const token of [undefined, TOKEN, TESTER_TOKEN]) {
      expect(await ids(token)).not.toContain("testpay");
    }
  });

  it("没有网页渠道的档位给 null（这一档不走网页）", async () => {
    const res = await call("/api/app/v1/plans");
    const plans = (await res.json()) as PlanView[];
    expect(plans.find((p) => p.plan_id === "store_only")?.payment_methods).toBeNull();
  });

  it("不再下发内部的 sales_channels", async () => {
    const res = await call("/api/app/v1/plans");
    const plans = (await res.json()) as (PlanView & Record<string, unknown>)[];
    expect(plans.every((p) => !("sales_channels" in p))).toBe(true);
  });
  it("渲染字段齐全：前端不需要再判断价格能不能买", async () => {
    const plans = (await (await call("/api/app/v1/plans")).json()) as (PlanView & {
      price_minor: number;
      promo_price_minor: number | null;
      display_price_minor: number;
      compare_at_price_minor: number | null;
      buyable: boolean;
      action: string;
    })[];
    expect(plans.length).toBeGreaterThan(0);
    for (const p of plans) {
      // 直接渲染这个价（老 CRM 才有 `?? price_minor` 的兜底）
      expect(p.display_price_minor).toBe(p.promo_price_minor ?? p.price_minor);
      // 只有活动价**真的更低**才给划线价，否则 100→100 是假折扣
      expect(p.compare_at_price_minor).toBe(
        p.promo_price_minor !== null && p.promo_price_minor < p.price_minor
          ? p.price_minor
          : null,
      );
      expect(typeof p.buyable).toBe("boolean");
      // 只有 blocked 才是真不可买
      expect(p.buyable).toBe(p.action !== "blocked");
    }
    // 游客只是"还差登录"，不能因此把按钮置灰（那会掐掉主转化路径）
    expect(plans.every((p) => p.buyable)).toBe(true);
  });
});
