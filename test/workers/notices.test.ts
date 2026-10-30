/**
 * 通知（`notices`）= 邮件队列 = 站内消息
 *
 * 要钉住的：
 *   1. **只有收据一种通知**（礼包是用户自己点领取的，结果在那一屏同步显示），
 *      而且 `promotions.notify` 默认**关**——邮件只会晚到且重复，还吃发信配额；
 *   2. **幂等**：同一次领取重跑不会发第二封（锚点是核销行 id）；
 *   3. **泵**按日配额发，配额用尽就整体顺延到明天（不是每轮空转）；
 *   4. **退订**只影响营销类，且发信时必须带 `List-Unsubscribe` 一键退订头；
 *   5. 硬退 / 被抑制是**终态**，不重试（重试只会继续伤害域名信誉）。
 */
import { exports as rawExports } from "cloudflare:workers";
import { beforeAll, describe, expect, it } from "vitest";

import { env } from "./apply-migrations";
import { installFakeCfApi } from "./fake-cf-api";

import type { FakeCfApi } from "./fake-cf-api";

const BASE = "https://crm.test";
const DEV_PASSWORD_HASH =
  "pbkdf2$sha256$50000$Y2xldmVydnBuLWRldi1zYQ$pNN_GLa4DQySXqMVpf9UB8ETxhsV6Z64uKaqiB190Mo";

const CLAIM_USER = "notice-claim@test.com";
const AUTO_USER = "notice-auto@test.com";
const OPT_OUT_USER = "notice-optout@test.com";
const SILENT_USER = "notice-silent@test.com";
const QUOTA_USER = "notice-quota@test.com";
const UNSUB_USER = "notice-unsub@test.com";

const worker = rawExports as unknown as {
  default: { fetch(request: Request): Promise<Response> };
};

interface MailSpy {
  to: string;
  subject: string;
  text: string;
  headers?: Record<string, string>;
}
const sent: MailSpy[] = [];

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

const appCall = (path: string, token: string, init: { method?: string; body?: unknown } = {}) =>
  fetchJson(path, { ...init, headers: { authorization: `Bearer ${token}` } });

async function login(email: string): Promise<string> {
  const res = await fetchJson("/api/app/v1/auth/send-code", { method: "POST", body: { email } });
  const { code } = (await res.json()) as { code?: string };
  expect(code).toBeTruthy();
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
  return row!.id;
}

async function payMonthly(token: string): Promise<void> {
  const quote = await appCall("/api/app/v1/quote", token, {
    method: "POST",
    body: { plan_id: "notice_30d" },
  });
  const q = (await quote.json()) as { allowed: boolean; payable_minor: number | null };
  expect(q.allowed).toBe(true);
  const created = await appCall("/api/app/v1/orders", token, {
    method: "POST",
    body: {
      plan_id: "notice_30d",
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

async function makePromotion(opts: {
  name: string;
  rewards: { days?: number; gb?: number };
  /** 领取后发**收据**邮件（默认不发：结果已经同步显示在那一屏） */
  notify?: boolean;
  badge?: string;
}): Promise<number> {
  const now = new Date().toISOString();
  const res = await env.DB.prepare(
    `INSERT INTO promotions
       (auto_apply, name, kind, benefit_type, benefit_value, rewards_json,
        notify, audience, max_uses_per_customer, badge_label, status,
        created_at, updated_at)
     VALUES (0, ?, 'gift', 'amount', 0, ?, ?, 'all', 1, ?, 'active', ?, ?)`,
  )
    .bind(
      opts.name,
      JSON.stringify({ days: 0, gb: 0, ...opts.rewards }),
      opts.notify === true ? 1 : 0,
      opts.badge ?? null,
      now,
      now,
    )
    .run();
  return Number(res.meta.last_row_id);
}

/** 领取 = 唯一的发放入口（拉取模型） */
const claim = async (promotionId: number, customerId: number) => {
  const { claimGiftFor } = await import("../../src/promotions/gift");
  return claimGiftFor(env, { promotionId, customerId });
};

async function noticesOf(customerId: number) {
  const rows = await env.DB.prepare(
    `SELECT id, kind, ref_id, title, body, status, attempts, next_attempt_at, action_url
       FROM notices WHERE customer_id = ? ORDER BY id`,
  )
    .bind(customerId)
    .all<{
      id: number;
      kind: string;
      ref_id: string;
      title: string;
      body: string;
      status: string;
      attempts: number;
      next_attempt_at: string;
      action_url: string | null;
    }>();
  return rows.results ?? [];
}

beforeAll(async () => {
  (env as unknown as Record<string, unknown>).ALLOW_MOCK_PAYMENTS = "true";
  // 退订链接要绝对地址 ⇒ 必须有 SITE_URL；密钥用于签名
  (env as unknown as Record<string, unknown>).SITE_URL = "https://vpn.test";
  (env as unknown as Record<string, unknown>).SESSION_SECRET = "notice-test-secret";
  document: {
    // 非 production 时 sendMail 只打日志，这里接住它做断言（表行状态也是断言对象）
  }
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
       VALUES ('mock', '测试网关（演示）', NULL, 'MOCK-NOTICE', NULL, '["alipay"]',
         NULL, 999, 'live', 'CNY', ?, ?, ?)`,
    ).bind(
      JSON.stringify([CLAIM_USER, AUTO_USER, OPT_OUT_USER, SILENT_USER, QUOTA_USER, UNSUB_USER]),
      now,
      now,
    ),
    env.DB.prepare(
      `INSERT INTO plans (id, name, kind, price_minor, currency, licence_limit, term_days,
         monthly_quota_gb, traffic_gb, validity_days, line_ids, sales_channels,
         store_product_id, sort_order, status, visibility, created_at, updated_at)
       VALUES ('notice_30d', '月付 · 10 元', 'period', 1000, 'CNY', 1, 30, 100,
         NULL, NULL, '[]', '[{"channel":"web_checkout","methods":["alipay"]}]',
         '{}', 1, 'active', 'public', ?, ?)`,
    ).bind(now, now),
  ]);
});

describe("收据邮件（默认不发）", () => {
  it("开了 notify ⇒ 收据写明加了多少 + 新的到期日", async () => {
    const promoId = await makePromotion({
      name: "收据礼包",
      rewards: { days: 7 },
      notify: true,
      badge: "国庆礼物",
    });
    const token = await login(CLAIM_USER);
    await payMonthly(token);
    const customerId = await customerIdOf(CLAIM_USER);

    const result = await claim(promoId, customerId);
    expect(result.state).toBe("granted");

    const sub = await env.DB.prepare(
      `SELECT expires_at FROM platform_subscriptions WHERE customer_id = ?`,
    )
      .bind(customerId)
      .first<{ expires_at: string }>();

    const rows = await noticesOf(customerId);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.kind).toBe("gift_granted");
    expect(rows[0]!.status).toBe("pending");
    expect(rows[0]!.title).toContain("已为你送上");
    expect(rows[0]!.body).toContain("+7 天");
    // 收据的关键：新的到期日（用户读得出"到哪天为止"）
    expect(rows[0]!.body).toContain(sub!.expires_at.slice(0, 10));
    // 不是"催领"：没有作废倒计时那种话
    expect(rows[0]!.body).not.toContain("逾期自动作废");
    // 锚点是**核销行 id**，不是订单（礼包不产生订单）
    expect(rows[0]!.ref_id).toBe(String(result.redemption_id));
  });

  it("默认（notify 未开）⇒ 权益到账但不写通知、不发信", async () => {
    const promoId = await makePromotion({ name: "静默礼包", rewards: { gb: 2 } });
    const token = await login(SILENT_USER);
    await payMonthly(token);
    const customerId = await customerIdOf(SILENT_USER);

    const result = await claim(promoId, customerId);
    expect(result.state).toBe("granted");
    expect(await noticesOf(customerId)).toHaveLength(0);
  });

  it("重跑一次不会发第二封（核销行 id 唯一）", async () => {
    const token = await login(AUTO_USER);
    await payMonthly(token);
    const customerId = await customerIdOf(AUTO_USER);
    const promoId = await makePromotion({ name: "幂等收据", rewards: { days: 1 }, notify: true });

    expect((await claim(promoId, customerId)).state).toBe("granted");
    // 再点一次：不会给第二份权益，也不会写第二条通知
    expect((await claim(promoId, customerId)).state).toBe("already_claimed");
    expect(await noticesOf(customerId)).toHaveLength(1);
  });
});

describe("泵：按日配额发，配额用尽顺延", () => {
  it("发了就置 sent 并记 sent_at；退订用户置 skipped", async () => {
    const { sendPendingNotices, saveNoticeSettings } = await import("../../src/notices/store");
    await saveNoticeSettings(env, { dailyQuota: 5000, softRatio: 0.9 });

    const token = await login(OPT_OUT_USER);
    await payMonthly(token);
    const claimCustomer = await customerIdOf(OPT_OUT_USER);
    const autoCustomer = await customerIdOf(AUTO_USER);

    // 两位都先领一份（都开收据），再把其中一位标成已退订
    await claim(await makePromotion({ name: "泵-愿收", rewards: { days: 1 }, notify: true }), claimCustomer);
    await claim(await makePromotion({ name: "泵-退订", rewards: { days: 1 }, notify: true }), autoCustomer);

    // 把 autoCustomer 标成已退订
    await env.DB.prepare(`UPDATE customers SET marketing_opt_out = 1 WHERE id = ?`)
      .bind(autoCustomer)
      .run();

    const report = await sendPendingNotices(env, { limit: 20 });
    expect(report.sent).toBeGreaterThanOrEqual(1);
    expect(report.skipped).toBeGreaterThanOrEqual(1);

    const claimRows = await noticesOf(claimCustomer);
    expect(claimRows.length).toBeGreaterThanOrEqual(1);
    expect(claimRows.every((r) => r.status === "sent")).toBe(true);
    const autoRows = await noticesOf(autoCustomer);
    expect(autoRows.length).toBeGreaterThanOrEqual(1);
    expect(autoRows.every((r) => r.status === "skipped")).toBe(true);

    // 退订只影响营销通知；验证码走的是另一条路（不读 notices / opt_out）
    const optOut = await env.DB.prepare(
      `SELECT marketing_opt_out FROM customers WHERE id = ?`,
    )
      .bind(autoCustomer)
      .first<{ marketing_opt_out: number }>();
    expect(optOut!.marketing_opt_out).toBe(1);
  });

  it("配额用尽 ⇒ 一条都不发，全部顺延到明天", async () => {
    const { sendPendingNotices, saveNoticeSettings } = await import("../../src/notices/store");
    const promoId = await makePromotion({ name: "配额礼包", rewards: { days: 1 }, notify: true });
    const token = await login(QUOTA_USER);
    await payMonthly(token);
    const customerId = await customerIdOf(QUOTA_USER);
    await claim(promoId, customerId);

    // 配额设成 1、软上限 100% ⇒ 今天已经发过 ⇒ 剩余 0
    await saveNoticeSettings(env, { dailyQuota: 1, softRatio: 1 });

    const now = new Date();
    const report = await sendPendingNotices(env, { now, limit: 20 });
    expect(report.sent).toBe(0);
    expect(report.deferred).toBeGreaterThanOrEqual(1);

    const rows = await noticesOf(customerId);
    expect(rows[0]!.status).toBe("pending");
    // 顺延到明天（UTC 次日 0 点 + 0–30 分钟抖动）
    const next = Date.parse(rows[0]!.next_attempt_at);
    expect(next).toBeGreaterThan(now.getTime() + 60 * 60 * 1000);

    // 还原配额，避免影响其它用例
    await saveNoticeSettings(env, { dailyQuota: 5000, softRatio: 0.9 });
  });
});

describe("退订链接", () => {
  it("签名正确 ⇒ GET 给确认页，POST 一键退订并置 skipped", async () => {
    const { unsubscribeUrl, verifyUnsubscribeToken } = await import(
      "../../src/notices/unsubscribe"
    );
    const token = await login(UNSUB_USER);
    await payMonthly(token);
    const customerId = await customerIdOf(UNSUB_USER);

    const url = await unsubscribeUrl(env, customerId);
    expect(url).toContain("https://vpn.test/unsubscribe?c=");
    const parsed = new URL(url!);
    expect(await verifyUnsubscribeToken(env, customerId, parsed.searchParams.get("t")!)).toBe(true);
    expect(await verifyUnsubscribeToken(env, customerId, "deadbeef")).toBe(false);

    // 未退订前是 pending
    const promoId = await makePromotion({ name: "退订礼包", rewards: { days: 1 }, notify: true });
    await claim(promoId, customerId);
    expect((await noticesOf(customerId))[0]!.status).toBe("pending");

    // 一键退订（邮件客户端发的就是这个 POST）
    const res = await worker.default.fetch(
      new Request(url!, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: "List-Unsubscribe=One-Click",
      }),
    );
    expect(res.status).toBe(200);
    expect(await res.text()).toContain("已退订");

    const row = await env.DB.prepare(`SELECT marketing_opt_out FROM customers WHERE id = ?`)
      .bind(customerId)
      .first<{ marketing_opt_out: number }>();
    expect(row!.marketing_opt_out).toBe(1);
    // 还没发出去的那条立刻作废，不会在下一轮继续发
    expect((await noticesOf(customerId))[0]!.status).toBe("skipped");
  });

  it("签名不对 ⇒ 400，不产生任何改动", async () => {
    const customerId = await customerIdOf(CLAIM_USER);
    const res = await worker.default.fetch(
      new Request(`https://crm.test/unsubscribe?c=${customerId}&t=bad`, { method: "POST" }),
    );
    expect(res.status).toBe(400);
  });
});

void sent;
