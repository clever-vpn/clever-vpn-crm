/**
 * 集成测试：`POST /api/admin/gateways/ai-fetch-doc`
 *
 * 用假 fetch 模拟 DoH + 入口页 + 子页，验证：
 *   - 未登录 401；localhost 403 且不发起外网请求；
 *   - 无 AI 时关键词选页；有 AI 时用 AI 选页；
 *   - HTMLRewriter 抽正文、合并页面；
 *   - 无正文 422；每小时 10 次限流。
 */
import { exports as rawExports } from "cloudflare:workers";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import { env } from "./apply-migrations";

const BASE = "https://crm.test";
const ENTRY = "https://docs.example.com/docs/api/index.html";
const worker = rawExports as unknown as {
  default: { fetch(request: Request): Promise<Response> };
};

let cookie = "";

function html(body: string): Response {
  return new Response(`<html><head><title>API 文档</title></head><body>${body}</body></html>`, {
    headers: { "content-type": "text/html; charset=utf-8" },
  });
}

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

const ENTRY_HTML = `
  <nav>
    <a href="/docs/api/sign.html">签名规则</a>
    <a href="/docs/api.html?chapter=1">创建订单</a>
    <a href="/docs/api.html?chapter=2">查询订单</a>
    <a href="/docs/api.html?chapter=4">支付通知</a>
    <a href="/docs/api.html?chapter=5">申请退款</a>
    <a href="/login">登录</a>
    <a href="javascript:;">文档说明</a>
  </nav>
  <main><h1>概述</h1><p>支付 API 总览</p></main>
`;

function fakeFetch(options: { empty?: boolean; dnsIp?: string; entryHtml?: string } = {}): { impl: typeof fetch; calls: string[] } {
  const calls: string[] = [];
  const impl = (async (input: RequestInfo | URL) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    calls.push(url);
    if (url.startsWith("https://cloudflare-dns.com/dns-query")) {
      return new Response(JSON.stringify({ Answer: [{ data: options.dnsIp ?? "93.184.216.34" }] }), {
        headers: { "content-type": "application/dns-json" },
      });
    }
    if (url === ENTRY) return html(options.empty ? "" : options.entryHtml ?? ENTRY_HTML);
    if (url === "https://docs.example.com/docs/api/sign.html") return html("<h1>签名规则</h1><p>MD5 排序</p>");
    if (url === "https://docs.example.com/docs/api.html?chapter=1") return html("<h1>创建订单</h1><p>POST /v1/order</p>");
    if (url === "https://docs.example.com/docs/api.html?chapter=2") return html("<h1>查询订单</h1><p>POST /v1/query</p>");
    if (url === "https://docs.example.com/docs/api.html?chapter=4") return html("<h1>支付通知</h1><p>status=1</p>");
    return new Response("not found", { status: 404 });
  }) as typeof fetch;
  return { impl, calls };
}

function disableAi(): void {
  const raw = env as unknown as Record<string, unknown>;
  delete raw.AI;
  raw.CLOUDFLARE_GATEWAY_ID = "studio";
}

function enableAi(content: string): void {
  const raw = env as unknown as Record<string, unknown>;
  raw.AI = {
    gateway: () => ({
      run: async () => new Response(JSON.stringify({ choices: [{ message: { content } }] }), { status: 200 }),
    }),
  };
  raw.CLOUDFLARE_GATEWAY_ID = "studio";
}

beforeAll(async () => {
  // 用 setup 端点生成密码哈希（服务端同一套 WebCrypto），避免测试常量在 workerd 里的兼容差异
  (env as unknown as Record<string, unknown>).SETUP_TOKEN = "test-setup-token";
  const setup = await call("/api/admin/setup", {
    method: "POST",
    body: { token: "test-setup-token", email: "ops@example.com", password: "crm-admin-2026" },
  });
  expect(setup.status).toBe(200);
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

describe("文档网址抓取", () => {
  it("未登录 → 401", async () => {
    disableAi();
    vi.stubGlobal("fetch", fakeFetch().impl);
    const res = await call("/api/admin/gateways/ai-fetch-doc", { method: "POST", body: { url: ENTRY } }, false);
    expect(res.status).toBe(401);
  });

  it("localhost/私网 → 403，且不发起请求", async () => {
    disableAi();
    const fake = fakeFetch();
    vi.stubGlobal("fetch", fake.impl);
    const res = await call("/api/admin/gateways/ai-fetch-doc", {
      method: "POST",
      body: { url: "http://127.0.0.1/docs" },
    });
    expect(res.status).toBe(403);
    expect(fake.calls).toEqual([]);
  });

  it("域名解析到私网 → 403，不抓入口页", async () => {
    disableAi();
    const fake = fakeFetch({ dnsIp: "10.0.0.5" });
    vi.stubGlobal("fetch", fake.impl);
    const res = await call("/api/admin/gateways/ai-fetch-doc", { method: "POST", body: { url: ENTRY } });
    expect(res.status).toBe(403);
    expect(fake.calls.every((u) => u.startsWith("https://cloudflare-dns.com/dns-query"))).toBe(true);
  });

  it("无 AI → 关键词选页，返回页面 + 合并正文", async () => {
    disableAi();
    const fake = fakeFetch();
    vi.stubGlobal("fetch", fake.impl);
    const res = await call("/api/admin/gateways/ai-fetch-doc", { method: "POST", body: { url: ENTRY } });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      ai_used: boolean;
      pages: { url: string; title: string; selected: boolean; reason: string; text: string }[];
      document: string;
      warnings: string[];
    };
    expect(body.ai_used).toBe(false);
    expect(body.pages.length).toBeGreaterThanOrEqual(4);
    expect(body.pages.some((p) => p.url.includes("chapter=1"))).toBe(true);
    expect(body.pages.some((p) => p.url.includes("chapter=2"))).toBe(true);
    expect(body.document).toContain("创建订单");
    expect(body.document).toContain("查询订单");
    expect(body.pages.filter((p) => p.reason === "keyword").length).toBeGreaterThan(0);
  });

  it("单页长文档：80KB 内不截断，且不误报没有下单/通知/查单页面", async () => {
    disableAi();
    const longEntry = `<h1>支付 API</h1><p>下单 创建订单 支付通知 回调 查单</p><p>${"甲".repeat(25_000)}</p>`;
    const fake = fakeFetch({ entryHtml: longEntry });
    vi.stubGlobal("fetch", fake.impl);
    const res = await call("/api/admin/gateways/ai-fetch-doc", { method: "POST", body: { url: ENTRY } });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      pages: { chars: number; text: string }[];
      warnings: string[];
    };
    expect(body.pages[0]!.chars).toBeGreaterThan(20_000);
    expect(body.pages[0]!.text).toContain("甲".repeat(25_000));
    expect(body.warnings.join("\n")).not.toContain("入口页正文超过");
    expect(body.warnings.join("\n")).not.toContain("没有发现明显的下单/通知/查单页面");
  });

  it("有 AI → 按 AI 返回的编号选页", async () => {
    enableAi('{"pages":[1,2]}');
    const fake = fakeFetch();
    vi.stubGlobal("fetch", fake.impl);
    const res = await call("/api/admin/gateways/ai-fetch-doc", { method: "POST", body: { url: ENTRY } });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      ai_used: boolean;
      pages: { reason: string }[];
    };
    expect(body.ai_used).toBe(true);
    expect(body.pages.filter((p) => p.reason === "ai")).toHaveLength(2);
  });

  it("没有正文 → 422", async () => {
    disableAi();
    vi.stubGlobal("fetch", fakeFetch({ empty: true }).impl);
    const res = await call("/api/admin/gateways/ai-fetch-doc", { method: "POST", body: { url: ENTRY } });
    expect(res.status).toBe(422);
  });

  it("每小时 10 次上限 → 429", async () => {
    disableAi();
    const now = new Date().toISOString();
    for (let i = 0; i < 10; i += 1) {
      await env.DB.prepare(
        `INSERT INTO audit_log (at, actor, action, target, detail) VALUES (?, 'seed', 'gateway_ai_fetch', NULL, NULL)`,
      )
        .bind(now)
        .run();
    }
    const fake = fakeFetch();
    vi.stubGlobal("fetch", fake.impl);
    const res = await call("/api/admin/gateways/ai-fetch-doc", { method: "POST", body: { url: ENTRY } });
    expect(res.status).toBe(429);
    expect(fake.calls).toEqual([]);
  });
});
