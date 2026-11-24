import { describe, expect, it } from "vitest";

import {
  assertAllowedDocUrl,
  combineDocPages,
  extractDocLinks,
  scoreDocLink,
  type DocPage,
} from "../../src/payments/doc-fetch";

describe("assertAllowedDocUrl", () => {
  it("只接受公开 http/https，拒绝本地/私网/非 80/443/userinfo", () => {
    expect(assertAllowedDocUrl("https://www.yimapay.com/docs/api/index.html").hostname).toBe("www.yimapay.com");
    for (const bad of [
      "http://127.0.0.1/docs",
      "http://localhost/docs",
      "http://10.0.0.1/docs",
      "http://172.16.0.1/docs",
      "http://192.168.1.1/docs",
      "http://169.254.169.254/latest",
      "http://[::1]/docs",
      "file:///etc/passwd",
      "https://user:pass@example.com/docs",
      "https://example.com:8080/docs",
    ]) {
      expect(() => assertAllowedDocUrl(bad), bad).toThrow();
    }
  });
});

describe("scoreDocLink / extractDocLinks", () => {
  it("下单/查单/通知/签名高分，退款/登录低分", () => {
    expect(scoreDocLink("创建订单", "https://x/docs/api.html?chapter=1")).toBeGreaterThan(0);
    expect(scoreDocLink("查询订单", "https://x/docs/api.html?chapter=2")).toBeGreaterThan(0);
    expect(scoreDocLink("支付通知", "https://x/docs/api.html?chapter=4")).toBeGreaterThan(0);
    expect(scoreDocLink("签名规则", "https://x/docs/api/sign.html")).toBeGreaterThan(0);
    expect(scoreDocLink("申请退款", "https://x/docs/api.html?chapter=5")).toBeLessThan(0);
    expect(scoreDocLink("登录", "https://x/login")).toBeLessThan(0);
  });

  it("只留同源、保留 query、去 hash、跳过 javascript/跨源/重复", () => {
    const base = "https://www.yimapay.com/docs/api/index.html";
    const html = `
      <a href="/docs/api/sign.html">签名规则</a>
      <a href="/docs/api.html?chapter=1#top">创建订单</a>
      <a href="javascript:;">文档说明</a>
      <a href="https://www.jsons.cn/urlencode/">工具</a>
      <a href="/docs/api/sign.html">签名规则（重复）</a>
      <a href="#section">本页锚点</a>
    `;
    const links = extractDocLinks(html, base);
    expect(links).toHaveLength(2);
    expect(links[0]!.url).toBe("https://www.yimapay.com/docs/api/sign.html");
    expect(links[1]!.url).toBe("https://www.yimapay.com/docs/api.html?chapter=1");
    expect(links[1]!.text).toBe("创建订单");
    expect(links[1]!.score).toBeGreaterThan(0);
  });
});

describe("combineDocPages", () => {
  it("按页面分隔合并；超过 60KB 截断并标记", () => {
    const pages: DocPage[] = [
      { url: "https://x/a", title: "A", text: "甲".repeat(20), chars: 20, selected: true, reason: "entry" },
      { url: "https://x/b", title: "B", text: "乙".repeat(20), chars: 20, selected: true, reason: "keyword" },
    ];
    const normal = combineDocPages(pages);
    expect(normal.truncated).toBe(false);
    expect(normal.document).toContain("===== 页面 1/2: A — https://x/a =====");
    expect(normal.document).toContain("===== 页面 2/2: B — https://x/b =====");

    const huge = combineDocPages([
      { url: "https://x/a", title: "A", text: "甲".repeat(60 * 1024), chars: 60 * 1024, selected: true, reason: "entry" },
    ]);
    expect(huge.truncated).toBe(true);
    expect(new TextEncoder().encode(huge.document).length).toBeLessThanOrEqual(60 * 1024);
  });
});
