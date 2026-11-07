/**
 * 跨源与 CSRF 的边界（契约 §3）
 *
 * 这里断言的是**浏览器规矩**，不是"信任名单"：
 *
 *   1. 任何 origin 都能读 `/api/app/v1`（`ACAO: *`）—— 站点绑自定义域名不用改配置；
 *   2. 带 `Authorization` 的跨源请求能过预检（否则站点连请求都发不出去）；
 *   3. **永远不下发** `Access-Control-Allow-Credentials`（`*` 与它互斥，
 *      跨源请求拿不到 Cookie）；
 *   4. 跨源写请求**不再**被 403 —— 会话 Cookie 是 host-only + SameSite=Lax，
 *      跨站带不上；老的白名单校验防的是不存在的东西，早已删除。
 *
 * 第 4 条是最容易被"好心"加回来的：加回白名单的唯一效果就是**站点读不到数据**。
 */
import { exports as rawExports } from "cloudflare:workers";
import { describe, expect, it } from "vitest";

const BASE = "https://t-beta.clever-panel.win";
const SITE = "https://t-beta.clever-link.win";

const worker = rawExports as unknown as {
  default: { fetch(request: Request): Promise<Response> };
};

const call = (path: string, init: RequestInit = {}) =>
  worker.default.fetch(new Request(`${BASE}${path}`, init));

describe("CORS：任何 origin 都能读，且不带 credentials", () => {
  it("预检 204，回 * 与 Allow-Headers", async () => {
    const res = await call("/api/app/v1/plans", {
      method: "OPTIONS",
      headers: {
        Origin: SITE,
        "Access-Control-Request-Method": "GET",
        "Access-Control-Request-Headers": "authorization",
      },
    });
    expect(res.status).toBe(204);
    expect(res.headers.get("access-control-allow-origin")).toBe("*");
    expect(res.headers.get("access-control-allow-headers")).toContain(
      "authorization",
    );
    // 红线：一旦带上它，浏览器就会把用户的 Cookie 交给任意站点
    expect(res.headers.get("access-control-allow-credentials")).toBeNull();
  });

  it("陌生 origin 一样（没有白名单这回事）", async () => {
    const res = await call("/api/app/v1/plans", {
      method: "OPTIONS",
      headers: {
        Origin: "https://someone-elses-domain.example",
        "Access-Control-Request-Method": "POST",
      },
    });
    expect(res.status).toBe(204);
    expect(res.headers.get("access-control-allow-origin")).toBe("*");
  });

  it("真实 GET 也带 CORS 头（站点要能读到价格）", async () => {
    const res = await call("/api/app/v1/plans", { headers: { Origin: SITE } });
    expect(res.headers.get("access-control-allow-origin")).toBe("*");
    expect(res.headers.get("access-control-allow-credentials")).toBeNull();
    expect(res.status).toBe(200);
  });
});

describe("CSRF：跨源写请求不再被拦", () => {
  it("跨源 POST + 伪造 Cookie ⇒ 不是 403（无效会话就是 401/400）", async () => {
    const res = await call("/api/app/v1/quote", {
      method: "POST",
      headers: {
        Origin: SITE,
        Cookie: "crm_session=forged-token",
        "content-type": "application/json",
      },
      body: JSON.stringify({ plan_id: 1 }),
    });
    expect(res.status).not.toBe(403);
    // 没登录就该是 401 —— 拦人靠会话，不靠 Origin
    expect(res.status).toBe(401);
  });
});
