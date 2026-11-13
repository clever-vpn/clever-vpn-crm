/**
 * 后台「站点」页的发布语义（Contract 14）：
 *
 *   1. **后台发布默认用"最近一次发布的那份源包"** —— 租户在 studio 里发过就用它，
 *      从没发过就用部署自带的种子。绝不"退回公共模板把租户的页面抹掉"。
 *   2. 状态里要能看见线上是哪一版（`active`）以及源包从哪来（`sourceFrom`）。
 *   3. **回滚只切指针**，不产生新版本；但必须留下审计行。
 *
 * 这里跑真 D1 / 真 R2 / 真 cookie：`/api/admin/*` 的正确性藏在路由与鉴权里。
 */
import { exports as rawExports } from "cloudflare:workers";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";

import { env as testEnv } from "./apply-migrations";
import { ENGINE_ID } from "../../src/site/engine.generated";
import { SITE_CONTRACT } from "../../src/site/meta";
import { artifactShaOf } from "../../src/site/deliver";
import { activeKey } from "../../src/site/publish";
import { buildScope, readSiteSettings } from "../../src/site/settings";
import { issueSiteAccess } from "../../src/site/access";
import { seedSha } from "../../src/site/source";

const BASE = "https://crm.test";
const TENANT = "0";
const CSRF = { "x-crm-request": "1" };

/** dev 种子里那个管理员口令的哈希（`ops@example.com` / `crm-admin-2026`） */
const DEV_PASSWORD_HASH =
  "pbkdf2$sha256$50000$Y2xldmVydnBuLWRldi1zYQ$pNN_GLa4DQySXqMVpf9UB8ETxhsV6Z64uKaqiB190Mo";

const SITES = (testEnv as unknown as { SITES: R2Bucket }).SITES!;
const HOSTS = (testEnv as unknown as { HOSTS: KVNamespace }).HOSTS!;

const worker = rawExports as unknown as {
  default: { fetch(request: Request): Promise<Response> };
};

let cookie = "";

const call = (path: string, init: { method?: string; body?: unknown; auth?: boolean } = {}) => {
  const headers: Record<string, string> = { ...CSRF };
  if (init.body !== undefined) headers["content-type"] = "application/json";
  if (init.auth !== false && cookie) headers.cookie = cookie;
  return worker.default.fetch(
    new Request(`${BASE}${path}`, {
      method: init.method ?? "GET",
      headers,
      body: init.body === undefined ? undefined : JSON.stringify(init.body),
    }),
  );
};

const b64 = (text: string): string => {
  const bytes = new TextEncoder().encode(text);
  let bin = "";
  for (const byte of bytes) bin += String.fromCharCode(byte);
  return btoa(bin);
};

const hex = async (text: string): Promise<string> => {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
};

const PAGE = '<!doctype html><html><head><meta name="viewport" content="width=device-width"><title>t</title></head><body><h1>工作室那一版</h1></body></html>';

/** 走 studio 的路发布一版（`/api/site/publish` 带 files，一次完成） */
async function publishViaStudio(): Promise<{ seq: number; public_url: string | null }> {
  (testEnv as unknown as Record<string, unknown>).APP_SECRET = "admin-site-test-key";
  const token = (await issueSiteAccess(testEnv as never, TENANT))!;
  const settings = await readSiteSettings(testEnv as never);
  const artifact = await artifactShaOf([{ path: "index.html", text: PAGE }], buildScope(settings, "我的站点"));
  const res = await worker.default.fetch(
    new Request(`${BASE}/api/site/publish`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({
        trigger: "studio",
        manifest: {
          engine: ENGINE_ID,
          contract: SITE_CONTRACT,
          signoff: { by: "tenant:0", at: new Date().toISOString() },
          preview: { artifact_sha256: artifact.sha },
          files: [{ path: "index.html", sha256: await hex(PAGE), bytes: new TextEncoder().encode(PAGE).byteLength }],
        },
        files: [{ path: "index.html", content_b64: b64(PAGE) }],
      }),
    }),
  );
  expect(res.status, "发布应成功").toBe(200);
  const body = (await res.json()) as { seq: number; public_url?: string | null };
  return { seq: body.seq, public_url: body.public_url ?? null };
}

beforeAll(async () => {
  await testEnv.DB.prepare("DELETE FROM admin_users").run();
  await testEnv.DB.prepare(
    `INSERT INTO admin_users (email, password_hash, totp_enabled, created_at, updated_at)
     VALUES (?, ?, 0, ?, ?)`,
  )
    .bind("ops@example.com", DEV_PASSWORD_HASH, new Date().toISOString(), new Date().toISOString())
    .run();
  const res = await call("/api/admin/login", {
    method: "POST",
    body: { email: "ops@example.com", password: "crm-admin-2026" },
  });
  expect(res.status).toBe(200);
  cookie = (res.headers.get("set-cookie") ?? "").split(";")[0] ?? "";
  expect(cookie).toContain("crm_admin=");
});

beforeEach(async () => {
  for (const prefix of ["tpl/", `sites/${TENANT}/`]) {
    const listed = await SITES.list({ prefix });
    for (const o of listed.objects) await SITES.delete(o.key);
  }
  await HOSTS.delete(activeKey(TENANT));
  await testEnv.DB.prepare("DELETE FROM site_releases").run();
  await testEnv.DB.prepare("DELETE FROM site_pointer_log").run();
});

describe("后台站点状态", () => {
  it("没发布过 ⇒ active 为 null，源包来自种子", async () => {
    const res = await call("/api/admin/site");
    const body = (await res.json()) as { active: number | null; sourceFrom: string; releases: unknown[] };
    expect(body.active).toBeNull();
    expect(body.sourceFrom).toBe("seed");
    expect(body.releases).toEqual([]);
  });

  it("发布过 ⇒ active 与发布记录一致，且血缘里带种子指纹", async () => {
    await publishViaStudio();
    const res = await call("/api/admin/site");
    const body = (await res.json()) as {
      active: number | null;
      sourceFrom: string;
      releases: { seq: number; source_sha: string; artifact_sha: string }[];
    };
    expect(body.active).toBe(1);
    expect(body.sourceFrom).toBe("release:v1");
    expect(body.releases[0]!.seq).toBe(1);
    expect(body.releases[0]!.source_sha).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(body.releases[0]!.artifact_sha).toMatch(/^sha256:[0-9a-f]{64}$/);

    const row = await testEnv.DB.prepare("SELECT seed_sha FROM site_releases WHERE seq = 1").first<{
      seed_sha: string;
    }>();
    expect(row?.seed_sha).toBe(await seedSha());
  });
});

describe("后台发布", () => {
  it("从没发布过 ⇒ 能发（用种子）", async () => {
    const res = await call("/api/admin/site/publish", { method: "POST", body: {} });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; version: number };
    expect(body).toMatchObject({ ok: true, version: 1 });
    expect(await HOSTS.get(activeKey(TENANT), "json")).toEqual({ n: 1 });
  });

  it("studio 发过之后，后台再发用的仍是**租户那份源包**（不退回种子）", async () => {
    await publishViaStudio();
    const res = await call("/api/admin/site/publish", { method: "POST", body: {} });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { version: number; sourceSha: string };
    expect(body.version).toBe(2);

    const html = await SITES.get(`sites/${TENANT}/versions/2/public/index.html`);
    expect(await html?.text()).toContain("工作室那一版");
  });
});

describe("回滚", () => {
  it("切指针 + 写审计，**不产生新版本**", async () => {
    await publishViaStudio();
    await call("/api/admin/site/publish", { method: "POST", body: {} }); // v2

    const res = await call("/api/admin/site/rollback", { method: "POST", body: { version: 1 } });
    expect(res.status).toBe(200);
    expect(await HOSTS.get(activeKey(TENANT), "json")).toEqual({ n: 1 });

    const count = await testEnv.DB.prepare("SELECT COUNT(*) AS c FROM site_releases").first<{ c: number }>();
    expect(count?.c).toBe(2); // 没有新增

    const log = await testEnv.DB.prepare(
      "SELECT from_n, to_n, reason FROM site_pointer_log ORDER BY id DESC LIMIT 1",
    ).first<{ from_n: number; to_n: number; reason: string }>();
    expect(log).toMatchObject({ from_n: 2, to_n: 1, reason: "rollback" });
  });

  it("不存在的版本 ⇒ 404，指针不动", async () => {
    await publishViaStudio();
    const res = await call("/api/admin/site/rollback", { method: "POST", body: { version: 99 } });
    expect(res.status).toBe(404);
    expect(await HOSTS.get(activeKey(TENANT), "json")).toEqual({ n: 1 });
  });
});

/**
 * `public_url` = **站点对外地址**（契约 §6.4），studio 拿它给租户一个
 * 「点开看线上」的链接。它**不是** CRM 的 origin —— 那个地址打开的是后台。
 */
describe("public_url（站点对外地址）", () => {
  const setSiteUrl = (value: string) => {
    (testEnv as unknown as Record<string, unknown>).SITE_URL = value;
  };

  it("没配 SITE_URL ⇒ null（绝不回 CRM 自己的 origin）", async () => {
    setSiteUrl("");
    const body = await publishViaStudio();
    expect(body.public_url).toBeNull();
  });

  it("配了 SITE_URL ⇒ 去掉尾斜杠后原样给出", async () => {
    setSiteUrl("https://acme.example/");
    try {
      const body = await publishViaStudio();
      expect(body.public_url).toBe("https://acme.example");
    } finally {
      setSiteUrl("");
    }
  });
});
