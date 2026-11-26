/**
 * 契约测试：**文档表格里的字段，就是这里断言的字段**。
 *
 * 上一轮的三次漂移（`o.code`、`kind:"subscription"`、`action:"purchase"`）都是
 * "文档一套、代码一套、测试再一套"。这里用**顶层键精确集合**钉住：
 * 新增字段必须先改 `clever-vpn-docs` 的 `clients.md` / `clients/fields.md`，再改这里。
 *
 * 只覆盖终端 API；控制面（`/api/site/*`）在 `site-*` 测试里。
 */
import { exports as rawExports } from "cloudflare:workers";
import { beforeAll, describe, expect, it } from "vitest";

import { sha256Hex } from "../../src/admin/crypto";
import { env } from "./apply-migrations";

const BASE = "https://crm.test";
const TOKEN = "session-contract";
const EMAIL = "contract@test.com";
const PLAN = "contract_30d";

const worker = rawExports as unknown as {
  default: { fetch(request: Request): Promise<Response> };
};

const now = () => new Date().toISOString();
const sorted = (o: object) => Object.keys(o).sort();

function call(path: string, init: { method?: string; token?: string; body?: unknown } = {}) {
  const headers: Record<string, string> = {};
  if (init.token) headers.authorization = `Bearer ${init.token}`;
  if (init.body !== undefined) headers["content-type"] = "application/json";
  return worker.default.fetch(
    new Request(`${BASE}${path}`, {
      method: init.method ?? "GET",
      headers,
      body: init.body === undefined ? undefined : JSON.stringify(init.body),
    }),
  );
}

beforeAll(async () => {
  await env.DB.prepare(
    `INSERT INTO plans (id, name, kind, price_minor, currency, licence_limit, term_days,
       monthly_quota_gb, traffic_gb, validity_days, line_ids, sales_channels,
       store_product_id, sort_order, status, visibility, created_at, updated_at)
     VALUES (?, '合同测试套餐', 'period', 1500, 'CNY', 1, 30, 100, NULL, NULL,
       '[]', ?, '{}', 1, 'active', 'public', ?, ?)`,
  )
    .bind(PLAN, JSON.stringify([{ channel: "web_checkout", methods: ["alipay"] }]), now(), now())
    .run();

  await env.DB.prepare(
    `INSERT INTO payment_gateways (driver, name, endpoint, merchant_id, secret_enc, methods,
       mapping, priority, status, currency, allowed_emails, created_at, updated_at)
     VALUES ('mock', '合同测试网关', NULL, 'M-CONTRACT', NULL, '["alipay"]', NULL, 100, 'live',
       'CNY', ?, ?, ?)`,
  )
    .bind(JSON.stringify([EMAIL]), now(), now())
    .run();

  const res = await env.DB.prepare(
    `INSERT INTO customers (uuid, email, status, created_at)
     VALUES (lower(hex(randomblob(16))), ?, 'active', ?)`,
  )
    .bind(EMAIL, now())
    .run();
  await env.DB.prepare(
    `INSERT INTO app_sessions (id, customer_id, created_at, last_used_at) VALUES (?, ?, ?, ?)`,
  )
    .bind(await sha256Hex(TOKEN), Number(res.meta.last_row_id ?? 0), now(), now())
    .run();
});

describe("契约：顶层键 = 文档字段", () => {
  it("/meta 恰好 5 个键，crm_id 是 UUID", async () => {
    const body = (await (await call("/api/app/v1/meta")).json()) as Record<string, unknown>;
    expect(sorted(body)).toEqual([
      "crm_id",
      "crm_version",
      "currency",
      "trial_text",
      "turnstile_site_key",
    ]);
    expect(String(body.crm_id)).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
    );
    expect(body).not.toHaveProperty("app_contract");
    expect(body).not.toHaveProperty("features");
    expect(body).not.toHaveProperty("min_app");
  });

  it("/me 只有 user + referral（不含订阅）", async () => {
    const body = (await (await call("/api/app/v1/me", { token: TOKEN })).json()) as object;
    expect(sorted(body)).toEqual(["referral", "user"]);
    expect(body).not.toHaveProperty("subscription");
  });

  it("/subscription 字段不含 platform / addon_gb / line_ids", async () => {
    const body = (await (await call("/api/app/v1/subscription", { token: TOKEN })).json()) as object;
    expect(sorted(body)).toEqual([
      "code",
      "expires_at",
      "kind",
      "licence_limit",
      "next_reset_at",
      "plan_id",
      "reason",
      "remaining_gb",
      "status",
      "status_text",
      "tag",
      "tag_tone",
      "unlimited",
    ]);
  });

  it("/plans 卡片是服务端拼好的视图模型", async () => {
    const list = (await (await call("/api/app/v1/plans")).json()) as Record<string, unknown>[];
    const plan = list.find((p) => p.plan_id === PLAN)!;
    expect(sorted(plan)).toEqual([
      "action",
      "buyable",
      "compare_at_price_minor",
      "cta",
      "currency",
      "display_price_minor",
      "kind",
      "kind_label",
      "licence_limit",
      "monthly_quota_gb",
      "name",
      "next_expires_at",
      "payment_methods",
      "plan_id",
      "price_minor",
      "price_note",
      "promo_badge",
      "reason",
      "specs",
      "store_product_id",
      "term_days",
      "traffic_gb",
      "validity_days",
    ]);
    // 展示内容由 CRM 给：客户端不拼按钮/类型/规格
    expect(plan.cta).toBe("登录后订阅");
    expect(plan.price_note).toBe("登录后查看实付价");
    expect(plan.kind_label).toBe("按时长");
    expect(plan.specs).toEqual(["每月 100 GB", "30 天有效期", "1 台设备"]);
    expect(plan).not.toHaveProperty("promo_price_minor");
    expect(plan).not.toHaveProperty("line_ids");
    expect(plan).not.toHaveProperty("speed");
  });

  it("/plans 登录后：payment_methods 是 {id,label}", async () => {
    const list = (await (
      await call("/api/app/v1/plans", { token: TOKEN })
    ).json()) as { plan_id: string; payment_methods: object[] | null }[];
    const plan = list.find((p) => p.plan_id === PLAN)!;
    expect(plan.payment_methods).toEqual([{ id: "alipay", label: "支付宝" }]);
  });

  it("/quote、/orders、订单详情：字段与文档一致", async () => {
    const quote = (await (
      await call("/api/app/v1/quote", { method: "POST", token: TOKEN, body: { plan_id: PLAN } })
    ).json()) as object;
    expect(sorted(quote)).toEqual([
      "action",
      "discount_label",
      "discount_minor",
      "paid_minor",
      "payable_minor",
      "promo_code",
      "reason",
      "residual_minor",
    ]);

    const created = await call("/api/app/v1/orders", {
      method: "POST",
      token: TOKEN,
      body: { plan_id: PLAN, payment_method: "alipay" },
    });
    expect(created.status).toBe(201);
    const order = (await created.json()) as { order_code: string };
    expect(sorted(order)).toEqual([
      "amount_minor",
      "currency",
      "expires_at",
      "order_code",
      "pay_url",
    ]);

    const list = (await (await call("/api/app/v1/orders", { token: TOKEN })).json()) as {
      items: object[];
      next_cursor: string | null;
    };
    expect(sorted(list)).toEqual(["items", "next_cursor"]);
    expect(sorted(list.items[0]!)).toEqual([
      "amount_text",
      "created_at",
      "next_poll_after_ms",
      "order_code",
      "paid_at",
      "status",
      "status_text",
      "tag",
      "tag_tone",
      "title",
    ]);

    const detail = (await (
      await call(`/api/app/v1/orders/${order.order_code}`, { token: TOKEN })
    ).json()) as object;
    expect(sorted(detail)).toEqual([
      "amount_minor",
      "created_at",
      "currency",
      "discount_minor",
      "expires_at",
      "order_code",
      "paid_at",
      "pay_url",
      "status",
    ]);
    expect(detail).not.toHaveProperty("subscription");
  });

  it("/me/gifts 与 /redeem 同形", async () => {
    const gifts = (await (await call("/api/app/v1/me/gifts", { token: TOKEN })).json()) as object;
    expect(sorted(gifts)).toEqual(["available_count", "empty_text", "items"]);

    const redeem = (await (
      await call("/api/app/v1/redeem", { method: "POST", token: TOKEN, body: { code: "NOPE00" } })
    ).json()) as object;
    expect(sorted(redeem)).toEqual([
      "applied",
      "expires_at",
      "ok",
      "remaining_gb",
      "result_text",
      "state",
      "title",
    ]);
    expect(redeem).not.toHaveProperty("reason");
    expect(redeem).not.toHaveProperty("promotion_name");
  });

  it("/me/timeline 用 limit + 不透明 cursor", async () => {
    const body = (await (await call("/api/app/v1/me/timeline?limit=1", { token: TOKEN })).json()) as object;
    expect(sorted(body)).toEqual(["items", "next_cursor"]);
  });
});
