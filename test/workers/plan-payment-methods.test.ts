/**
 * `/plans[].payment_methods` —— 支付按钮是**实例级**商品属性
 *
 * 三条要钉住的：
 *   1. 只有 live + **白名单为空** + 有可路由实现的网关，才会让方式出现在定价页；
 *   2. 交集在服务端算（本档支持 ∩ 实例可用），客户端不参与；
 *   3. 游客与登录用户拿到**同一份**按钮 —— 与"谁在看"无关（契约 §2.4.1 ①）。
 */
import { exports as rawExports } from "cloudflare:workers";
import { beforeAll, describe, expect, it } from "vitest";

import { sha256Hex } from "../../src/admin/crypto";
import { env } from "./apply-migrations";

const BASE = "https://crm.test";
const TOKEN = "session-plan-payment-methods";

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
}): Promise<void> {
  await env.DB.prepare(
    `INSERT INTO payment_gateways (driver, name, endpoint, merchant_id, secret_enc, methods,
       mapping, priority, status, currency, allowed_emails, created_at, updated_at)
     VALUES ('mock', ?, NULL, ?, NULL, ?, NULL, 100, ?, 'CNY', ?, ?, ?)`,
  )
    .bind(
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

  await seedGateway({ name: "公开-支付宝", methods: ["alipay"], allowedEmails: null });
  // 私有/测试网关：只有这几个人能用，**不该**让微信支付出现在定价页
  await seedGateway({
    name: "私有-微信",
    methods: ["wechat"],
    allowedEmails: ["tester@test.com"],
  });
  // draft 不算
  await seedGateway({ name: "草稿-银行卡", methods: ["card"], allowedEmails: null, status: "draft" });

  await seedPlan("web_all", [{ channel: "web_checkout", methods: ["alipay", "wechat", "card"] }]);
  await seedPlan("store_only", [{ channel: "apple_iap" }]);

  const res = await env.DB.prepare(
    `INSERT INTO customers (uuid, email, status, created_at)
     VALUES (lower(hex(randomblob(16))), ?, 'active', ?)`,
  )
    .bind("buyer@test.com", now())
    .run();
  const customerId = Number(res.meta.last_row_id ?? 0);
  await env.DB.prepare(
    `INSERT INTO app_sessions (id, customer_id, created_at, last_used_at) VALUES (?, ?, ?, ?)`,
  )
    .bind(await sha256Hex(TOKEN), customerId, now(), now())
    .run();
});

describe("plans[].payment_methods 只反映实例级可用性", () => {
  it("白名单非空的网关不算「可用」，draft 也不算", async () => {
    const res = await call("/api/app/v1/plans");
    expect(res.status).toBe(200);
    const plans = (await res.json()) as PlanView[];
    const web = plans.find((p) => p.plan_id === "web_all");
    expect(web?.payment_methods).toEqual([
      { id: "alipay", label: "支付宝", icon_url: null },
    ]);
  });

  it("没有网页渠道的档位给 null（这一档不走网页）", async () => {
    const res = await call("/api/app/v1/plans");
    const plans = (await res.json()) as PlanView[];
    expect(plans.find((p) => p.plan_id === "store_only")?.payment_methods).toBeNull();
  });

  it("游客与登录用户拿到同一份按钮", async () => {
    const anon = (await (await call("/api/app/v1/plans")).json()) as PlanView[];
    const authed = (await (await call("/api/app/v1/plans", { token: TOKEN })).json()) as PlanView[];
    const pick = (list: PlanView[]) =>
      list.map((p) => [p.plan_id, p.payment_methods] as const);
    expect(pick(anon)).toEqual(pick(authed));
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
