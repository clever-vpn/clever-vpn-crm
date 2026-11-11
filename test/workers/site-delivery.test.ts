/**
 * 交付 → 发布：**把一条链在同一个 Worker 里跑完**。
 *
 * 这里测的不是"函数能跑"，而是契约 §5 的六道门真的在门上：
 *
 *   1. 引擎 / 契约不一致 ⇒ 422（不做"尽力渲染"）
 *   2. 逐文件 sha256 与内容不符 ⇒ 400（整包拒，不留半份）
 *   3. 用了当前数据里没有的字段（H1）⇒ 422，并列出路径
 *   4. 你签收的 artifact sha 与现在渲染出来的不一致 ⇒ 422（预览≠线上就别交付）
 *   5. 同内容重复交付 ⇒ 幂等，返回同一版本
 *   6. 发布只读**交付来的那一版**（`tpl/<sha>`），产物落到 `sites/<tenant>/…` 并切指针
 */
import { exports as rawExports } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";

import { env as testEnv } from "./apply-migrations";
import { ENGINE_ID } from "../../src/site/engine.generated";
import { SITE_CONTRACT } from "../../src/site/meta";
import { artifactShaOf } from "../../src/site/deliver";
import { issueSiteAccess } from "../../src/site/access";
import { buildScope, readSiteSettings } from "../../src/site/settings";
import { activeKey, publicPrefix } from "../../src/site/publish";

const BASE = "https://crm.test";
const TENANT = "0";

const SITES = (testEnv as unknown as { SITES: R2Bucket }).SITES!;
const HOSTS = (testEnv as unknown as { HOSTS: KVNamespace }).HOSTS!;

const worker = rawExports as unknown as {
  default: { fetch(request: Request): Promise<Response> };
};

/** workerd 的 env 是同一个对象：就地写密钥，签名方与验签方才是同一把钥匙 */
function setSecret(value = "delivery-test-master-key"): void {
  (testEnv as unknown as Record<string, unknown>).APP_SECRET = value;
}

const token = async (tenant = TENANT): Promise<string> => {
  setSecret();
  return (await issueSiteAccess(testEnv as never, tenant))!;
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

interface Body {
  manifest: Record<string, unknown>;
  files: { path: string; content_b64: string }[];
}

/** 一份"合法"的交付体：页面只说 `{{site.name}}`，没有运行时字段 */
async function deliveryBody(
  patch: Record<string, unknown> = {},
  files: Record<string, string> = { "index.html": "<h1>{{site.name}}</h1>" },
): Promise<Body> {
  const settings = await readSiteSettings(testEnv as never);
  const scope = buildScope(settings, "我的站点") as Record<string, unknown>;
  const artifact = await artifactShaOf(
    Object.entries(files).map(([path, text]) => ({ path, text })),
    scope,
  );
  return {
    manifest: {
      package: 1,
      engine: ENGINE_ID,
      contract: SITE_CONTRACT,
      studio_rev: 1,
      base_package: null,
      preview: { artifact_sha256: artifact.sha },
      signoff: { by: "ops@example.com", at: new Date().toISOString() },
      files: await Promise.all(
        Object.entries(files).map(async ([path, text]) => ({
          path,
          sha256: await hex(text),
          bytes: new TextEncoder().encode(text).byteLength,
        })),
      ),
      ...patch,
    },
    files: Object.entries(files).map(([path, text]) => ({ path, content_b64: b64(text) })),
  };
}

const call = async (path: string, init: RequestInit & { auth?: boolean } = {}) => {
  const headers = new Headers(init.headers);
  if (init.auth !== false) headers.set("authorization", `Bearer ${await token()}`);
  if (init.body) headers.set("content-type", "application/json");
  return worker.default.fetch(new Request(`${BASE}${path}`, { ...init, headers }));
};

const post = async (path: string, body: unknown, auth = true) =>
  call(path, { method: "POST", body: JSON.stringify(body), auth });

beforeEach(async () => {
  for (const prefix of ["tpl/", `sites/${TENANT}/`]) {
    const listed = await SITES.list({ prefix });
    for (const o of listed.objects) await SITES.delete(o.key);
  }
  await HOSTS.delete(activeKey(TENANT));
  await testEnv.DB.prepare("DELETE FROM site_templates").run();
  await testEnv.DB.prepare("DELETE FROM site_versions").run();
  await testEnv.DB.prepare("UPDATE site_settings SET template_version = '' WHERE id = 1").run();
});

describe("POST /api/site/deliveries", () => {
  it("合法交付 ⇒ v1，内容寻址进 R2，指针指到它", async () => {
    const sent = await deliveryBody();
    const res = await post("/api/site/deliveries", sent);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { template_version: string; sha: string; engine: string; idempotent: boolean };
    expect(body.template_version).toBe("v1");
    expect(body.engine).toBe(ENGINE_ID);
    expect(body.idempotent).toBe(false);
    expect(body.sha).toMatch(/^sha256:[0-9a-f]{64}$/);

    const object = await SITES.get(`tpl/${body.sha.slice(7)}/files/index.html`);
    expect(object).not.toBeNull();
    expect(await object!.text()).toBe("<h1>{{site.name}}</h1>");

    const row = await testEnv.DB.prepare("SELECT template_version FROM site_settings WHERE id = 1").first<{
      template_version: string;
    }>();
    expect(row?.template_version).toBe("v1");
  });

  it("同内容再交付 ⇒ 幂等，还是 v1", async () => {
    const first = (await (await post("/api/site/deliveries", await deliveryBody())).json()) as {
      template_version: string;
    };
    const second = await post("/api/site/deliveries", await deliveryBody());
    expect(second.status).toBe(200);
    const body = (await second.json()) as { template_version: string; idempotent: boolean };
    expect(body.idempotent).toBe(true);
    expect(body.template_version).toBe(first.template_version);
  });

  it("引擎不一致 ⇒ 422 site_engine_unsupported", async () => {
    const res = await post("/api/site/deliveries", await deliveryBody({ engine: "sha256:deadbeef" }));
    expect(res.status).toBe(422);
    expect(((await res.json()) as { error: string }).error).toBe("site_engine_unsupported");
  });

  it("契约不一致 ⇒ 422 site_contract_unsupported", async () => {
    const res = await post("/api/site/deliveries", await deliveryBody({ contract: 99 }));
    expect(res.status).toBe(422);
    expect(((await res.json()) as { error: string }).error).toBe("site_contract_unsupported");
  });

  it("没有签收 ⇒ 422 site_signoff_missing", async () => {
    const body = await deliveryBody({ signoff: { by: "", at: "" } });
    const res = await post("/api/site/deliveries", body);
    expect(res.status).toBe(422);
    expect(((await res.json()) as { error: string }).error).toBe("site_signoff_missing");
  });

  it("manifest 里的 sha256 与内容不符 ⇒ 400 site_hash_mismatch", async () => {
    const body = await deliveryBody();
    body.manifest.files = [{ path: "index.html", sha256: "0".repeat(64), bytes: 10 }];
    const res = await post("/api/site/deliveries", body);
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toBe("site_hash_mismatch");
  });

  it("用了数据里没有的字段 ⇒ 422 site_gate_hard_failed，并说清是哪个路径", async () => {
    const body = await deliveryBody({}, { "index.html": "<h1>{{site.nonexistent_field}}</h1>" });
    const res = await post("/api/site/deliveries", body);
    expect(res.status).toBe(422);
    const parsed = (await res.json()) as { error: string; issues?: string[] };
    expect(parsed.error).toBe("site_gate_hard_failed");
    expect(parsed.issues?.join(" ")).toContain("site.nonexistent_field");
  });

  it("签收的 artifact sha 与现在渲染的不一致 ⇒ 422 site_preview_mismatch", async () => {
    const body = await deliveryBody();
    body.manifest.preview = { artifact_sha256: `sha256:${"a".repeat(64)}` };
    const res = await post("/api/site/deliveries", body);
    expect(res.status).toBe(422);
    expect(((await res.json()) as { error: string }).error).toBe("site_preview_mismatch");
  });

  it("模板不许占 /_crm/* ⇒ 400 site_path_rejected", async () => {
    const body = await deliveryBody({}, { "index.html": "<h1>x</h1>", "_crm/sdk.js": "// hack" });
    const res = await post("/api/site/deliveries", body);
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toBe("site_path_rejected");
  });

  it("没有 sacc_… ⇒ 401", async () => {
    const res = await post("/api/site/deliveries", await deliveryBody(), false);
    expect(res.status).toBe(401);
  });
});

describe("POST /api/site/publish", () => {
  it("交付之后发布 ⇒ 产物落地、指针切到 v1", async () => {
    const delivered = (await (await post("/api/site/deliveries", await deliveryBody())).json()) as {
      template_version: string;
    };
    const res = await post("/api/site/publish", { template_version: delivered.template_version });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { version_id: number };
    expect(body.version_id).toBe(1);

    const pointed = (await HOSTS.get(activeKey(TENANT), "json")) as { n: number } | null;
    expect(pointed?.n).toBe(1);

    const html = await SITES.get(`${publicPrefix(TENANT, 1)}index.html`);
    expect(html).not.toBeNull();
    // 渲染发生在发布时：`{{site.name}}` 已经被真实数据替换
    expect(await html!.text()).not.toContain("{{");
  });

  it("没有交付过就发布 ⇒ 404 site_template_missing", async () => {
    const res = await post("/api/site/publish", {});
    expect(res.status).toBe(404);
    expect(((await res.json()) as { error: string }).error).toBe("site_template_missing");
  });
});

describe("GET /api/site/sample-data", () => {
  it("明确的样例：sample=true，两个套餐、两条订单", async () => {
    const res = await call("/api/site/sample-data");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { sample: boolean; plans: unknown[]; orders: unknown[] };
    expect(body.sample).toBe(true);
    expect(body.plans.length).toBe(2);
    expect(body.orders.length).toBe(2);
  });

  it("没有 sacc_… ⇒ 401（样例也是 tenant 域下的东西）", async () => {
    const res = await call("/api/site/sample-data", { auth: false });
    expect(res.status).toBe(401);
  });
});
