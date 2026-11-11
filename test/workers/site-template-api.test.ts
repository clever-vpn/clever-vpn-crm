/**
 * `GET /api/site/template` —— **重建用的源包**（Contract 14，契约 §0.1.4）。
 *
 * 这个端点存在的唯一理由：studio 的 DO 是可弃的。租户从 CRM 进来、DO 是空的时，
 * studio 必须能从 CRM 拿到"他上次发布的那份"，而不是我们自己的示例骨架。
 *
 * 两态 + 一条硬规则：
 *   · 发布过 ⇒ `source: "release"`，内容 = 最近一次发布记录的 `source_sha`；
 *   · 从没发布过 ⇒ `source: "seed"`，内容 = 当前部署自带的种子；
 *   · 发布过但内容读不到 ⇒ **404**（绝不退回种子 —— 那等于把租户的站换掉）。
 */
import { beforeEach, describe, expect, it } from "vitest";

import { exports as rawExports } from "cloudflare:workers";

import { env as testEnv } from "./apply-migrations";
import { issueSiteAccess } from "../../src/site/access";
import { publishSite } from "../../src/site/publish";
import { seedSha, storeSource } from "../../src/site/source";

/** Worker 入口（workerd 里就是默认导出，与 `site-chain.test.ts` 同一招） */
const worker = rawExports as unknown as {
  default: { fetch(request: Request): Promise<Response> };
};
// 第二个参数只是历史的调用习惯（env 由 workerd 提供），签名留着免得改动一堆调用点
const handle = (request: Request, _env?: unknown) => worker.default.fetch(request);

// 单租户模式下 `scoped.tenantId` 就是 `CRM_TENANT_ID`（测试配置里是 `0`）
const TENANT = "0";
const SITES: R2Bucket = testEnv.SITES!;

/**
 * 主密钥**就地**写进测试环境：workerd 的 env 是同一个对象，"签名的一方"与
 * "验签的一方"才看到同一把密钥（造副本会出现"本地绿、CI 红"）。
 */
function envOf(): never {
  (testEnv as unknown as Record<string, unknown>).APP_SECRET = "template-api-test-key";
  (testEnv as unknown as Record<string, unknown>).STUDIO_CRM_BASE = "https://crm.test";
  return testEnv as never;
}

async function token(): Promise<string> {
  const issued = await issueSiteAccess(envOf(), TENANT);
  return issued!;
}

const call = async (path: string, bearer?: string) =>
  handle(
    new Request(`https://crm.test${path}`, {
      headers: bearer ? { authorization: `Bearer ${bearer}` } : {},
    }),
    envOf(),
  );

/** 造一份租户源包并发布一次 */
async function publishOnce(files: Record<string, string>): Promise<string> {
  const stored = await storeSource(
    testEnv,
    Object.entries(files).map(([path, body]) => ({ path, body })),
  );
  if (!stored.ok) throw new Error(stored.message);
  const published = await publishSite(testEnv, TENANT, {
    sourceSha: stored.sha,
    apiBase: "https://crm.test",
  });
  if (!published.ok) throw new Error(published.message);
  return stored.sha;
}

beforeEach(async () => {
  const listed = await SITES.list({ prefix: `sites/${TENANT}/` });
  for (const o of listed.objects) await SITES.delete(o.key);
  const tpl = await SITES.list({ prefix: "tpl/" });
  for (const o of tpl.objects) await SITES.delete(o.key);
  await testEnv.DB.prepare("DELETE FROM site_releases").run();
  await testEnv.DB.prepare("DELETE FROM site_pointer_log").run();
  if (testEnv.HOSTS) await testEnv.HOSTS.delete(`site:${TENANT}:active`);
});

describe("GET /api/site/template", () => {
  it("从没发布过 ⇒ 种子，sha 是内容算出来的", async () => {
    const res = await call("/api/site/template", await token());
    expect(res.status).toBe(200);
    const body = (await res.json()) as { source: string; sha: string; files: { path: string }[] };
    expect(body.source).toBe("seed");
    expect(body.sha).toBe(await seedSha());
    expect(body.files.map((f) => f.path)).toContain("index.html");
    // Contract 14：这个字段已经不存在了
    expect(body).not.toHaveProperty("template_version");
  });

  it("发布过 ⇒ 回最新发布的那份源包（不是种子）", async () => {
    const sha = await publishOnce({
      "index.html": "<h1>租户自己的页面</h1>",
      "pricing.html": "<h1>价格</h1>",
    });

    const res = await call("/api/site/template", await token());
    const body = (await res.json()) as {
      source: string;
      sha: string;
      files: { path: string; content_b64: string }[];
    };
    expect(body.source).toBe("release");
    expect(body.sha).toBe(sha);
    const html = body.files.find((f) => f.path === "index.html")!;
    const text = new TextDecoder().decode(
      Uint8Array.from(atob(html.content_b64), (c) => c.charCodeAt(0)),
    );
    expect(text).toBe("<h1>租户自己的页面</h1>");
  });

  it("发布过但内容被清掉 ⇒ 404，**不退回种子**（否则等于把站换掉）", async () => {
    await publishOnce({ "index.html": "<h1>x</h1>" });
    const listed = await SITES.list({ prefix: "tpl/" });
    for (const o of listed.objects) await SITES.delete(o.key);

    const res = await call("/api/site/template", await token());
    expect(res.status).toBe(404);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("site_source_missing");
  });

  it("没有凭据 ⇒ 401（源包是租户内容，不是公开资料）", async () => {
    expect((await call("/api/site/template")).status).toBe(401);
  });

  it("只接受 GET", async () => {
    const res = await handle(
      new Request("https://crm.test/api/site/template", {
        method: "POST",
        headers: { authorization: `Bearer ${await token()}` },
      }),
      envOf(),
    );
    expect(res.status).toBe(405);
  });
});

describe("POST /api/site/deliveries（墓碑）", () => {
  it("410 + 指向 /publish：交付已经并入发布", async () => {
    const res = await handle(
      new Request("https://crm.test/api/site/deliveries", {
        method: "POST",
        headers: { authorization: `Bearer ${await token()}`, "content-type": "application/json" },
        body: "{}",
      }),
      envOf(),
    );
    expect(res.status).toBe(410);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("site_deliveries_gone");
  });
});
