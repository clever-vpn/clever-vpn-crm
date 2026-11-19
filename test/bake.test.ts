import { describe, expect, it } from 'vitest';


describe("Zaraz 加载器（渲染时注入）", () => {
  it("开着才插，且只插一次", async () => {
    const { injectZaraz } = await import("../src/site/bake");
    const html = "<!doctype html><html><head><title>t</title></head><body>x</body></html>";
    const on = injectZaraz(html, true);
    expect(on).toContain('<script src="/cdn-cgi/zaraz/i.js" referrerpolicy="origin"></script>');
    expect(on.indexOf("zaraz")).toBeLessThan(on.indexOf("</head>"));
    // 幂等：已经有一行就不再插
    expect(injectZaraz(on, true)).toBe(on);
    // 关着就一个字都不动
    expect(injectZaraz(html, false)).toBe(html);
  });

  it("没有 </head> 也不炸（兜底插在 <head> 后）", async () => {
    const { injectZaraz } = await import("../src/site/bake");
    expect(injectZaraz("<html><head><title>t</title>", true)).toContain("zaraz");
  });

  it("缺省是开：没设过（或设成 1）都插，只有显式 0 才不插", async () => {
    const { injectZaraz } = await import("../src/site/bake");
    const on = (v: string | undefined): boolean => (v ?? "1") !== "0";
    // 这条规则在 bakeSite 里，这里钉住语义本身：undefined/1 → 开，0 → 关
    expect(on(undefined)).toBe(true);
    expect(on("1")).toBe(true);
    expect(on("0")).toBe(false);
    expect(injectZaraz("<html><head></head><body></body></html>", on("0"))).not.toContain("zaraz");
  });

  it("internal 设置不算未使用（它本来就不该出现在页面里）", async () => {
    const { unusedOf } = await import("../src/site/bake");
    const files = [{ path: "index.html", body: "<p>{{site.name}}</p>" }];
    const out = unusedOf(files, { "site.name": "x", "site.integrations.zaraz": "1" });
    expect(out).toEqual([]);
  });
});
