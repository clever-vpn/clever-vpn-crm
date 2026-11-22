/**
 * 后台自定义域名接口 —— 在 workerd 里跑真 D1 + 假 cf-api。
 *
 * 为什么不用 mock 模块：`platformAuth` 读的是本租户 D1 的 `cf_api` 单行，
 * `platformRequest` 走真 `fetch`。把这两段都假掉就等于没测「token 从哪来」；
 * 这里只假 cf-api 的 HTTP，其余全是真的。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { env as testEnv } from "./apply-migrations";
import { handleAdminDomains } from "../../src/admin/domains";

const BASE = "https://api.cf.test";
const ADMIN = "https://crm.test";

interface Call {
  method: string;
  path: string;
  body: Record<string, unknown> | null;
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function installFakeCf(opts: { conflict?: boolean; unauthorized?: boolean } = {}) {
  const calls: Call[] = [];
  const fetchImpl = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = new URL(String(input));
    if (!url.href.startsWith(BASE)) {
      if (url.hostname === "cloudflare-dns.com" || url.hostname === "dns.google") {
        const name = url.searchParams.get("name") ?? "";
        const type = url.searchParams.get("type") ?? "";
        const target = "origin-site.clever-vpn.org";
        const dcv = "www.brand.com.abc.dcv.cloudflare.com";
        const answers: { name: string; type: number; data: string }[] = [];
        if (type === "NS") answers.push({ name, type: 2, data: "ada.ns.cloudflare.com" });
        if (type === "CNAME" && name === "www.brand.com") answers.push({ name, type: 5, data: target });
        if (type === "CNAME" && name === "_acme-challenge.www.brand.com") {
          answers.push({ name, type: 5, data: dcv });
        }
        return json({ Status: 0, Answer: answers });
      }
      if (init?.method === "HEAD") return new Response(null, { status: 200 });
      throw new Error(`unexpected fetch ${url.href}`);
    }
    const method = (init?.method ?? "GET").toUpperCase();
    const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : null;
    calls.push({ method, path: url.pathname, body });

    if (opts.unauthorized) {
      return json({ error: "invalid api token" }, 401);
    }
    if (url.pathname === "/api/v2/crms/domains" && method === "GET") {
      if (opts.conflict) return json({ error: "host_taken", message: "该域名已被占用" }, 409);
      return json({
        slug: "acme",
        defaults: { crm: "acme.clever-panel.win", site: "acme.clever-link.win" },
        target: "origin-site.clever-vpn.org",
        domains: [
          {
            hostname: "www.brand.com",
            kind: "site",
            state: "pending",
            enabled: true,
            hostname_status: "pending",
            cert_status: "pending_validation",
            cf_hostname_id: "ch-1",
            created_at: "t0",
            verified_at: null,
            last_checked_at: "t0",
            last_error: null,
            dns: null,
          },
        ],
      });
    }
    if (url.pathname === "/api/v2/crms/domains/www.brand.com" && method === "GET") {
      return json({
        domain: {
          hostname: "www.brand.com",
          kind: "site",
          state: "active",
          enabled: true,
          hostname_status: "active",
          cert_status: "active",
          cert_expires_at: "2027-02-20T00:00:00Z",
          dcv_available: true,
          cf_hostname_id: "ch-1",
          created_at: "t0",
          verified_at: "t0",
          last_checked_at: "t0",
          last_error: null,
          dns: {
            target: "origin-site.clever-vpn.org",
            ownership: null,
            dcv: [
              {
                type: "CNAME",
                name: "_acme-challenge.www.brand.com",
                value: "www.brand.com.abc.dcv.cloudflare.com",
              },
            ],
          },
        },
      });
    }
    if (url.pathname === "/api/v2/crms/domains" && method === "POST") {
      return json(
        {
          domain: {
            hostname: String(body?.hostname ?? ""),
            kind: String(body?.kind ?? ""),
            state: "pending",
            enabled: true,
            hostname_status: "pending",
            cert_status: "pending_validation",
            cf_hostname_id: "ch-1",
            created_at: "t0",
            verified_at: null,
            last_checked_at: "t0",
            last_error: null,
            dns: null,
          },
        },
        201,
      );
    }
    if (url.pathname.startsWith("/api/v2/crms/domains/") && method === "DELETE") {
      return json({ ok: true, deleted: true });
    }
    return json({ error: "not found" }, 404);
  };
  vi.stubGlobal("fetch", fetchImpl);
  return calls;
}

function req(method: string, path: string, body?: unknown): Request {
  return new Request(`${ADMIN}/api/admin${path}`, {
    method,
    headers: body === undefined ? undefined : { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

beforeEach(async () => {
  (testEnv as unknown as Record<string, unknown>).APP_SECRET = "domains-admin-test-key";
  await testEnv.DB.prepare(`DELETE FROM cf_api`).run();
  await testEnv.DB.prepare(
    `INSERT INTO cf_api (id, base_url, token_enc, _updated_at) VALUES (1, ?, ?, ?)`,
  )
    .bind(BASE, "cv_api_test_token", new Date().toISOString())
    .run();
});

afterEach(() => {
  vi.unstubAllGlobals();
  (testEnv as unknown as Record<string, unknown>).MODE = "single";
});

describe("mode 分流", () => {
  it("single：只回说明，不发任何 cf-api 请求", async () => {
    (testEnv as unknown as Record<string, unknown>).MODE = "single";
    const calls = installFakeCf();

    const res = await handleAdminDomains(req("GET", "/domains"), testEnv, "ops@example.com");

    expect(res?.status).toBe(200);
    const body = (await res!.json()) as { supported: boolean; mode: string; reason: string };
    expect(body.supported).toBe(false);
    expect(body.mode).toBe("single");
    expect(body.reason).toContain("自部署");
    expect(calls).toHaveLength(0);
  });

  it("multi：GET 带回 domains", async () => {
    (testEnv as unknown as Record<string, unknown>).MODE = "multi";
    const calls = installFakeCf();

    const res = await handleAdminDomains(
      req("GET", "/domains"),
      testEnv,
      "ops@example.com",
    );

    expect(res?.status).toBe(200);
    const body = (await res!.json()) as {
      supported: boolean;
      slug: string;
      target: string;
      domains: { hostname: string }[];
    };
    expect(body.supported).toBe(true);
    expect(body.slug).toBe("acme");
    expect(body.target).toBe("origin-site.clever-vpn.org");
    expect(body.domains[0]?.hostname).toBe("www.brand.com");
    expect(calls[0]).toMatchObject({ method: "GET", path: "/api/v2/crms/domains" });
  });
});

describe("写操作与错误映射", () => {
  it("POST 校验通过后转发，返回 201 并写审计", async () => {
    (testEnv as unknown as Record<string, unknown>).MODE = "multi";
    const calls = installFakeCf();

    const res = await handleAdminDomains(
      req("POST", "/domains", { hostname: "www.brand.com", kind: "site" }),
      testEnv,
      "ops@example.com",
    );

    expect(res?.status).toBe(201);
    expect(calls[0]?.body).toEqual({ hostname: "www.brand.com", kind: "site" });
    const audit = await testEnv.DB.prepare(
      `SELECT action, target FROM audit_log ORDER BY id DESC LIMIT 1`,
    ).first<{ action: string; target: string }>();
    expect(audit).toMatchObject({ action: "domain.add", target: "www.brand.com" });
  });

  it("POST 非法 kind / 空 hostname ⇒ 400，不调 cf-api", async () => {
    (testEnv as unknown as Record<string, unknown>).MODE = "multi";
    const calls = installFakeCf();

    expect(
      (await handleAdminDomains(req("POST", "/domains", { hostname: "x.com", kind: "bad" }), testEnv, "a"))?.status,
    ).toBe(400);
    expect(
      (await handleAdminDomains(req("POST", "/domains", { hostname: "", kind: "site" }), testEnv, "a"))?.status,
    ).toBe(400);
    expect(calls).toHaveLength(0);
  });

  it("POST check：拉单域名 + DNS/HEAD，返回检查结果并写 domain_checks", async () => {
    (testEnv as unknown as Record<string, unknown>).MODE = "multi";
    const calls = installFakeCf();

    const res = await handleAdminDomains(
      req("POST", "/domains/www.brand.com/check"),
      testEnv,
      "ops@example.com",
    );

    expect(res?.status).toBe(200);
    const body = (await res!.json()) as {
      check: { status: string; provider: string; steps: { id: string; status: string }[] };
    };
    expect(body.check.status).toBe("ready");
    expect(body.check.provider).toBe("cloudflare");
    expect(body.check.steps.map((s) => s.id)).toEqual(["traffic", "dcv"]);
    expect(calls.some((c) => c.path === "/api/v2/crms/domains/www.brand.com")).toBe(true);

    const row = await testEnv.DB.prepare(
      "SELECT status FROM domain_checks WHERE hostname = ?",
    )
      .bind("www.brand.com")
      .first<{ status: string }>();
    expect(row?.status).toBe("ready");
  });

  it("DELETE 解码 hostname 后转发", async () => {
    (testEnv as unknown as Record<string, unknown>).MODE = "multi";
    const calls = installFakeCf();

    const res = await handleAdminDomains(
      req("DELETE", "/domains/www.brand.com"),
      testEnv,
      "ops@example.com",
    );

    expect(res?.status).toBe(200);
    expect(calls[0]).toMatchObject({ method: "DELETE", path: "/api/v2/crms/domains/www.brand.com" });
  });

  it("cf-api 409 带上可读 message", async () => {
    (testEnv as unknown as Record<string, unknown>).MODE = "multi";
    installFakeCf({ conflict: true });

    const res = await handleAdminDomains(req("GET", "/domains"), testEnv, "ops@example.com");
    expect(res?.status).toBe(409);
    const body = (await res!.json()) as { error: string; message: string };
    expect(body.error).toBe("conflict");
    expect(body.message).toContain("占用");
  });

  it("cf-api 401 ⇒ 502 platform_auth_failed（提示去设置里检查 token）", async () => {
    (testEnv as unknown as Record<string, unknown>).MODE = "multi";
    installFakeCf({ unauthorized: true });

    const res = await handleAdminDomains(req("GET", "/domains"), testEnv, "ops@example.com");
    expect(res?.status).toBe(502);
    const body = (await res!.json()) as { error: string; message: string };
    expect(body.error).toBe("platform_auth_failed");
    expect(body.message).toContain("cf-api");
  });

  it("网络失败（status 0）⇒ 503 platform_unreachable", async () => {
    (testEnv as unknown as Record<string, unknown>).MODE = "multi";
    vi.stubGlobal("fetch", async () => {
      throw new TypeError("network down");
    });

    const res = await handleAdminDomains(req("GET", "/domains"), testEnv, "ops@example.com");
    expect(res?.status).toBe(503);
    expect(((await res!.json()) as { error: string }).error).toBe("platform_unreachable");
  });
});
