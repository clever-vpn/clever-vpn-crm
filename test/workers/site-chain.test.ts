/**
 * **完整一条链**：管理员点「打开设计器」→ 拿到 `sacc_…` → 用它对 CRM 干活。
 *
 * 契约 `site-studio-crm.md` §4.5 + `studio-identity.md` §2.1.1。
 *
 * 这条链分处两个仓，靠一个**手写错就崩**的格式串起来（HMAC + base64url + 租户比对），
 * 单测各测一半很容易"两边都绿、合起来 401"。所以这里在**同一个 Worker 里**跑一遍
 * 真的：真 D1、真 R2、真 crypto，只把 studio 那一跳替身掉（它不在本仓）。
 *
 * 断言的四步：
 *   1. 入场时交给 studio 的 body 里**有** `site_token`；
 *   2. 这枚 token 能读设置（`GET /api/site/settings`）；
 *   3. 同一枚能拉模板（`GET /api/site/template`，公共模板三态里的 public 分支）；
 *   4. 别的租户的 token 在这两个端点上都是 401。
 */
import { exports as rawExports } from "cloudflare:workers";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { env as testEnv } from "./apply-migrations";
import { handleStudioTicket } from "../../src/site/studio-ticket";
import type { Env } from "../../src/env";

const SITE = "https://site-studio.test";
const TENANT = "0"; // 单租户模式：`scoped.tenantId` = `CRM_TENANT_ID`
const TENANT_TOKEN = "cv_api_abcdefghijklmnopqrstuvwxyz0123456789ABCDEFG";

const SITES = (testEnv as unknown as { SITES: R2Bucket }).SITES!;

const worker = rawExports as unknown as {
  default: { fetch(request: Request): Promise<Response> };
};

/**
 * 主密钥**就地**写进测试环境（和 `site-settings.test.ts` 的 `setSecret` 同一招）：
 * workerd 的 env 是同一个对象，就地改才"签名的一方"和"验签的一方"看到同一把密钥。
 *
 * 不用 `{ ...testEnv }` 造副本 —— 副本是 Node 侧的对象，Worker 里读不到，
 * 结果就是"本地绿、CI 红"（CI 没有 `.dev.vars`）。
 */
function setSecret(value = "chain-test-master-key"): void {
  (testEnv as unknown as Record<string, unknown>).APP_SECRET = value;
}

const envOf = (): Env => testEnv as unknown as Env;

async function seedTenantToken(): Promise<void> {
  await testEnv.DB.prepare(
    `INSERT INTO cf_api (id, base_url, token_enc, _updated_at) VALUES (1, '', ?, ?)
     ON CONFLICT(id) DO UPDATE SET token_enc = excluded.token_enc`,
  )
    .bind(TENANT_TOKEN, new Date().toISOString())
    .run();
}

/** 替身 studio：只记下我们交给它的东西 */
function fakeStudio(): { impl: typeof fetch; bodies: Record<string, unknown>[] } {
  const bodies: Record<string, unknown>[] = [];
  const impl = (async (_input: RequestInfo | URL, init?: RequestInit) => {
    bodies.push(JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>);
    return new Response(JSON.stringify({ url: `${SITE}/#t=tkt_abc.def`, expires_at: null, tenant: TENANT }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }) as unknown as typeof fetch;
  return { impl, bodies };
}

/** 走一遍入场，把交给 studio 的 `site_token` 拿回来 */
async function enter(): Promise<string> {
  setSecret();
  (testEnv as unknown as Record<string, unknown>).STUDIO_SITE_URL = SITE;
  await seedTenantToken();
  const studio = fakeStudio();
  vi.spyOn(globalThis, "fetch").mockImplementation(studio.impl);

  const res = await handleStudioTicket(
    new Request("https://crm.test/api/studio/ticket", {
      method: "POST",
      headers: { "content-type": "application/json", "x-crm-request": "1" },
      body: JSON.stringify({ aud: "site-studio" }),
    }),
    envOf(),
    TENANT,
    { user_id: 1 },
    true,
  );
  expect(res.status).toBe(200);

  const token = String(studio.bodies[0]?.site_token ?? "");
  expect(token).toMatch(/^sacc_/);
  return token;
}

const siteCall = (path: string, token: string) =>
  worker.default.fetch(
    new Request(`https://t-beta.clever-panel.win${path}`, {
      headers: { authorization: `Bearer ${token}` },
    }),
  );

beforeEach(async () => {
  for (const prefix of ["g/templates/basic/", "tpl/"]) {
    const listed = await SITES.list({ prefix });
    for (const o of listed.objects) await SITES.delete(o.key);
  }
  await testEnv.DB.prepare("DELETE FROM site_releases").run();
  await testEnv.DB.prepare("DELETE FROM site_pointer_log").run();
});

afterEach(() => vi.restoreAllMocks());

describe("入场 → 回电：一条链跑通", () => {
  it("入场给的 sacc_ 能读设置", async () => {
    const token = await enter();
    const res = await siteCall("/api/site/settings", token);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { rev: number; scope: Record<string, unknown> };
    expect(body.rev).toBeGreaterThanOrEqual(0);
    expect((body.scope as { site?: { name?: string } }).site?.name).toBeTruthy();
  });

  it("同一枚 sacc_ 能拉源包（没发布过 ⇒ 用部署自带的种子）", async () => {
    const token = await enter();

    const res = await siteCall("/api/site/template", token);
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      source: string;
      sha: string;
      files: { path: string; content_b64: string }[];
    };
    // Contract 14：没有"公共模板目录"了，种子在代码里（`seed.generated.ts`）
    expect(body.source).toBe("seed");
    expect(body.sha).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(body.files.map((f) => f.path)).toContain("index.html");
    expect(body.files.length).toBeGreaterThan(5);
  });

  it("别的租户的 token：两个端点都 401（一枚 token 不能改别人家站点）", async () => {
    const { issueSiteAccess } = await import("../../src/site/access");
    const foreign = (await issueSiteAccess(envOf(), "999"))!;
    expect((await siteCall("/api/site/settings", foreign)).status).toBe(401);
    expect((await siteCall("/api/site/template", foreign)).status).toBe(401);
  });

  it("没有 token：两个端点都 401（模板也是租户内容，不是公开资料）", async () => {
    const bare = (path: string) =>
      worker.default.fetch(new Request(`https://t-beta.clever-panel.win${path}`));
    expect((await bare("/api/site/settings")).status).toBe(401);
    expect((await bare("/api/site/template")).status).toBe(401);
  });
});

/**
 * `PUT /api/site/settings`（契约 v13 §4.6）：设计器里改设置。
 *
 * 三件事：`sacc_` 能写、`if_rev` 是必带的乐观锁（冲突 409）、派生值不可写。
 * 真源永远在 CRM —— 这组用例就是在锁这条。
 */
describe("设置可写（设计器 → CRM）", () => {
  const put = (token: string, body: unknown) =>
    worker.default.fetch(
      new Request("https://t-beta.clever-panel.win/api/site/settings", {
        method: "PUT",
        headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
        body: JSON.stringify(body),
      }),
    );

  it("带 if_rev 写入 ⇒ rev +1，scope 立刻反映新值", async () => {
    const token = await enter();
    const before = (await (await siteCall("/api/site/settings", token)).json()) as { rev: number };

    const res = await put(token, {
      if_rev: before.rev,
      values: { site: { name: "云端加速" } },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      ok: boolean;
      rev: number;
      values: { site?: { name?: string } };
      scope: { site?: { name?: string } };
    };
    expect(body.ok).toBe(true);
    expect(body.rev).toBe(before.rev + 1);
    expect(body.values.site?.name).toBe("云端加速");
    expect(body.scope.site?.name).toBe("云端加速");
  });

  it("rev 不匹配 ⇒ 409（不许后写静默覆盖先写）", async () => {
    const token = await enter();
    const before = (await (await siteCall("/api/site/settings", token)).json()) as { rev: number };

    const res = await put(token, { if_rev: before.rev - 1, values: { site: { name: "x" } } });
    expect(res.status).toBe(409);
    await expect(res.json()).resolves.toMatchObject({ error: "rev_conflict" });
  });

  it("不带 if_rev ⇒ 400（缺乐观锁就不收）", async () => {
    const token = await enter();
    const res = await put(token, { values: { site: { name: "x" } } });
    expect(res.status).toBe(400);
    await expect(res.json()).resolves.toMatchObject({ error: "rev_required" });
  });

  it("派生值不可写 ⇒ 400（写了也不会生效，那是最糟的结果）", async () => {
    const token = await enter();
    const before = (await (await siteCall("/api/site/settings", token)).json()) as { rev: number };
    const res = await put(token, {
      if_rev: before.rev,
      values: { site: { footer: "© 我改的" } },
    });
    expect(res.status).toBe(400);
  });

  it("不传 collections ⇒ 下载入口原样保留", async () => {
    const token = await enter();
    const before = (await (await siteCall("/api/site/settings", token)).json()) as {
      rev: number;
      collections: unknown;
    };
    const res = await put(token, { if_rev: before.rev, values: { site: { tagline: "t" } } });
    const body = (await res.json()) as { collections: unknown };
    expect(body.collections).toEqual(before.collections);
  });
});
