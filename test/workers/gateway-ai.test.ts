/**
 * 集成测试：`POST /api/admin/gateways/ai-draft`
 *
 * 钉住四件事：
 *   1. 未登录打不进来（会话门禁在 admin router，不在本端点里重写）；
 *   2. 没配模型三项 → `503 ai_unavailable`，不是“悄悄换一个模型”；
 *   3. 合法模型输出 → 200 + v2 草稿；审计只记元数据，不记文档正文；
 *   4. 非法输出 → 422 可解释错误；每秒/每小时限流 → 429。
 */
import { exports as rawExports } from "cloudflare:workers";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import { env } from "./apply-migrations";

const BASE = "https://crm.test";
const DEV_PASSWORD_HASH =
  "pbkdf2$sha256$50000$Y2xldmVydnBuLWRldi1zYQ$pNN_GLa4DQySXqMVpf9UB8ETxhsV6Z64uKaqiB190Mo";

const worker = rawExports as unknown as {
  default: { fetch(request: Request): Promise<Response> };
};

let cookie = "";

function call(path: string, init: { method?: string; body?: unknown } = {}, withCookie = true) {
  const headers: Record<string, string> = { "x-crm-request": "1" };
  if (init.body !== undefined) headers["content-type"] = "application/json";
  if (withCookie && cookie) headers.cookie = cookie;
  return worker.default.fetch(
    new Request(`${BASE}${path}`, {
      method: init.method ?? "GET",
      headers,
      body: init.body === undefined ? undefined : JSON.stringify(init.body),
    }),
  );
}

const DOCUMENT = "厂商支付接口文档：POST /pay 下单，POST /notify 回调，POST /query 查单。".repeat(8);

const VALID_DRAFT = {
  classification: "generic_mapping",
  template: {
    schema_version: 2,
    id: "ai-demo",
    name: "AI 示例",
    source: "ai",
    mapping: {
      create: {
        request: {
          path: "/pay",
          fields: [
            { field: "mch", role: "merchant", value: "{merchant}" },
            { field: "order", role: "order_no", value: "{order_no}" },
            { field: "amount", role: "amount", value: "{amount}", unit: "yuan" },
          ],
          sign: {},
        },
        response: { ok: { path: "code", equals: "0" }, fields: [{ field: "pay", role: "pay_url" }] },
      },
      notify: {
        request: {
          fields: [{ field: "order", role: "order_no" }],
          paid_when: { path: "status", equals: "1" },
          sign: {},
        },
        response: { reply: "OK" },
      },
      query: {
        request: {
          path: "/query",
          fields: [{ field: "order", role: "order_no", value: "{order_no}" }],
          sign: {},
        },
        response: { paid_when: { path: "status", equals: "1" }, fields: [] },
      },
    },
  },
  evidence: [{ section: "2.1 下单", quote: "POST /pay" }],
  uncertainty: [],
};

function modelReply(content: unknown): typeof fetch {
  return (async () =>
    new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify(content) } }] }), {
      status: 200,
    })) as typeof fetch;
}

async function configureAi(): Promise<void> {
  const raw = env as unknown as Record<string, unknown>;
  raw.AI_BASE_URL = "https://model.test/v1";
  raw.AI_MODEL = "demo-model";
  raw.AI_API_KEY = "sk-test";
}

async function disableAi(): Promise<void> {
  const raw = env as unknown as Record<string, unknown>;
  delete raw.AI_BASE_URL;
  delete raw.AI_MODEL;
  delete raw.AI_API_KEY;
}

async function draftRows(): Promise<number> {
  const row = await env.DB.prepare(
    `SELECT COUNT(*) AS n FROM audit_log WHERE action = 'gateway_ai_draft'`,
  ).first<{ n: number }>();
  return Number(row?.n ?? 0);
}

beforeAll(async () => {
  const now = new Date().toISOString();
  await env.DB.prepare(
    `INSERT INTO admin_users (email, password_hash, totp_enabled, created_at, updated_at)
     VALUES (?, ?, 0, ?, ?)`,
  )
    .bind("ops@example.com", DEV_PASSWORD_HASH, now, now)
    .run();
  const login = await call("/api/admin/login", {
    method: "POST",
    body: { email: "ops@example.com", password: "crm-admin-2026" },
  });
  expect(login.status).toBe(200);
  cookie = (login.headers.get("set-cookie") ?? "").split(";")[0] ?? "";
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("AI 配置助手端点", () => {
  it("未登录 → 401（会话门禁先行）", async () => {
    await configureAi();
    const res = await call("/api/admin/gateways/ai-draft", { method: "POST", body: { document: DOCUMENT } }, false);
    expect(res.status).toBe(401);
  });

  it("未配置模型三项 → 503 ai_unavailable；列表 ai_ready 同步为 false", async () => {
    await disableAi();
    const list = (await (await call("/api/admin/gateways")).json()) as { ai_ready: boolean };
    expect(list.ai_ready).toBe(false);

    const res = await call("/api/admin/gateways/ai-draft", { method: "POST", body: { document: DOCUMENT } });
    expect(res.status).toBe(503);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("ai_unavailable");

    await configureAi();
    const ready = (await (await call("/api/admin/gateways")).json()) as { ai_ready: boolean };
    expect(ready.ai_ready).toBe(true);
  });

  it("文档太短 / 太大 → 400（不调模型）", async () => {
    await configureAi();
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);

    const short = await call("/api/admin/gateways/ai-draft", { method: "POST", body: { document: "太短" } });
    expect(short.status).toBe(400);

    const huge = await call("/api/admin/gateways/ai-draft", {
      method: "POST",
      body: { document: "x".repeat(61 * 1024) },
    });
    expect(huge.status).toBe(400);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("合法输出 → 200 + v2 草稿；审计不写文档正文；不自动保存", async () => {
    await configureAi();
    const before = (await env.DB.prepare(`SELECT COUNT(*) AS n FROM payment_gateways`).first<{ n: number }>())?.n ?? 0;
    const fetchImpl = vi.fn(modelReply(VALID_DRAFT));
    vi.stubGlobal("fetch", fetchImpl);

    const res = await call("/api/admin/gateways/ai-draft", { method: "POST", body: { document: DOCUMENT } });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      draft: { classification: string; template: { schema_version: number; source: string; mapping: Record<string, unknown> } };
      model: string;
    };
    expect(body.model).toBe("demo-model");
    expect(body.draft.classification).toBe("generic_mapping");
    expect(body.draft.template.schema_version).toBe(2);
    expect(body.draft.template.source).toBe("ai");
    expect(JSON.stringify(body.draft)).not.toContain("sk-test");
    expect(fetchImpl).toHaveBeenCalledTimes(1);

    const row = await env.DB.prepare(
      `SELECT detail FROM audit_log WHERE action = 'gateway_ai_draft' ORDER BY id DESC LIMIT 1`,
    ).first<{ detail: string }>();
    expect(row?.detail).toContain("generic_mapping");
    expect(row?.detail).not.toContain("POST /pay 下单"); // 不写正文

    const after = (await env.DB.prepare(`SELECT COUNT(*) AS n FROM payment_gateways`).first<{ n: number }>())?.n ?? 0;
    expect(after).toBe(before); // 只生成草稿，绝不自动建网关
  });

  it("模型输出含账户字段 → 422 + 可解释 errors", async () => {
    await configureAi();
    const bad = structuredClone(VALID_DRAFT) as Record<string, unknown> & {
      template: Record<string, unknown>;
    };
    bad.template.secret = "sk-leak";
    vi.stubGlobal("fetch", vi.fn(modelReply(bad)));

    const res = await call("/api/admin/gateways/ai-draft", { method: "POST", body: { document: DOCUMENT } });
    expect(res.status).toBe(422);
    const body = (await res.json()) as { error: string; details: { errors: string[] } };
    expect(body.error).toBe("invalid_draft");
    expect(body.details.errors.join("；")).toContain("secret");
  });

  it("模型 HTTP 失败 → 502，不泄漏上游报文", async () => {
    await configureAi();
    vi.stubGlobal("fetch", (async () => new Response("vendor: bad key", { status: 401 })) as typeof fetch);
    const res = await call("/api/admin/gateways/ai-draft", { method: "POST", body: { document: DOCUMENT } });
    expect(res.status).toBe(502);
    const text = await res.text();
    expect(text).toContain("ai_upstream_error");
    expect(text).not.toContain("bad key");
  });

  it("每小时 20 次上限 → 429（计数在 audit_log，跨 isolate）", async () => {
    await configureAi();
    const used = await draftRows();
    const now = new Date().toISOString();
    for (let i = used; i < 20; i += 1) {
      await env.DB.prepare(
        `INSERT INTO audit_log (at, actor, action, target, detail) VALUES (?, 'seed', 'gateway_ai_draft', NULL, NULL)`,
      )
        .bind(now)
        .run();
    }
    const fetchImpl = vi.fn(modelReply(VALID_DRAFT));
    vi.stubGlobal("fetch", fetchImpl);
    const res = await call("/api/admin/gateways/ai-draft", { method: "POST", body: { document: DOCUMENT } });
    expect(res.status).toBe(429);
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});
