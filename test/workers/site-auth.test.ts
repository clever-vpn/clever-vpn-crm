/**
 * 集成测试：终端会话只用 Bearer（契约 `clients` §6）
 *
 * App 与 Site 是同一批 `/api/app/v1` 接口、同一份权益数据；凭证只有一种：
 * `Authorization: Bearer <session_token>`。CRM **不再下发 Cookie**，
 * 所以没有 CSRF 面、也不校验 Origin。
 */
import { exports as rawExports } from "cloudflare:workers";
import { beforeAll, describe, expect, it } from "vitest";

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
  // 契约：登录只回身份，不再 Set-Cookie
  expect(verified.headers.get("set-cookie")).toBeNull();

  const body = (await verified.json()) as { session_token?: string; platform?: unknown };
  expect(body.session_token).toBeTruthy();
  // 登录响应不携带平台快照（权益走 /subscription）
  expect(body.platform).toBeUndefined();
  return body.session_token as string;
}

beforeAll(() => {
  // 这些用例只关心认证与 Origin：不需要平台落账
});

describe("终端会话（Bearer）", () => {
  it("verify 返回 session_token，且拿到的就是可用会话", async () => {
    const token = await login();
    const me = await call("/api/app/v1/me", { token });
    expect(me.status).toBe(200);
    const payload = (await me.json()) as { user: { email: string } };
    expect(payload.user.email).toBe(EMAIL);
  });

  it("Origin 不影响结果：跨站与同源完全一致", async () => {
    const token = await login();
    const body = { plan_id: "dev_period_100g" };

    const crossSite = await call("/api/app/v1/quote", {
      method: "POST",
      body,
      token,
      origin: "https://evil.example",
    });
    const sameSite = await call("/api/app/v1/quote", {
      method: "POST",
      body,
      token,
      origin: BASE,
    });

    // 这条只证明"Origin 不参与判定"：两边结果一致，且不是被 Origin 拦下的 403
    expect(crossSite.status).not.toBe(403);
    expect(crossSite.status).toBe(sameSite.status);
  });

  it("Cookie 不再认证（只剩 Bearer）", async () => {
    const token = await login();
    const res = await call("/api/app/v1/me", { cookie: token });
    expect(res.status).toBe(401);
  });

  it("登出后旧 token 失效", async () => {
    const token = await login();
    expect((await call("/api/app/v1/me", { token })).status).toBe(200);

    const logout = await call("/api/app/v1/auth/logout", {
      method: "POST",
      token,
      origin: BASE,
    });
    expect(logout.status).toBe(200);
    expect(logout.headers.get("set-cookie")).toBeNull();

    expect((await call("/api/app/v1/me", { token })).status).toBe(401);
  });
});
