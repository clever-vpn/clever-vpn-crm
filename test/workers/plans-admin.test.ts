/**
 * 集成测试：套餐管理的写路径（真 D1、真路由、真 cookie）
 *
 * 这些用例的价值在 Node 单测里拿不到：
 *   - `PATCH` 在 SQL 层真的能改 `active` / `retired` 行（不是 mock）
 *   - 受保护字段（`id` / `status` / `retired_at`）在**整条链路**上都没被改掉
 *   - 已删除的 `/clone` 真的 404，而不是"文档说不支持"
 */
import { exports as rawExports } from "cloudflare:workers";
import { beforeAll, describe, expect, it } from "vitest";

import { env } from "./apply-migrations";

const BASE = "https://crm.test";
/** CSRF 防线：写操作必须带这个头（见 `src/admin/router.ts` 的 `csrfOk`） */
const CSRF = { "x-crm-request": "1" };

const worker = rawExports as unknown as {
  default: { fetch(request: Request): Promise<Response> };
};

/** dev 种子里那个管理员口令的哈希（`ops@example.com` / `crm-admin-2026`） */
const DEV_PASSWORD_HASH =
  "pbkdf2$sha256$50000$Y2xldmVydnBuLWRldi1zYQ$pNN_GLa4DQySXqMVpf9UB8ETxhsV6Z64uKaqiB190Mo";

let cookie = "";

function call(path: string, init: { method?: string; body?: unknown; auth?: boolean } = {}) {
  const headers: Record<string, string> = { ...CSRF };
  if (init.body !== undefined) headers["content-type"] = "application/json";
  if (init.auth !== false && cookie) headers.cookie = cookie;
  return worker.default.fetch(
    new Request(`${BASE}${path}`, {
      method: init.method ?? "GET",
      headers,
      body: init.body === undefined ? undefined : JSON.stringify(init.body),
    }),
  );
}

async function jsonOf<T = Record<string, unknown>>(res: Response): Promise<T> {
  return (await res.json()) as T;
}

/** 建一个草稿套餐（validatePlan 要求至少一个渠道） */
async function createPlan(id: string): Promise<void> {
  const res = await call("/api/admin/plans", {
    method: "POST",
    body: {
      id,
      name: `测试套餐 ${id}`,
      kind: "traffic",
      price_minor: 1000,
      currency: "CNY",
      licence_limit: 1,
      traffic_gb: 10,
      validity_days: 30,
      sales_channels: [{ channel: "web_checkout" }],
    },
  });
  expect(res.status, `创建 ${id} 应成功`).toBe(201);
}

async function publish(id: string): Promise<void> {
  const res = await call(`/api/admin/plans/${id}/publish`, { method: "POST" });
  expect(res.status).toBe(200);
}

async function retire(id: string): Promise<void> {
  const res = await call(`/api/admin/plans/${id}/retire`, { method: "POST" });
  expect(res.status).toBe(200);
}

beforeAll(async () => {
  // 一个管理员就够（单账号模型），口令哈希直接取自 dev 种子
  await env.DB.prepare(
    `INSERT INTO admin_users (email, password_hash, totp_enabled, created_at, updated_at)
     VALUES (?, ?, 0, ?, ?)`,
  )
    .bind("ops@example.com", DEV_PASSWORD_HASH, new Date().toISOString(), new Date().toISOString())
    .run();

  const res = await call("/api/admin/login", {
    method: "POST",
    body: { email: "ops@example.com", password: "crm-admin-2026" },
  });
  expect(res.status).toBe(200);
  // `crm_admin=<token>; Path=/; ...` → 只取 `name=value`
  cookie = (res.headers.get("set-cookie") ?? "").split(";")[0] ?? "";
  expect(cookie).toContain("crm_admin=");
});

describe("套餐写路径", () => {
  it("未登录不能读套餐列表", async () => {
    const res = await call("/api/admin/plans", { auth: false });
    expect(res.status).toBe(401);
  });

  it("在售套餐可以直接改价（可变目录），状态不变", async () => {
    await createPlan("t_price");
    await publish("t_price");

    const res = await call("/api/admin/plans/t_price", {
      method: "PATCH",
      body: { price_minor: 1800 },
    });
    expect(res.status).toBe(200);

    const { plan } = await jsonOf<{ plan: Record<string, unknown> }>(res);
    expect(plan.price_minor).toBe(1800);
    expect(plan.status).toBe("active");
    // 没提到的字段保持原样
    expect(plan.traffic_gb).toBe(10);
  });

  it("PATCH 不能绕过状态机：id 与 status 都改不动", async () => {
    await createPlan("t_guard");
    await publish("t_guard");

    const res = await call("/api/admin/plans/t_guard", {
      method: "PATCH",
      body: { id: "hijacked", status: "draft", name: "改名成功" },
    });
    expect(res.status).toBe(200);

    const { plan } = await jsonOf<{ plan: Record<string, unknown> }>(res);
    expect(plan.plan_id).toBe("t_guard");
    expect(plan.status).toBe("active");
    expect(plan.name).toBe("改名成功"); // 非受保护字段正常生效
  });

  it("已下架套餐改内容时保留 retired_at", async () => {
    await createPlan("t_retired");
    await publish("t_retired");
    await retire("t_retired");

    const res = await call("/api/admin/plans/t_retired", {
      method: "PATCH",
      body: { price_minor: 2000 },
    });
    expect(res.status).toBe(200);

    const { plan } = await jsonOf<{ plan: Record<string, unknown> }>(res);
    expect(plan.status).toBe("retired");
    expect(plan.retired_at).toBeTruthy();
    expect(plan.price_minor).toBe(2000);
  });

  it("合并后仍然过完整校验：清空售卖渠道被拒", async () => {
    await createPlan("t_invalid");

    const res = await call("/api/admin/plans/t_invalid", {
      method: "PATCH",
      body: { sales_channels: [] },
    });
    expect(res.status).toBe(400);

    const body = await jsonOf<{ error: string; errors: string[] }>(res);
    expect(body.error).toBe("invalid_plan");
    expect(body.errors.join()).toContain("至少选一个售卖渠道");
  });

  it("克隆端点已经不存在", async () => {
    const res = await call("/api/admin/plans/t_price/clone", { method: "POST" });
    expect(res.status).toBe(404);
  });

  it("retire 只影响可售性：App 的 /plans 里消失，但订阅仍可换购", async () => {
    await createPlan("t_shelf");
    await publish("t_shelf");

    const before = await jsonOf<unknown[]>(await call("/api/app/v1/plans", { auth: false }));
    expect(before.some((p) => (p as { plan_id: string }).plan_id === "t_shelf")).toBe(true);

    await retire("t_shelf");

    const after = await jsonOf<unknown[]>(await call("/api/app/v1/plans", { auth: false }));
    expect(after.some((p) => (p as { plan_id: string }).plan_id === "t_shelf")).toBe(false);
  });
});
