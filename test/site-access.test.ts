/**
 * studio 调 `/api/site/*` 的凭据（`sacc_…`）。
 *
 * 契约 `site-studio-crm.md` §4.5。这里锁住四件事，每一件都对应一种真实事故：
 *
 *   1. **签名与租户必须同时过** —— 只验签名，一枚 token 就能改别人家站点；
 *   2. **有期限**（14 天）—— 永久 token 想作废只能换 `APP_SECRET`，而换它会连带
 *      作废退订链接与已存的网关密钥；
 *   3. **用途隔离** —— 与退订链接的 `crm/sign/v1` 用不同 key 材料，互不冒充；
 *   4. **`APP_SECRET` 没配就不签** —— 不能用空密钥凑合。
 */

import { describe, expect, it } from "vitest";

import {
  SITE_ACCESS_TTL_SECONDS,
  issueSiteAccess,
  verifySiteAccess,
} from "../src/site/access";

const KEY = "a".repeat(64);
const env = { APP_SECRET: KEY } as never;
const NOW = 1_800_000_000;

const bearer = (token: string) =>
  new Request("https://crm.test/api/site/settings", {
    headers: { authorization: `Bearer ${token}` },
  });

describe("签发与验证", () => {
  it("签出来的 token 能验证，且带回租户", async () => {
    const token = (await issueSiteAccess(env, "42", NOW))!;
    expect(token.startsWith("sacc_")).toBe(true);
    const claims = await verifySiteAccess(bearer(token), env, "42", NOW + 60);
    expect(claims?.tenant).toBe("42");
    expect(claims?.aud).toBe("site-studio");
  });

  it("换一个租户来验 ⇒ 不过（一枚 token 不能改别人家站点）", async () => {
    const token = (await issueSiteAccess(env, "42", NOW))!;
    expect(await verifySiteAccess(bearer(token), env, "43", NOW + 60)).toBeNull();
  });

  it("过期就失效（14 天）", async () => {
    const token = (await issueSiteAccess(env, "42", NOW))!;
    expect(await verifySiteAccess(bearer(token), env, "42", NOW + SITE_ACCESS_TTL_SECONDS - 1)).not.toBeNull();
    expect(await verifySiteAccess(bearer(token), env, "42", NOW + SITE_ACCESS_TTL_SECONDS + 1)).toBeNull();
  });

  it("没有 APP_SECRET ⇒ 不签（不能拿空密钥凑合）", async () => {
    expect(await issueSiteAccess({} as never, "42", NOW)).toBeNull();
    // 有 token 但服务端没配密钥 ⇒ 一律不通过
    const token = (await issueSiteAccess(env, "42", NOW))!;
    expect(await verifySiteAccess(bearer(token), {} as never, "42", NOW + 60)).toBeNull();
  });

  it("租户为空 ⇒ 不签（否则会变成人人都能用的 token）", async () => {
    expect(await issueSiteAccess(env, "  ", NOW)).toBeNull();
  });
});

describe("篡改与冒充", () => {
  it("改 payload 里的租户 ⇒ 签名对不上", async () => {
    const token = (await issueSiteAccess(env, "42", NOW))!;
    const [head, sig] = token.slice("sacc_".length).split(".");
    const payload = JSON.parse(atob(head!.replace(/-/g, "+").replace(/_/g, "/"))) as { tenant: string };
    payload.tenant = "43";
    const forged = `sacc_${btoa(JSON.stringify(payload)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "")}.${sig}`;
    expect(await verifySiteAccess(bearer(forged), env, "43", NOW + 60)).toBeNull();
  });

  it("别的用途签的东西不算（没有 sacc_ 前缀 / 前缀不对）", async () => {
    const token = (await issueSiteAccess(env, "42", NOW))!;
    const body = token.slice("sacc_".length);
    expect(await verifySiteAccess(bearer(`sts_${body}`), env, "42", NOW + 60)).toBeNull();
    expect(await verifySiteAccess(bearer(body), env, "42", NOW + 60)).toBeNull();
  });

  it("不带 Authorization ⇒ null（不做「没有也算通过」的兜底）", async () => {
    const req = new Request("https://crm.test/api/site/settings");
    expect(await verifySiteAccess(req, env, "42", NOW)).toBeNull();
  });

  it("换了主密钥 ⇒ 老 token 全失效（这正是不把 token 设成永久的原因）", async () => {
    const token = (await issueSiteAccess(env, "42", NOW))!;
    const rotated = { APP_SECRET: "b".repeat(64) } as never;
    expect(await verifySiteAccess(bearer(token), rotated, "42", NOW + 60)).toBeNull();
  });
});
