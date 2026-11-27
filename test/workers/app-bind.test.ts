/**
 * `POST /api/studio/app-bind` —— studio 绑定成功后把成果仓写回面板。
 *
 * 契约：`services/crm/app-studio.md` §3.2。这里钉住四条：
 *
 *   1. **只有 `aacc_…` 能进**（`sacc_` / 没带 / 别的租户的都不行）；
 *   2. **只写两个键**（`app.repo` / `app.bound_at`），`installation_id` 只作展示；
 *   3. **repo 必须先过形状**（`owner/name`），否则 400，不落库；
 *   4. 重复绑定是覆盖（绑定回答"是哪一间"，不是"追加"）。
 */

import { exports as rawExports } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";

import { issueAppAccess } from "../../src/app/access";
import { issueSiteAccess } from "../../src/site/access";
import { env } from "./apply-migrations";

const BASE = "https://crm.test/api/studio/app-bind";
const TENANT = "42";
const SECRET = "app-bind-test-secret-0123456789abcdef";

const worker = rawExports as unknown as {
  default: { fetch(request: Request): Promise<Response> };
};

const testEnv = env as unknown as Record<string, unknown>;
beforeEach(() => {
  testEnv.APP_SECRET = SECRET;
  testEnv.CRM_TENANT_ID = TENANT;
});

const envOf = () => env as never;

async function bind(
  body: unknown,
  token?: string | null,
  tenant = TENANT,
): Promise<Response> {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (token !== null) {
    headers.authorization = `Bearer ${token ?? (await issueAppAccess(envOf(), tenant))}`;
  }
  return worker.default.fetch(
    new Request(BASE, { method: "POST", headers, body: JSON.stringify(body) }),
  );
}

const setting = async (key: string): Promise<string | null> =>
  (await env.DB.prepare(`SELECT value FROM settings WHERE key = ?`).bind(key).first<{ value: string }>())
    ?.value ?? null;

const repos = async (): Promise<{ repo: string; bound_at: string }[]> => {
  const raw = await setting("app.repos");
  return raw ? (JSON.parse(raw) as { repo: string; bound_at: string }[]) : [];
};

describe("鉴权", () => {
  it("没带凭据 ⇒ 401 app_access_invalid", async () => {
    const res = await bind({ repo: "acme/my-vpn" }, null);
    expect(res.status).toBe(401);
    expect(((await res.json()) as { error: string }).error).toBe("app_access_invalid");
  });

  it("site 的 sacc_ 不能用来写 app 绑定（标签隔离）", async () => {
    const site = await issueSiteAccess(envOf(), TENANT);
    const res = await bind({ repo: "acme/my-vpn" }, site!);
    expect(res.status).toBe(401);
  });

  it("别的租户的 aacc_ ⇒ 401（租户必须与本次请求一致）", async () => {
    const other = await issueAppAccess(envOf(), "43");
    const res = await bind({ repo: "acme/my-vpn" }, other!);
    expect(res.status).toBe(401);
  });
});

describe("写入", () => {
  it("合法请求 ⇒ 加进列表（installation_id 只作展示）", async () => {
    const before = Date.now();
    const res = await bind({ repo: "acme/my-vpn", installation_id: 123456 });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; repo: string; bound_at: string };
    expect(body.ok).toBe(true);
    expect(body.repo).toBe("acme/my-vpn");

    const list = await repos();
    expect(list.map((r) => r.repo)).toEqual(["acme/my-vpn"]);
    const boundAt = Date.parse(list[0]!.bound_at);
    expect(boundAt).toBeGreaterThanOrEqual(before - 1000);
    expect(body.bound_at).toBe(new Date(boundAt).toISOString());
    // installation id 只作展示（按仓库分开存）
    expect(await setting("app.installation.acme/my-vpn")).toBe("123456");
  });

  it("多间仓库 ⇒ 追加；重复绑定同一间 ⇒ 更新，不重复", async () => {
    await bind({ repo: "acme/my-vpn" });
    await bind({ repo: "acme/other-vpn" });
    expect((await repos()).map((r) => r.repo).sort()).toEqual(["acme/my-vpn", "acme/other-vpn"]);

    await bind({ repo: "acme/my-vpn" });
    const list = await repos();
    expect(list).toHaveLength(2);
    expect(list.filter((r) => r.repo === "acme/my-vpn")).toHaveLength(1);
  });

  it("repo 形状不对 ⇒ 400 且不落库", async () => {
    await env.DB.prepare(`DELETE FROM settings WHERE key LIKE 'app.%'`).run();
    for (const repo of ["", "not a repo", "owner/", "/name", "a/b/c", "owner/na me"]) {
      const res = await bind({ repo });
      expect(res.status).toBe(400);
      expect(((await res.json()) as { error: string }).error).toBe("invalid_repo");
    }
    expect(await setting("app.repos")).toBeNull();
  });

  it("GET ⇒ 405（只接受 POST）", async () => {
    const token = (await issueAppAccess(envOf(), TENANT))!;
    const res = await worker.default.fetch(
      new Request(BASE, { method: "GET", headers: { authorization: `Bearer ${token}` } }),
    );
    expect(res.status).toBe(405);
  });
});
