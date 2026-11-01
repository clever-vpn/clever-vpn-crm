/**
 * `user.uuid` —— 商店账号绑定的唯一合法来源（契约 §2.3 ①）
 *
 * 三条要钉住的：
 *   1. 建号即生成，`/auth/verify` 与 `/me` 都给；
 *   2. 同一账号反复登录**不变**（换了就绑错人）；
 *   3. 两个账号不撞（唯一索引兜底）。
 */
import { exports as rawExports } from "cloudflare:workers";
import { describe, expect, it } from "vitest";

const BASE = "https://crm.test";

const worker = rawExports as unknown as {
  default: { fetch(request: Request): Promise<Response> };
};

interface UserView {
  id: number;
  uuid: string;
  email: string;
}

interface VerifyBody {
  session_token: string;
  user: UserView;
}

async function post(path: string, body: unknown): Promise<Response> {
  return worker.default.fetch(
    new Request(`${BASE}${path}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    }),
  );
}

async function get(path: string, token: string): Promise<Response> {
  return worker.default.fetch(
    new Request(`${BASE}${path}`, { headers: { authorization: `Bearer ${token}` } }),
  );
}

/** 走真实的"发码 → 验证"两步（非 production 会回显验证码） */
async function login(email: string): Promise<VerifyBody> {
  const sent = await post("/api/app/v1/auth/send-code", { email });
  const { code } = (await sent.json()) as { code?: string };
  expect(code, "非 production 应回显验证码").toBeTruthy();
  const verified = await post("/api/app/v1/auth/verify", { email, code });
  expect(verified.status).toBe(200);
  return (await verified.json()) as VerifyBody;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

describe("user.uuid", () => {
  it("建号即生成，/auth/verify 与 /me 都给同一个值", async () => {
    const first = await login("uuid-a@test.com");
    expect(first.user.uuid).toMatch(UUID_RE);

    const me = await get("/api/app/v1/me", first.session_token);
    expect(me.status).toBe(200);
    const body = (await me.json()) as { user: UserView };
    expect(body.user.uuid).toBe(first.user.uuid);
  });

  it("反复登录不变（换了就等于让商店绑到另一个人身上）", async () => {
    const again = await login("uuid-a@test.com");
    const first = await login("uuid-a@test.com");
    expect(again.user.uuid).toBe(first.user.uuid);
  });

  it("不同账号不撞", async () => {
    const a = await login("uuid-a@test.com");
    const b = await login("uuid-b@test.com");
    expect(a.user.uuid).not.toBe(b.user.uuid);
  });
});
