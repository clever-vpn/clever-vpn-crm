/**
 * studio 入口：CRM 出示租户 token → studio 回一个跳转 URL。
 *
 * 契约 `clever-vpn-docs/docs/contracts/studio-identity.md`（Contract 2，kind: shared）。
 * 这里钉住的是**行为边界**，不是字节格式（格式现在是 studio 自己的事了）：
 *
 *   1. 没会话 / 没 CSRF 头 ⇒ 不给 URL；
 *   2. 本租户没有 cf-api 凭据 ⇒ 409，**不发请求**出去；
 *   3. `url` 只能来自服务端配置的 studio，且必须是 `#t=tkt_` 片段（否则开放重定向）；
 *   4. 出示给 studio 的必须是**本租户自己那把 token**，且带 `aud` + CRM origin；
 *   5. studio 的四种拒绝各自映射成一次能读懂的话，不把上游细节糊给浏览器。
 */

import { afterEach, describe, expect, it, vi } from "vitest";

import { handleStudioTicket, requestStudioEntry, studioOriginOf } from "../../src/site/studio-ticket";

import { env } from "./apply-migrations";

import type { Env } from "../../src/env";

const APP_SECRET = "test-app-secret-0123456789abcdef";
const SITE = "https://site-studio.test";
const APP = "https://app-studio.test";
const TENANT_TOKEN = "cv_api_abcdefghijklmnopqrstuvwxyz0123456789ABCDEFG";

const envOf = (over: Partial<Env> = {}): Env =>
  ({ ...env, APP_SECRET, STUDIO_SITE_URL: SITE, STUDIO_APP_URL: APP, ...over }) as Env;

/** 把租户自己的 cf-api token 写进 D1（明文即可：creds 会容忍并就地升级） */
async function seedToken(token = TENANT_TOKEN, e: Env = envOf()): Promise<void> {
  await e.DB.prepare(
    `INSERT INTO cf_api (id, base_url, token_enc, _updated_at) VALUES (1, '', ?, ?)
     ON CONFLICT(id) DO UPDATE SET token_enc = excluded.token_enc`,
  )
    .bind(token, new Date().toISOString())
    .run();
}

function requestOf(body: unknown, init: { csrf?: boolean; origin?: string } = {}): Request {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (init.csrf !== false) headers["x-crm-request"] = "1";
  return new Request(`${init.origin ?? "https://crm.test"}/api/studio/ticket`, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });
}

function studioFetch(
  body: unknown,
  status = 200,
): { impl: typeof fetch; calls: Array<{ url: string; init: RequestInit }> } {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const impl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    calls.push({ url: String(input), init: init ?? {} });
    return new Response(JSON.stringify(body), {
      status,
      headers: { "content-type": "application/json" },
    });
  }) as unknown as typeof fetch;
  return { impl, calls };
}

const okBody = (url = `${SITE}/#t=tkt_abc.def`) => ({
  url,
  expires_at: "2026-11-10T07:00:00.000Z",
  tenant: "42",
});

afterEach(() => vi.restoreAllMocks());

describe("入口守卫（不花钱、不发请求）", () => {
  it("没有 CSRF 头 ⇒ 403", async () => {
    const spy = vi.spyOn(globalThis, "fetch");
    const res = await handleStudioTicket(requestOf({ aud: "site-studio" }, { csrf: false }), envOf(), "42", { user_id: 1 }, false);
    expect(res.status).toBe(403);
    expect(spy).not.toHaveBeenCalled();
  });

  it("没有管理员会话 ⇒ 401", async () => {
    const res = await handleStudioTicket(requestOf({ aud: "site-studio" }), envOf(), "42", null, true);
    expect(res.status).toBe(401);
  });

  it("aud 不在白名单 ⇒ 400", async () => {
    const res = await handleStudioTicket(requestOf({ aud: "nope" }), envOf(), "42", { user_id: 1 }, true);
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toBe("studio_aud_unknown");
  });

  it("本租户没有 cf-api 凭据 ⇒ 409，且一个请求都不发", async () => {
    const spy = vi.spyOn(globalThis, "fetch");
    await env.DB.prepare("DELETE FROM cf_api WHERE id = 1").run();
    const res = await handleStudioTicket(requestOf({ aud: "site-studio" }), envOf(), "42", { user_id: 1 }, true);
    expect(res.status).toBe(409);
    expect(((await res.json()) as { error: string }).error).toBe("studio_tenant_token_missing");
    expect(spy).not.toHaveBeenCalled();
  });

  it("没配 studio 地址 ⇒ 500 studio_not_configured", async () => {
    const result = await requestStudioEntry(envOf({ STUDIO_SITE_URL: "" }), {
      aud: "site-studio",
      crm: "https://crm.test",
      tenantToken: TENANT_TOKEN,
    });
    expect(result).toMatchObject({ ok: false, status: 500, code: "studio_not_configured" });
  });
});

describe("出示给 studio 的东西", () => {
  it("带本租户自己的 token + aud + CRM origin，且打到配置的 studio", async () => {
    await seedToken();
    const { impl, calls } = studioFetch(okBody());
    vi.spyOn(globalThis, "fetch").mockImplementation(impl);

    const res = await handleStudioTicket(requestOf({ aud: "site-studio" }), envOf(), "42", { user_id: 1 }, true);
    expect(res.status).toBe(200);

    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe(`${SITE}/api/studio/session`);
    const headers = calls[0]!.init.headers as Record<string, string>;
    expect(headers.authorization).toBe(`Bearer ${TENANT_TOKEN}`);
    const body = JSON.parse(String(calls[0]!.init.body)) as Record<string, unknown>;
    expect(body).toMatchObject({ aud: "site-studio", crm: "https://crm.test" });
    // studio 回来调 `/api/site/*` 的凭据（不是租户的全权 token）
    expect(String(body.site_token)).toMatch(/^sacc_/);
  });

  it("app-studio 不发 site_token（它没有站点，发了也用不上）", async () => {
    await seedToken();
    const { impl, calls } = studioFetch({ url: `${APP}/#t=tkt_x`, expires_at: null, tenant: "42" });
    vi.spyOn(globalThis, "fetch").mockImplementation(impl);

    await handleStudioTicket(requestOf({ aud: "app-studio" }), envOf(), "42", { user_id: 1 }, true);
    const body = JSON.parse(String(calls[0]!.init.body)) as Record<string, unknown>;
    expect(body.site_token).toBeUndefined();
  });

  it("回给前端的是 studio 给的 URL + 本次解析出的 tenant（客户端塞的不算数）", async () => {
    await seedToken();
    vi.spyOn(globalThis, "fetch").mockImplementation(studioFetch(okBody()).impl);

    const res = await handleStudioTicket(
      requestOf({ aud: "site-studio", tenant: "999", tenant_id: 999 }),
      envOf(),
      "42",
      { user_id: 1 },
      true,
    );
    const body = (await res.json()) as { url: string; tenant: string; aud: string };
    expect(body.url).toBe(`${SITE}/#t=tkt_abc.def`);
    expect(body.tenant).toBe("42");
    expect(body.aud).toBe("site-studio");
  });

  it("app-studio 打另一个地址（两个产品各自配置）", async () => {
    await seedToken();
    const { impl, calls } = studioFetch(okBody(`${APP}/#t=tkt_x.y`));
    vi.spyOn(globalThis, "fetch").mockImplementation(impl);

    const res = await handleStudioTicket(requestOf({ aud: "app-studio" }), envOf(), "42", { user_id: 1 }, true);
    expect(res.status).toBe(200);
    expect(calls[0]!.url).toBe(`${APP}/api/studio/session`);
  });
});

describe("studio 的拒绝与故障", () => {
  const cases: Array<{ status: number; error: string; expectStatus: number; word: string }> = [
    { status: 401, error: "studio_tenant_token_invalid", expectStatus: 409, word: "重新签发" },
    { status: 403, error: "studio_tenant_denied", expectStatus: 403, word: "未开通" },
    { status: 503, error: "studio_not_configured", expectStatus: 502, word: "稍后重试" },
    { status: 502, error: "studio_platform_unreachable", expectStatus: 502, word: "稍后重试" },
  ];

  for (const c of cases) {
    it(`studio ${c.status} ${c.error} ⇒ ${c.expectStatus}，给人话不给上游细节`, async () => {
      await seedToken();
      vi.spyOn(globalThis, "fetch").mockImplementation(studioFetch({ error: c.error }, c.status).impl);

      const res = await handleStudioTicket(requestOf({ aud: "site-studio" }), envOf(), "42", { user_id: 1 }, true);
      expect(res.status).toBe(c.expectStatus);
      const body = (await res.json()) as { error: string; message: string };
      expect(body.error).toBe(c.error);
      expect(body.message).toContain(c.word);
    });
  }

  it("网络异常/超时 ⇒ 502，不抛给调用方", async () => {
    await seedToken();
    vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("boom"));
    const res = await handleStudioTicket(requestOf({ aud: "site-studio" }), envOf(), "42", { user_id: 1 }, true);
    expect(res.status).toBe(502);
    expect(((await res.json()) as { error: string }).error).toBe("studio_unreachable");
  });

  it("studio 回了别的 origin / 不是 #t= 片段 ⇒ 502（防开放重定向）", async () => {
    await seedToken();
    for (const url of ["https://evil.example/#t=tkt_abc.def", `${SITE}/?t=tkt_abc.def`, `${SITE}/#t=sts_abc.def`]) {
      vi.spyOn(globalThis, "fetch").mockImplementation(studioFetch(okBody(url)).impl);
      const res = await handleStudioTicket(requestOf({ aud: "site-studio" }), envOf(), "42", { user_id: 1 }, true);
      expect(res.status).toBe(502);
      vi.restoreAllMocks();
    }
  });
});

describe("studioOriginOf", () => {
  it("按产品取各自配置，去尾斜杠", () => {
    const e = envOf({ STUDIO_SITE_URL: " https://site-studio.test/ ", STUDIO_APP_URL: "" });
    expect(studioOriginOf(e, "site-studio")).toBe("https://site-studio.test");
    expect(studioOriginOf(e, "app-studio")).toBe("");
  });
});
