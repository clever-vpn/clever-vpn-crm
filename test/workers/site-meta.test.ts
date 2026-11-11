/**
 * `GET /api/site/meta` 的**路由**行为（不是纯函数的部分）。
 *
 * 纯函数那部分（字段清单、引擎哈希、保留路径）在 `test/site-meta.test.ts`；
 * 这里只锁三件只有真跑 Worker 才知道的事：
 *
 *   1. 它**不需要鉴权**、也**不碰库** —— 平台能力的广告，不含租户数据；
 *   2. 只接受 GET；
 *   3. 响应形状就是契约里那三个字段（studio 按这个形状写代码）。
 */
import { exports as rawExports } from "cloudflare:workers";
import { describe, expect, it } from "vitest";

const BASE = "https://t-beta.clever-panel.win";

const worker = rawExports as unknown as {
  default: { fetch(request: Request): Promise<Response> };
};

const call = (path: string, init: RequestInit = {}) =>
  worker.default.fetch(new Request(`${BASE}${path}`, init));

describe("GET /api/site/meta", () => {
  it("匿名可读（studio 拿它注入规则、生成设置面板）", async () => {
    const res = await call("/api/site/meta");
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      contract: number;
      engine: string;
      sdk_version: string;
      capabilities: { path: string; kind: string; label: string }[];
    };
    expect(Object.keys(body).sort()).toEqual([
      "capabilities",
      "contract",
      "engine",
      "sdk_version",
    ]);
    expect(body.engine).toMatch(/^sha256:[0-9a-f]{16}$/);
    // 预览与线上对账用：它必须是个真版本号，不是占位
    expect(body.sdk_version).toMatch(/^\d+\.\d+\.\d+$/);
    expect(body.capabilities.length).toBeGreaterThan(0);
    expect(body.capabilities.some((c) => c.path === "site.name")).toBe(true);
  });

  it("只接受 GET", async () => {
    const res = await call("/api/site/meta", { method: "POST" });
    expect(res.status).toBe(405);
  });
});
