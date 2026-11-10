/**
 * `GET /api/site/template` —— 三态与"对齐只看 sha"。
 *
 * 契约 §7.3：
 *   · 租户有模板 ⇒ 用租户的；没有 ⇒ 用公共的（`g/templates/basic/v1/`）；
 *   · 对齐只看 `sha`，不看版本号（同一版本可以被不同数据发布多次）；
 *   · 拉下来要能逐文件校验 sha256 —— 校验失败不要拿来路不明的模板开始编辑。
 *
 * 这里在**真 Worker** 里跑（要 R2 + D1），所以放在 `test/workers/`。
 */
import { exports as rawExports } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";

import { env as testEnv } from "./apply-migrations";
import { issueSiteAccess } from "../../src/site/access";
import { ENGINE_ID } from "../../src/site/engine.generated";
import { SITE_CONTRACT } from "../../src/site/meta";
import { PUBLIC_TEMPLATE_VERSION } from "../../src/site/template-source";

const BASE = "https://t-beta.clever-panel.win";
const TENANT = "0";

const SITES = (testEnv as unknown as { SITES: R2Bucket }).SITES!;

const worker = rawExports as unknown as {
  default: { fetch(request: Request): Promise<Response> };
};

interface TemplateBody {
  source: string;
  template_version: string;
  sha: string;
  engine: string;
  contract: number;
  files: { path: string; sha256: string; bytes: number; content_b64: string }[];
}

async function authToken(): Promise<string> {
  (testEnv as unknown as Record<string, unknown>).APP_SECRET = "master-key-for-tests";
  return (await issueSiteAccess(testEnv as never, TENANT))!;
}

const call = async (init: RequestInit = {}) => {
  const token = await authToken();
  return worker.default.fetch(
    new Request(`${BASE}/api/site/template`, {
      ...init,
      headers: { authorization: `Bearer ${token}`, ...(init.headers ?? {}) },
    }),
  );
};

async function seedPublic(files: Record<string, string>): Promise<void> {
  for (const [rel, body] of Object.entries(files)) {
    await SITES.put(`g/templates/basic/v1/${rel}`, body);
  }
}

describe("GET /api/site/template", () => {
  beforeEach(async () => {
    // 每个用例从干净状态开始：清公共模板、清租户模板记账
    const listed = await SITES.list({ prefix: "g/templates/basic/" });
    for (const o of listed.objects) await SITES.delete(o.key);
    await testEnv.DB.prepare("DELETE FROM site_templates").run();
    await testEnv.DB.prepare("UPDATE site_settings SET template_version = '' WHERE id = 1").run();
  });

  it("没有租户模板 ⇒ 回公共模板，且 sha 是**内容**算出来的", async () => {
    await seedPublic({ "index.html": "<h1>公共</h1>", "assets/site.css": "h1{}" });
    const res = await call();
    expect(res.status).toBe(200);
    const body = (await res.json()) as TemplateBody;

    expect(body.source).toBe("public");
    expect(body.template_version).toBe(PUBLIC_TEMPLATE_VERSION);
    expect(body.sha).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(body.engine).toBe(ENGINE_ID);
    expect(body.contract).toBe(SITE_CONTRACT);
    expect(body.files.map((f) => f.path)).toEqual(["assets/site.css", "index.html"]);

    // 文件内容可还原（base64），并且逐文件 sha 与内容一致 —— 客户端就是靠这个校验
    // base64 是**字节**，不是字符串：客户端必须过 TextDecoder 才是文本
    const textOf = (b64: string) =>
      new TextDecoder().decode(Uint8Array.from(atob(b64), (c) => c.charCodeAt(0)));
    const html = body.files.find((f) => f.path === "index.html")!;
    expect(textOf(html.content_b64)).toBe("<h1>公共</h1>");
    const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode("<h1>公共</h1>"));
    const hex = [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
    expect(html.sha256).toBe(hex);
  });

  it("同一份内容 ⇒ 同一个 sha（确定性，不看时间/顺序）", async () => {
    await seedPublic({ "index.html": "<h1>a</h1>", "assets/site.css": "b" });
    const first = (await (await call()).json()) as TemplateBody;
    const again = (await (await call()).json()) as TemplateBody;
    expect(again.sha).toBe(first.sha);
  });

  it("内容变了 ⇒ sha 跟着变（版本号不变，因为对齐只看 sha）", async () => {
    await seedPublic({ "index.html": "<h1>a</h1>" });
    const before = (await (await call()).json()) as TemplateBody;
    await seedPublic({ "index.html": "<h1>b</h1>" });
    const after = (await (await call()).json()) as TemplateBody;
    expect(after.template_version).toBe(before.template_version);
    expect(after.sha).not.toBe(before.sha);
  });

  it("两边都没有 ⇒ 404 site_template_missing（不是空包）", async () => {
    const res = await call();
    expect(res.status).toBe(404);
    await expect(res.json()).resolves.toEqual({ error: "site_template_missing" });
  });

  it("没凭据 ⇒ 401（模板是租户内容，不是公开资料）", async () => {
    await seedPublic({ "index.html": "<h1>a</h1>" });
    const res = await worker.default.fetch(new Request(`${BASE}/api/site/template`));
    expect(res.status).toBe(401);
  });

  it("只接受 GET", async () => {
    await seedPublic({ "index.html": "<h1>a</h1>" });
    const res = await call({ method: "POST" });
    expect(res.status).toBe(405);
  });
});
