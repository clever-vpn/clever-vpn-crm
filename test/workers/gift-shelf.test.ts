/**
 * 礼包**货架**（`GET /me/gifts`）—— 拉取模型的核心
 *
 * 要钉住的：
 *   1. 有资格 + 还有名额 ⇒ `available`，并且**露 `remaining`**；
 *   2. 有资格但**名额没了** ⇒ `sold_out`，文案是"来晚了一步"（用户该被告知，
 *      而不是看到一片空白以为自己没资格）；
 *   3. 不符合资格（人群 / 时间窗）⇒ **默认不出现**；带 `?promotion_id=` 深链时
 *      一定出现并解释原因（用户是拿着链接来的）；
 *   4. 领过 ⇒ `claimed`，不再可领；
 *   5. 并发抢**最后一份** ⇒ 恰好一个人拿到，另一个明确 `sold_out`，绝不超发。
 */
import { exports as rawExports } from "cloudflare:workers";
import { beforeAll, describe, expect, it } from "vitest";

import { env } from "./apply-migrations";
import { installFakeCfApi } from "./fake-cf-api";

import type { FakeCfApi } from "./fake-cf-api";

const BASE = "https://crm.test";
const DEV_PASSWORD_HASH =
  "pbkdf2$sha256$50000$Y2xldmVydnBuLWRldi1zYQ$pNN_GLa4DQySXqMVpf9UB8ETxhsV6Z64uKaqiB190Mo";

const SHELF = "shelf-user@test.com";
const LATE = "shelf-late@test.com";
const RACER_A = "shelf-race-a@test.com";
const RACER_B = "shelf-race-b@test.com";
const NOBODY = "shelf-nobody@test.com";

const worker = rawExports as unknown as {
  default: { fetch(request: Request): Promise<Response> };
};

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
  const sent = await fetchJson("/api/app/v1/auth/send-code", { method: "POST", body: { email } });
  const { code } = (await sent.json()) as { code?: string };
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

/** 买一张月付，把订阅造出来（礼包要有地方放） */
async function payMonthly(token: string): Promise<void> {
  const quote = await appCall("/api/app/v1/quote", token, {
    method: "POST",
    body: { plan_id: "shelf_30d" },
  });
  const q = (await quote.json()) as { allowed: boolean; payable_minor: number | null };
  const created = await appCall("/api/app/v1/orders", token, {
    method: "POST",
    body: {
      plan_id: "shelf_30d",
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
  maxUses?: number | null;
  audience?: string;
  endsAt?: string | null;
  visible?: boolean;
}): Promise<number> {
  const now = new Date().toISOString();
  const res = await env.DB.prepare(
    `INSERT INTO promotions
       (auto_apply, name, kind, benefit_type, benefit_value, rewards_json, notify,
        audience, max_uses, max_uses_per_customer, badge_label, visible, ends_at,
        status, created_at, updated_at)
     VALUES (0, ?, 'gift', 'amount', 0, ?, 0, ?, ?, 1, '限时礼物', ?, ?, 'active', ?, ?)`,
  )
    .bind(
      opts.name,
      JSON.stringify({ days: 0, gb: 0, ...opts.rewards }),
      opts.audience ?? "all",
      opts.maxUses ?? null,
      opts.visible === false ? 0 : 1,
      opts.endsAt ?? null,
      now,
      now,
    )
    .run();
  return Number(res.meta.last_row_id);
}

interface ShelfItem {
  promotion_id: number;
  title: string;
  state: string;
  status_text: string;
  remaining: number | null;
  claimable: boolean;
  claim_action: string;
  rewards_text: string;
  badge: string | null;
}

async function shelf(token: string, query = ""): Promise<ShelfItem[]> {
  const res = await appCall(`/api/app/v1/me/gifts${query}`, token);
  expect(res.status).toBe(200);
  const body = (await res.json()) as { items: ShelfItem[]; empty_text: string | null };
  return body.items;
}

const claim = async (promotionId: number, token: string) =>
  appCall(`/api/app/v1/me/gifts/${promotionId}/claim`, token, { method: "POST" });

let shelfToken = "";
let lateToken = "";
let racerAToken = "";
let racerBToken = "";
let nobodyToken = "";

beforeAll(async () => {
  (env as unknown as Record<string, unknown>).ALLOW_MOCK_PAYMENTS = "true";
  (env as unknown as Record<string, unknown>).PAYMENT_SECRET_KEY = "master-key-for-tests";
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
       VALUES ('mock', '测试网关（演示）', NULL, 'MOCK-SHELF', NULL, '["alipay"]',
         NULL, 999, 'live', 'CNY', ?, ?, ?)`,
    ).bind(JSON.stringify([SHELF, LATE, RACER_A, RACER_B, NOBODY]), now, now),
    env.DB.prepare(
      `INSERT INTO plans (id, name, kind, price_minor, currency, licence_limit, term_days,
         monthly_quota_gb, traffic_gb, validity_days, line_ids, sales_channels,
         store_product_id, sort_order, status, visibility, created_at, updated_at)
       VALUES ('shelf_30d', '月付 · 10 元', 'period', 1000, 'CNY', 1, 30, 100,
         NULL, NULL, '[]', '[{"channel":"web_checkout","methods":["alipay"]}]',
         '{}', 1, 'active', 'public', ?, ?)`,
    ).bind(now, now),
  ]);

  shelfToken = await login(SHELF);
  await payMonthly(shelfToken);
  lateToken = await login(LATE);
  await payMonthly(lateToken);
  racerAToken = await login(RACER_A);
  await payMonthly(racerAToken);
  racerBToken = await login(RACER_B);
  await payMonthly(racerBToken);
  nobodyToken = await login(NOBODY);
});

describe("货架状态", () => {
  it("有资格 + 有名额 ⇒ available，露 remaining 与领取路径", async () => {
    const id = await makePromotion({ name: "新客礼包", rewards: { days: 7 }, maxUses: 3 });
    const items = await shelf(shelfToken);
    const row = items.find((i) => i.promotion_id === id);
    expect(row).toBeTruthy();
    expect(row!.state).toBe("available");
    expect(row!.claimable).toBe(true);
    expect(row!.remaining).toBe(3);
    expect(row!.rewards_text).toContain("延长 7 天");
    // 领取路径由服务端给，前端不自己拼
    expect(row!.claim_action).toBe(`/me/gifts/${id}/claim`);
  });

  it("领过 ⇒ claimed，且不再可领", async () => {
    const id = await makePromotion({ name: "领一次", rewards: { days: 3 }, visible: false });
    const res = await claim(id, shelfToken);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; state: string; result_text: string };
    expect(body.ok).toBe(true);
    expect(body.state).toBe("granted");
    expect(body.result_text).toContain("已到账");

    // 再点一次：明说"已经领过了"，而不是含糊失败
    const again = (await (await claim(id, shelfToken)).json()) as { ok: boolean; state: string };
    expect(again.ok).toBe(false);
    expect(again.state).toBe("already_claimed");

    // 深链那条不会因为 visible=0 消失，并且状态是 claimed
    const items = await shelf(shelfToken, `?promotion_id=${id}`);
    const mine = items.find((i) => i.promotion_id === id);
    expect(mine).toBeTruthy();
    expect(mine!.state).toBe("claimed");
    expect(mine!.claimable).toBe(false);
  });

  it("名额抢完 ⇒ sold_out，文案是「来晚了一步」", async () => {
    const id = await makePromotion({ name: "只有一份", rewards: { days: 2 }, maxUses: 1 });
    expect((await claim(id, shelfToken)).status).toBe(200);

    const items = await shelf(lateToken);
    const row = items.find((i) => i.promotion_id === id);
    expect(row).toBeTruthy();
    expect(row!.state).toBe("sold_out");
    expect(row!.status_text).toContain("来晚了一步");
    expect(row!.remaining).toBe(0);
    expect(row!.claimable).toBe(false);

    // 直接调接口也一样：抢不到，而且说的是"抢完了"不是"没资格"
    const res = (await (await claim(id, lateToken)).json()) as { ok: boolean; state: string };
    expect(res.ok).toBe(false);
    expect(res.state).toBe("sold_out");
  });

  it("不符合资格 ⇒ 默认不出现；深链时出现并解释原因", async () => {
    const id = await makePromotion({
      name: "只给指定人",
      rewards: { days: 1 },
      audience: "specific",
      visible: false,
    });

    const plain = await shelf(lateToken);
    expect(plain.some((i) => i.promotion_id === id)).toBe(false);

    // 深链：这条被**补**进货架并解释原因（其余正常条目照常出现）
    const linked = await shelf(lateToken, `?promotion_id=${id}`);
    const row = linked.find((i) => i.promotion_id === id);
    expect(row).toBeTruthy();
    expect(row!.state).toBe("ended");
    expect(row!.claimable).toBe(false);
    // 原因来自 `checkPromotion`（不是前端猜的）
    expect(row!.status_text.length).toBeGreaterThan(0);
  });

  it("已结束的活动 ⇒ 深链解释「活动已结束」", async () => {
    const id = await makePromotion({
      name: "过期活动",
      rewards: { days: 1 },
      endsAt: new Date(Date.now() - 60_000).toISOString(),
    });
    const linked = await shelf(lateToken, `?promotion_id=${id}`);
    const row = linked.find((i) => i.promotion_id === id);
    expect(row).toBeTruthy();
    expect(row!.claimable).toBe(false);
    expect(row!.status_text).toContain("结束");
  });

  it("不存在的活动 ⇒ 404（不是空列表）", async () => {
    const res = await claim(999999, shelfToken);
    expect(res.status).toBe(404);
  });

  it("没有订阅也没有载体套餐 ⇒ 不给领，并说清要找客服", async () => {
    const id = await makePromotion({ name: "需要套餐", rewards: { days: 1 } });
    const res = (await (await claim(id, nobodyToken)).json()) as {
      ok: boolean;
      state: string;
      result_text: string;
    };
    expect(res.ok).toBe(false);
    expect(res.state).toBe("not_applicable");
    expect(res.result_text).toContain("套餐");
  });
});

describe("并发抢最后一份", () => {
  it("两个人同时点 ⇒ 恰好一个成功，另一个 sold_out", async () => {
    const id = await makePromotion({ name: "最后一份", rewards: { days: 4 }, maxUses: 1 });

    const [a, b] = await Promise.all([claim(id, racerAToken), claim(id, racerBToken)]);
    const bodyA = (await a.json()) as { ok: boolean; state: string };
    const bodyB = (await b.json()) as { ok: boolean; state: string };

    const winners = [bodyA, bodyB].filter((r) => r.ok);
    expect(winners).toHaveLength(1);
    const loser = [bodyA, bodyB].find((r) => !r.ok)!;
    expect(loser.state).toBe("sold_out");

    // 台账只有一行 —— 名额不会因为并发被超发
    const row = await env.DB.prepare(
      `SELECT COUNT(*) AS n FROM redemptions WHERE promotion_id = ?`,
    )
      .bind(id)
      .first<{ n: number }>();
    expect(Number(row!.n)).toBe(1);
  });
});
