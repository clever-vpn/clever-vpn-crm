/**
 * cf-api 凭据（`src/platform/creds.ts`）：加密落库 + 明文自动升级
 *
 * 这几条是**运维语义**，不是实现细节：
 *   - 存进去的必须是密文（`d1 export` 是常规动作）
 *   - 明文（SaaS 开通 / 手工 seed）也要能读，并就地升级
 *   - 换了主密钥要报"解不开"，不能伪装成"没配过"
 */
import { describe, it, expect, beforeAll } from "vitest";
import { env } from "./apply-migrations";
import {
  platformCreds,
  readPlatformCreds,
  savePlatformCreds,
  markPlatformError,
  markPlatformOk,
} from "../../src/platform/creds";
import { platformAuth } from "../../src/platform/client";

const KEY = "master-key-for-creds-test";
const TOKEN = "cv_api_abcdefghijklmnop";

beforeAll(async () => {
  (env as unknown as Record<string, unknown>).PAYMENT_SECRET_KEY = KEY;
  await env.DB.prepare(`DELETE FROM cf_api`).run();
});

describe("cf-api 凭据", () => {
  it("没写过 ⇒ problem=no_token", async () => {
    const creds = await platformCreds(env);
    expect(creds.token).toBe("");
    expect(creds.problem).toBe("no_token");
    await expect(platformAuth(env)).rejects.toThrow(/未配置 cf-api 凭据/);
  });

  it("保存后库里是密文（v1: 前缀），明文不出现在任何一列", async () => {
    const res = await savePlatformCreds(env, { base_url: "https://api.example.test/", token: TOKEN });
    expect(res.ok).toBe(true);
    expect(res.view?.token_storage).toBe("encrypted");

    const row = await env.DB.prepare(`SELECT base_url, token_enc FROM cf_api WHERE id = 1`).first<{
      base_url: string;
      token_enc: string;
    }>();
    expect(row?.base_url).toBe("https://api.example.test"); // 末尾斜杠被去掉
    expect(row?.token_enc.startsWith("v1:")).toBe(true);
    expect(row?.token_enc).not.toContain(TOKEN);
  });

  it("读回来是原文；后台视图永不回显 token", async () => {
    const creds = await platformCreds(env);
    expect(creds.token).toBe(TOKEN);
    expect(creds.base).toBe("https://api.example.test");

    const view = await readPlatformCreds(env);
    expect(view.has_token).toBe(true);
    expect(JSON.stringify(view)).not.toContain(TOKEN);
    expect(view.effective_base).toBe("https://api.example.test");
  });

  it("库里是明文（SaaS 开通 / 手工 seed）也能读，并就地升级成密文", async () => {
    await env.DB.prepare(`UPDATE cf_api SET token_enc = ? WHERE id = 1`).bind(TOKEN).run();

    const before = await readPlatformCreds(env);
    expect(before.token_storage).toBe("plaintext");

    expect((await platformCreds(env)).token).toBe(TOKEN);

    const after = await readPlatformCreds(env);
    expect(after.token_storage).toBe("encrypted");
  });

  it("主密钥换过 ⇒ problem=undecryptable（不假装没配）", async () => {
    (env as unknown as Record<string, unknown>).PAYMENT_SECRET_KEY = "another-key";
    try {
      const creds = await platformCreds(env);
      expect(creds.token).toBe("");
      expect(creds.problem).toBe("undecryptable");
      await expect(platformAuth(env)).rejects.toThrow(/解不开/);
    } finally {
      (env as unknown as Record<string, unknown>).PAYMENT_SECRET_KEY = KEY;
    }
  });

  it("拒绝不合法的 token 与基址", async () => {
    expect((await savePlatformCreds(env, { token: "not-a-token" })).code).toBe("invalid_token");
    expect((await savePlatformCreds(env, { base_url: "api.example.test" })).code).toBe("invalid_base");
  });

  it("基址留空 ⇒ 回退到 env.CF_API_BASE；token 不传 ⇒ 不变", async () => {
    await savePlatformCreds(env, { base_url: "" });
    (env as unknown as Record<string, unknown>).CF_API_BASE = "https://fallback.test";
    const view = await readPlatformCreds(env);
    expect(view.effective_base).toBe("https://fallback.test");
    expect((await platformCreds(env)).token).toBe(TOKEN);
  });

  it("联通结果可记录：成功清错误，失败留原因且保留上次成功时间", async () => {
    await markPlatformOk(env);
    let view = await readPlatformCreds(env);
    expect(view.verified_at).toBeTruthy();
    expect(view.last_error).toBeNull();

    const verified = view.verified_at;
    await markPlatformError(env, "HTTP 401");
    view = await readPlatformCreds(env);
    expect(view.last_error).toBe("HTTP 401");
    expect(view.verified_at).toBe(verified);
  });
});
