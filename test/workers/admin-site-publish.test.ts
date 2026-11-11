/**
 * 后台「站点」页的两件事，都是**别让租户困惑**：
 *
 *   1. 交付过模板之后，后台的「发布站点」发的必须**是设计器那一版**（`tpl/<sha>`），
 *      不是库里那份公共模板 —— 否则"我在设计器改的怎么没上线"会变成一个谜，
 *      而且两条路都显示"发布成功"。
 *   2. 状态里要能看见"这次发布用的是哪一份模板"（`studio:v2` / `public:basic@v1`）。
 *
 * 这里跑真 D1 / 真 R2 / 真 cookie：`/api/admin/*` 的正确性藏在路由与鉴权里。
 */
import { exports as rawExports } from "cloudflare:workers";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";

import { env as testEnv } from "./apply-migrations";
import { ENGINE_ID } from "../../src/site/engine.generated";
import { SITE_CONTRACT } from "../../src/site/meta";
import { artifactShaOf } from "../../src/site/deliver";
import { activeKey, publicPrefix } from "../../src/site/publish";
import { buildScope, readSiteSettings } from "../../src/site/settings";
import { issueSiteAccess } from "../../src/site/access";

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

/** 走 studio 的那条路交付一版（用 `sacc_…`），顺便验证两条入口能对上同一份内容 */
async function deliverViaStudio(): Promise<void> {
  (testEnv as unknown as Record<string, unknown>).APP_SECRET = "admin-site-test-key";
  const token = (await issueSiteAccess(testEnv as never, TENANT))!;
  const settings = await readSiteSettings(testEnv as never);
  const artifact = await artifactShaOf([{ path: "index.html", text: PAGE }], buildScope(settings, "我的站点"));
  const res = await worker.default.fetch(
    new Request(`${BASE}/api/site/deliveries`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({
        manifest: {
          package: 1,
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
  expect(res.status, "交付应成功").toBe(200);
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
  // 公共模板也塞一份：这样才能证明"后台发的是设计器那版，不是公共模板"
  for (const prefix of ["tpl/", "g/templates/", `sites/${TENANT}/`]) {
    const listed = await SITES.list({ prefix });
    for (const o of listed.objects) await SITES.delete(o.key);
  }
  await SITES.put("g/templates/basic/v1/index.html", "<h1>公共模板</h1>");
  await HOSTS.delete(activeKey(TENANT));
  await testEnv.DB.prepare("DELETE FROM site_templates").run();
  await testEnv.DB.prepare("DELETE FROM site_versions").run();
  await testEnv.DB.prepare("UPDATE site_settings SET template_version = '' WHERE id = 1").run();
});

describe("后台站点状态", () => {
  it("没交付过 ⇒ 模板来源是公共模板", async () => {
    const res = await call("/api/admin/site");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { templateSource: string; templateVersion: string | null };
    expect(body.templateSource).toBe("public:basic@v1");
    expect(body.templateVersion).toBeNull();
  });

  it("交付过 ⇒ 模板来源是设计器那一版", async () => {
    await deliverViaStudio();
    const body = (await (await call("/api/admin/site")).json()) as {
      templateSource: string;
      templateVersion: string | null;
    };
    expect(body.templateVersion).toBe("v1");
    expect(body.templateSource).toBe("studio:v1");
  });
});

describe("后台「发布站点」", () => {
  it("交付过之后发的是设计器那一版（不是公共模板）", async () => {
    await deliverViaStudio();
    const res = await call("/api/admin/site/publish", { method: "POST", body: {} });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { template: string; templateVersion: string };
    expect(body.template).toBe("tenant");
    expect(body.templateVersion).toBe("v1");

    // 对象的 body 只能读一次：先取文本再断言
    const text = await (await SITES.get(`${publicPrefix(TENANT, 1)}index.html`))!.text();
    expect(text).toContain("工作室那一版");
    expect(text).not.toContain("公共模板");
  });

  it("从没交付过 ⇒ 仍然能发公共模板（老路径不受影响）", async () => {
    const res = await call("/api/admin/site/publish", { method: "POST", body: {} });
    expect(res.status).toBe(200);
    const html = await SITES.get(`${publicPrefix(TENANT, 1)}index.html`);
    expect(await html!.text()).toContain("公共模板");
  });

  it("显式指定模板时按显式来（不因为交付过就改发别的）", async () => {
    await deliverViaStudio();
    const res = await call("/api/admin/site/publish", {
      method: "POST",
      body: { template: "basic", template_version: "v1" },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { template: string };
    expect(body.template).toBe("basic");
  });
});
