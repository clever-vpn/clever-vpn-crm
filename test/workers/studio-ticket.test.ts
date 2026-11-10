/**
 * studio 票据：签发 + 验签 + 端点。
 *
 * 契约 `clever-vpn-docs/docs/contracts/studio-identity.md`（Contract 1，kind: shared）。
 * 这里钉住的是**契约里能判定的那部分**：
 *
 *   1. 没会话 / 没 CSRF 头 ⇒ 不给票；
 *   2. 票一定在 URL **fragment**（`#t=`），且 `url` 来自服务端配置（不是请求参数）；
 *   3. 签名 + `exp` + `aud` 三项都验；`aud` 不同的票互不通用；
 *   4. `tenant` 来自本次请求解析出的租户，**不接受客户端传入**。
 */

import { beforeEach, describe, expect, it } from "vitest";

import { env } from "./apply-migrations";
import { sha256Hex } from "../../src/admin/crypto";
import {
  SESSION_TTL_SECONDS,
  TICKET_TTL_SECONDS,
  handleStudioTicket,
  mintStudioTicket,
  verifyStudioToken,
} from "../../src/site/studio-ticket";

import type { Env } from "../../src/env";

const MASTER = "test-master-key";
const SITE = "https://site-studio.test";
const APP = "https://app-studio.test";
const TENANT = "42";
const TOKEN = "plain-session-token-for-tests";

const testEnv = {
  ...env,
  STUDIO_TICKET_MASTER: MASTER,
  STUDIO_SITE_URL: SITE,
  STUDIO_APP_URL: APP,
} as unknown as Env;

/** 造一条管理员会话（与 `sessionFrom` 的算法一致：id = sha256(token)） */
async function seedAdminSession(): Promise<void> {
  await env.DB.prepare(
    `INSERT INTO admin_users (id, email, password_hash, created_at, updated_at)
     VALUES (1, 'a@b.c', 'x', '2026-11-10T00:00:00Z', '2026-11-10T00:00:00Z')`,
  ).run();
  await env.DB.prepare(
    `INSERT INTO admin_sessions (id, user_id, pending, created_at, last_used_at, ip, user_agent)
     VALUES (?, 1, 0, ?, ?, '', '')`,
  )
    .bind(await sha256Hex(TOKEN), new Date().toISOString(), new Date().toISOString())
    .run();
}

const request = (body: unknown, headers: Record<string, string> = {}) =>
  new Request("https://crm.example.com/api/studio/ticket", {
    method: "POST",
    headers: { "content-type": "application/json", "x-crm-request": "1", ...headers },
    body: JSON.stringify(body),
  });

beforeEach(async () => {
  await env.DB.prepare("DELETE FROM admin_sessions").run();
  await env.DB.prepare("DELETE FROM admin_users").run();
});

describe("mintStudioTicket", () => {
  it("票据在 fragment 里，且能被同一 aud 验出来", async () => {
    const minted = await mintStudioTicket(testEnv, {
      tenant: TENANT,
      crm: "https://crm.example.com",
      aud: "site-studio",
    });
    if (!minted.ok) throw new Error(minted.message);

    expect(minted.url.startsWith(`${SITE}/#t=tkt_`)).toBe(true);
    // 严格说：不允许落到 query（会进日志与 Referer）
    expect(minted.url).not.toContain("?t=");

    const ticket = minted.url.split("#t=")[1]!;
    const claims = await verifyStudioToken(testEnv, ticket, { aud: "site-studio", prefix: "tkt" });
    expect(claims?.tenant).toBe(TENANT);
    expect(claims?.crm).toBe("https://crm.example.com");
    expect(claims?.aud).toBe("site-studio");
    expect(claims?.exp).toBeGreaterThan(Math.floor(Date.now() / 1000));
  });

  it("aud 不同 ⇒ 验不过（一张票只能用于一个产品）", async () => {
    const minted = await mintStudioTicket(testEnv, {
      tenant: TENANT,
      crm: "https://crm.example.com",
      aud: "site-studio",
    });
    if (!minted.ok) throw new Error(minted.message);
    const ticket = minted.url.split("#t=")[1]!;

    expect(await verifyStudioToken(testEnv, ticket, { aud: "app-studio", prefix: "tkt" })).toBeNull();
  });

  it("过期、改一个字节、换前缀都验不过", async () => {
    const now = Math.floor(Date.now() / 1000);
    const minted = await mintStudioTicket(testEnv, {
      tenant: TENANT,
      crm: "https://crm.example.com",
      aud: "site-studio",
      now,
    });
    if (!minted.ok) throw new Error(minted.message);
    const ticket = minted.url.split("#t=")[1]!;

    // 过期：用票据到期之后的时间点验
    expect(
      await verifyStudioToken(testEnv, ticket, {
        aud: "site-studio",
        prefix: "tkt",
        now: now + TICKET_TTL_SECONDS + 1,
      }),
    ).toBeNull();

    // 篡改 payload（改一个字符）
    const [payload, signature] = ticket.slice(4).split(".");
    const tampered = `tkt_${payload!.slice(0, -1)}${payload!.endsWith("A") ? "B" : "A"}.${signature}`;
    expect(await verifyStudioToken(testEnv, tampered, { aud: "site-studio", prefix: "tkt" })).toBeNull();

    // 前缀不对
    expect(await verifyStudioToken(testEnv, ticket, { aud: "site-studio", prefix: "sts" })).toBeNull();
  });

  it("缺配置时给出可照做的错误，而不是签一张空票", async () => {
    const noMaster = { ...testEnv, STUDIO_TICKET_MASTER: "" } as unknown as Env;
    const r1 = await mintStudioTicket(noMaster, { tenant: TENANT, crm: "https://c", aud: "site-studio" });
    expect(r1.ok ? "" : r1.code).toBe("studio_not_configured");

    const noUrl = { ...testEnv, STUDIO_SITE_URL: "" } as unknown as Env;
    const r2 = await mintStudioTicket(noUrl, { tenant: TENANT, crm: "https://c", aud: "site-studio" });
    expect(r2.ok ? "" : r2.message).toContain("STUDIO_SITE_URL");
  });
});

describe("POST /api/studio/ticket", () => {
  it("没有管理员会话 ⇒ 401", async () => {
    const res = await handleStudioTicket(request({ aud: "site-studio" }), testEnv, TENANT, null, true);
    expect(res.status).toBe(401);
  });

  it("没有 x-crm-request 头 ⇒ 403（与后台同一道 CSRF 防线）", async () => {
    const res = await handleStudioTicket(
      request({ aud: "site-studio" }),
      testEnv,
      TENANT,
      { user_id: 1 },
      false,
    );
    expect(res.status).toBe(403);
  });

  it("aud 不在白名单 ⇒ 400", async () => {
    const res = await handleStudioTicket(
      request({ aud: "other-studio" }),
      testEnv,
      TENANT,
      { user_id: 1 },
      true,
    );
    expect(res.status).toBe(400);
    expect((await res.json() as { error: string }).error).toBe("studio_aud_unknown");
  });

  it("带会话 + 正确 aud ⇒ 200，返回的 url 能验出当前租户", async () => {
    await seedAdminSession();
    const res = await handleStudioTicket(
      request({ aud: "app-studio" }),
      testEnv,
      TENANT,
      { user_id: 1 },
      true,
    );
    expect(res.status).toBe(200);

    const body = (await res.json()) as { url: string; aud: string };
    expect(body.aud).toBe("app-studio");
    expect(body.url.startsWith(`${APP}/#t=tkt_`)).toBe(true);

    const claims = await verifyStudioToken(testEnv, body.url.split("#t=")[1]!, {
      aud: "app-studio",
      prefix: "tkt",
    });
    expect(claims?.tenant).toBe(TENANT);
  });

  it("tenant 只认服务端解析出来的那个（客户端传了也没用）", async () => {
    await seedAdminSession();
    const res = await handleStudioTicket(
      request({ aud: "site-studio", tenant: "999" }),
      testEnv,
      TENANT,
      { user_id: 1 },
      true,
    );
    const body = (await res.json()) as { url: string };
    const claims = await verifyStudioToken(testEnv, body.url.split("#t=")[1]!, {
      aud: "site-studio",
      prefix: "tkt",
    });
    expect(claims?.tenant).toBe(TENANT);
  });
});

describe("会话时长", () => {
  it("是 14 天（契约 §3.1），不是 24 小时", () => {
    expect(SESSION_TTL_SECONDS).toBe(14 * 24 * 60 * 60);
    expect(TICKET_TTL_SECONDS).toBe(60);
  });
});
