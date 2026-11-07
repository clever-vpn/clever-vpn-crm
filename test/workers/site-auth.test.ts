/**
 * 集成测试：品牌官网的登录态（契约 §2.8）
 *
 * 官网与 App 用同一批 `/api/app/v1` 接口、同一份权益数据，区别只在**认证载体**：
 *   - App（原生壳）：`Authorization: Bearer <token>`
 *   - 官网（浏览器）：`Cookie: cv_session=<token>`，HttpOnly，服务端 Set-Cookie
 *
 * **CSRF 不做 Origin 校验**（2026-11-07 起）：会话 Cookie 是 host-only +
 * `HttpOnly` + `SameSite=Lax` —— 跨站请求带不上它，跨源响应的 `Set-Cookie` 也会被
 * 浏览器丢弃，所以"跨源 Cookie 认证"根本不可能发生。老的白名单只让**站点读不到数据**
 * （站点与 CRM 不同源），已删除。下面的用例断言"Origin 不再影响任何结果"。
 */
import { exports as rawExports } from "cloudflare:workers";
import { beforeAll, describe, expect, it } from "vitest";

import { env } from "./apply-migrations";

const BASE = "https://crm.test";
const EMAIL = "site-user@test.com";

const worker = rawExports as unknown as {
  default: { fetch(request: Request): Promise<Response> };
};

type CallInit = {
  method?: string;
  body?: unknown;
  token?: string;
  cookie?: string;
  origin?: string;
};

function call(path: string, init: CallInit = {}) {
  const headers: Record<string, string> = {};
  if (init.body !== undefined) headers["content-type"] = "application/json";
  if (init.token) headers.authorization = `Bearer ${init.token}`;
  if (init.cookie) headers.cookie = `cv_session=${init.cookie}`;
  if (init.origin) headers.origin = init.origin;
  return worker.default.fetch(
    new Request(`${BASE}${path}`, {
      method: init.method ?? "GET",
      headers,
      body: init.body === undefined ? undefined : JSON.stringify(init.body),
    }),
  );
}

/** 走一遍真实登录：发码（非 production 会回显）→ 校验 → 拿 token */
async function login(): Promise<string> {
  const sent = await call("/api/app/v1/auth/send-code", {
    method: "POST",
    body: { email: EMAIL },
    origin: BASE,
  });
  expect(sent.status).toBe(200);
  const { code } = (await sent.json()) as { code?: string };
  expect(code, "非 production 下应回显验证码").toBeTruthy();

  const verified = await call("/api/app/v1/auth/verify", {
    method: "POST",
    body: { email: EMAIL, code },
    origin: BASE,
  });
  expect(verified.status).toBe(200);

  const setCookie = verified.headers.get("set-cookie") ?? "";
  expect(setCookie).toContain("cv_session=");
  expect(setCookie).toMatch(/HttpOnly/i);
  expect(setCookie).toMatch(/SameSite=Lax/i);
  // 本地/测试是 http，加 Secure 浏览器就不回传了（生产才加）
  expect(setCookie).not.toMatch(/Secure/i);

  const token = /cv_session=([^;]+)/.exec(setCookie)?.[1];
  expect(token).toBeTruthy();
  return token as string;
}

beforeAll(() => {
  // 这些用例只关心认证与同源校验，不需要平台落账；
  // 因此不装假 cf-api —— 订阅停在 provisioning 也正是契约行为。
});

describe("官网登录态", () => {
  it("verify 下发 HttpOnly Cookie，且拿到的就是可用会话", async () => {
    const token = await login();

    const me = await call("/api/app/v1/me", { cookie: token });
    expect(me.status).toBe(200);
    const payload = (await me.json()) as { user: { email: string } };
    expect(payload.user.email).toBe(EMAIL);
  });

  it("Cookie 与 Bearer 拿到同一份 /me", async () => {
    const token = await login();

    const viaCookie = (await (await call("/api/app/v1/me", { cookie: token })).json()) as unknown;
    const viaBearer = (await (await call("/api/app/v1/me", { token })).json()) as unknown;
    expect(viaCookie).toEqual(viaBearer);
  });

  it("Cookie 写操作：Origin 不再影响结果（跨站与同源完全一致）", async () => {
    const token = await login();
    const body = { plan_id: "dev_period_100g" };

    const crossSite = await call("/api/app/v1/quote", {
      method: "POST",
      body,
      cookie: token,
      origin: "https://evil.example",
    });
    const sameSite = await call("/api/app/v1/quote", {
      method: "POST",
      body,
      cookie: token,
      origin: BASE,
    });

    // 拦人靠会话 + SameSite=Lax，不靠 Origin：老实现这里会是 403
    expect(crossSite.status).not.toBe(403);
    expect(sameSite.status).toBe(crossSite.status);
  });

  it("Bearer 请求不受 Origin 限制（原生壳）", async () => {
    const token = await login();

    const res = await call("/api/app/v1/quote", {
      method: "POST",
      body: { plan_id: "dev_period_100g" },
      token,
      origin: "capacitor://localhost",
    });
    expect(res.status).not.toBe(403);
  });

  it("Cookie 登出后旧 token 失效", async () => {
    const token = await login();
    expect((await call("/api/app/v1/me", { cookie: token })).status).toBe(200);

    const logout = await call("/api/app/v1/auth/logout", {
      method: "POST",
      cookie: token,
      origin: BASE,
    });
    expect(logout.status).toBe(200);
    expect(logout.headers.get("set-cookie") ?? "").toContain("cv_session=");

    expect((await call("/api/app/v1/me", { cookie: token })).status).toBe(401);
  });
});
