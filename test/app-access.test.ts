/**
 * studio 回写绑定用的借据（`aacc_…`）。
 *
 * 契约 `studio-identity.md` §2.1.2 + `services/crm/app-studio.md` §3.2。
 * 与 `site-access.test.ts` 一一对应，另外多一条**标签隔离**：
 * `sacc_` 与 `aacc_` 用不同的 key 材料，谁也冒充不了谁。
 */

import { describe, expect, it } from "vitest";

import { APP_ACCESS_TTL_SECONDS, issueAppAccess, verifyAppAccess } from "../src/app/access";
import { issueSiteAccess } from "../src/site/access";

const KEY = "b".repeat(64);
const env = { APP_SECRET: KEY } as never;
const NOW = 1_800_000_000;

const bearer = (token: string) =>
  new Request("https://crm.test/api/studio/app-bind", {
    method: "POST",
    headers: { authorization: `Bearer ${token}` },
  });

describe("签发与验证", () => {
  it("签出来的 token 能验证，且带回租户与受众", async () => {
    const token = (await issueAppAccess(env, "42", NOW))!;
    expect(token.startsWith("aacc_")).toBe(true);
    const claims = await verifyAppAccess(bearer(token), env, "42", NOW + 60);
    expect(claims?.tenant).toBe("42");
    expect(claims?.aud).toBe("app-studio");
    expect(claims?.t).toBe("aacc");
  });

  it("换一个租户来验 ⇒ 不过（一枚 token 不能改别人家绑定）", async () => {
    const token = (await issueAppAccess(env, "42", NOW))!;
    expect(await verifyAppAccess(bearer(token), env, "43", NOW + 60)).toBeNull();
    expect(await verifyAppAccess(bearer(token), env, "", NOW + 60)).toBeNull();
  });

  it("过期就失效（14 天）", async () => {
    const token = (await issueAppAccess(env, "42", NOW))!;
    expect(await verifyAppAccess(bearer(token), env, "42", NOW + APP_ACCESS_TTL_SECONDS - 1)).not.toBeNull();
    expect(await verifyAppAccess(bearer(token), env, "42", NOW + APP_ACCESS_TTL_SECONDS + 1)).toBeNull();
  });

  it("没有 APP_SECRET / 租户为空 ⇒ 不签（不拿空密钥凑合）", async () => {
    expect(await issueAppAccess({} as never, "42", NOW)).toBeNull();
    expect(await issueAppAccess(env, "  ", NOW)).toBeNull();
    const token = (await issueAppAccess(env, "42", NOW))!;
    expect(await verifyAppAccess(bearer(token), {} as never, "42", NOW + 60)).toBeNull();
  });

  it("标签隔离：site 的 sacc_ 冒充不了 app 的 aacc_（反之亦然）", async () => {
    const site = (await issueSiteAccess(env, "42", NOW))!;
    expect(site.startsWith("sacc_")).toBe(true);
    // 同租户、同 APP_SECRET、未过期 —— 但标签不同，必须不通过
    expect(await verifyAppAccess(bearer(site), env, "42", NOW + 60)).toBeNull();

    const app = (await issueAppAccess(env, "42", NOW))!;
    const { verifySiteAccess } = await import("../src/site/access");
    const siteReq = new Request("https://crm.test/api/site/settings", {
      headers: { authorization: `Bearer ${app}` },
    });
    expect(await verifySiteAccess(siteReq, env, "42", NOW + 60)).toBeNull();
  });
});
