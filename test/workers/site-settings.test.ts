/**
 * `GET /api/site/settings` 的路由行为：**凭据不对就什么都不给**。
 *
 * 纯逻辑（签发/验证）在 `test/site-access.test.ts`；这里锁的是"路由有没有真的接上
 * 那道校验"—— 一处漏写就是一处越权，而漏写是迟早的事。
 */
import { exports as rawExports } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";

import { env as testEnv } from "./apply-migrations";
import { issueSiteAccess } from "../../src/site/access";

const BASE = "https://t-beta.clever-panel.win";
/**
 * 单租户模式下 `scoped.tenantId` 就是 `CRM_TENANT_ID`（`wrangler.jsonc` 里是 `0`）。
 * 写死它而不是猜 —— 猜错的表现是"200 变成 401"，很容易被误读成签名出了问题。
 */
const TENANT = "0";

const worker = rawExports as unknown as {
  default: { fetch(request: Request): Promise<Response> };
};

function setSecret(value: string): void {
  (testEnv as unknown as Record<string, unknown>).APP_SECRET = value;
}

const call = (init: RequestInit = {}) =>
  worker.default.fetch(new Request(`${BASE}/api/site/settings`, init));

beforeEach(() => setSecret("master-key-for-tests"));

describe("GET /api/site/settings", () => {
  it("没带凭据 ⇒ 401（不是 404、不是空对象）", async () => {
    const res = await call();
    expect(res.status).toBe(401);
    await expect(res.json()).resolves.toEqual({ error: "site_access_invalid" });
  });

  it("凭据是别的租户的 ⇒ 401", async () => {
    const token = (await issueSiteAccess(testEnv as never, "999"))!;
    const res = await call({ headers: { authorization: `Bearer ${token}` } });
    expect(res.status).toBe(401);
  });

  it("本租户的凭据 ⇒ 返回 rev / values / collections / scope", async () => {
    const token = (await issueSiteAccess(testEnv as never, TENANT))!;
    const res = await call({ headers: { authorization: `Bearer ${token}` } });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      rev: number;
      values: Record<string, unknown>;
      collections: unknown;
      scope: Record<string, unknown>;
    };
    expect(body.rev).toBeGreaterThanOrEqual(0);
    expect(body.values).toBeTypeOf("object");
    // `scope` 与发布时同一套 buildScope —— 预览与线上不会因为"两处拼数据"而漂移
    expect(body.scope).toBeTypeOf("object");
    // scope 是**嵌套**的（渲染器的 `{{site.name}}` 就是逐层取值）
    expect((body.scope as { site?: { name?: string } }).site?.name).toBeTruthy();
  });

  it("只接受 GET", async () => {
    const token = (await issueSiteAccess(testEnv as never, TENANT))!;
    const res = await call({ method: "POST", headers: { authorization: `Bearer ${token}` } });
    expect(res.status).toBe(405);
  });
});
