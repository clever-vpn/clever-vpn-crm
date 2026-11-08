/**
 * 平台 SDK（`/_crm/sdk.js`）的三条纪律，用代码钉住：
 *
 *   1. **语法必须合法** —— 它是拼在 TypeScript 模板字符串里的 JS，一个反引号就能
 *      把它截断，而 TypeScript 只会报"这里有语法错误"，看不出根因。
 *   2. **13 个方法一个不少** —— 契约 §4.3 是租户模板的唯一依赖面。
 *   3. **不暴露凭证、不 patch `fetch`** —— 这两条是安全承诺，退回去就等于没了。
 */
import vm from "node:vm";

import { describe, expect, it } from "vitest";

import { RETURN_HTML, SDK_JS, SDK_VERSION } from "../workers/site/src/sdk";

/** 契约 §4.3 的方法表；增删都要先改 `docs/contracts/site-crm.md` */
const METHODS = [
  "version",
  "escape",
  "plans",
  "sendCode",
  "verify",
  "logout",
  "me",
  "orders",
  "checkout",
  "payStatus",
  "redeem",
  "on",
  "error",
] as const;

/** 最小浏览器环境：SDK 只用这几个全局 */
function load(over?: { token?: string }) {
  const store = new Map<string, string>();
  if (over?.token) store.set("crm_token", over.token);
  const win: Record<string, unknown> = {
    CRM_API_BASE: "https://crm.test",
    console: { warn: () => {}, error: () => {} },
    localStorage: {
      getItem: (k: string) => store.get(k) ?? null,
      setItem: (k: string, v: string) => void store.set(k, v),
      removeItem: (k: string) => void store.delete(k),
    },
    fetch: () => Promise.reject(new Error("测试里不该真的发请求")),
  };
  win.window = win;
  vm.runInNewContext(SDK_JS, win);
  return { win, store, sdk: win.SiteCrm as Record<string, unknown> };
}

describe("SiteCrm SDK", () => {
  it("语法合法（能构造 Script，不依赖浏览器）", () => {
    expect(() => new vm.Script(SDK_JS)).not.toThrow();
  });

  it("挂到 window.SiteCrm，13 个名字齐全（version 是字符串，其余是函数）", () => {
    const { sdk } = load();
    expect(sdk).toBeTruthy();
    for (const m of METHODS) {
      const want = m === "version" ? "string" : "function";
      expect(typeof sdk[m], `缺成员 ${m}`).toBe(want);
    }
  });

  it("版本号与常量一致", () => {
    const { sdk } = load();
    expect(sdk.version).toBe(SDK_VERSION);
  });

  it("没有登录态时 me() 直接返回 null，不打请求", async () => {
    const { sdk } = load();
    await expect((sdk.me as () => Promise<unknown>)()).resolves.toBeNull();
  });

  it("escape() 挡住注入", () => {
    const { sdk } = load();
    const esc = sdk.escape as (s: string) => string;
    expect(esc('<script>alert("x")</script>')).toBe(
      "&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt;",
    );
    expect(esc(undefined as unknown as string)).toBe("");
  });

  it("不暴露 token，也不 patch window.fetch", () => {
    expect(SDK_JS).not.toMatch(/SiteCrm\.(token|getToken|setToken)/);
    expect(SDK_JS).not.toMatch(/window\.fetch\s*=/);
    const { sdk } = load({ token: "t0ken" });
    expect(Object.keys(sdk)).not.toContain("token");
  });
});

describe("支付回跳页", () => {
  it("不依赖登录态，也没有模板指令", () => {
    expect(RETURN_HTML).toContain("支付已提交");
    expect(RETURN_HTML).not.toMatch(/\{\{/);
    // 单号从 query 里读，且必须转义后再插入
    expect(RETURN_HTML).toContain("order=");
    expect(RETURN_HTML).toMatch(/escape/);
  });
});
