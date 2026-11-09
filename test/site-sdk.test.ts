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

import { RETURN_HTML, SDK_JS, SDK_VERSION } from "../src/site/sdk";

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
function load(over?: {
  token?: string;
  fetch?: (url: string, init?: unknown) => Promise<unknown>;
}) {
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
    fetch: over?.fetch ?? (() => Promise.reject(new Error("测试里不该真的发请求"))),
    // 下单要拼 return_url、并把支付页交给外部浏览器：这两个全局必须给
    location: { origin: "https://site.test", href: "https://site.test/pricing.html", assign: () => {} },
    open: () => ({}),
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

  it("请求地址带 /api/app/v1 前缀（少了它打到的是 404，浏览器报 CORS error）", async () => {
    const seen: string[] = [];
    const { sdk } = load({
      fetch: (url) => {
        seen.push(url);
        return Promise.resolve({
          ok: true,
          status: 200,
          text: () => Promise.resolve("[]"),
        });
      },
    });
    await (sdk.plans as () => Promise<unknown>)();
    expect(seen[0]).toBe("https://crm.test/api/app/v1/plans");
    // 末尾多余的斜杠不能拼出 `//api`
    expect(seen[0]).not.toContain("//api/app");
  });

  it("没有登录态时 me() 直接返回 null，不打请求", async () => {
    const { sdk } = load();
    await expect((sdk.me as () => Promise<unknown>)()).resolves.toBeNull();
  });

  it("没有登录态时 checkout() 说「请先登录」，不说「买不了」", async () => {
    // 这两句必须分开：一句是"去登录"，另一句是"确实没有可用的支付方式"。
    // 混在一起会把人带向错误结论（以为网关没配，其实是没登录）。
    const seen: string[] = [];
    const { sdk } = load({
      fetch: (url) => {
        seen.push(url);
        return Promise.resolve({ ok: true, status: 200, text: () => Promise.resolve("[]") });
      },
    });
    await expect(
      (sdk.checkout as (o: { planId: string }) => Promise<unknown>)({ planId: "p_1" }),
    ).rejects.toMatchObject({ code: "unauthorized" });
    // 连 /plans 都不该拉：未登录时没有"这个访客能用的支付方式"这回事
    expect(seen).toEqual([]);
  });

  it("套餐卡片带上支付方式（用户点之前就要知道能用什么付）", async () => {
    const { sdk } = load({
      fetch: () =>
        Promise.resolve({
          ok: true,
          status: 200,
          text: () =>
            Promise.resolve(
              JSON.stringify([
                {
                  plan_id: "p_1",
                  name: "月付",
                  kind: "period",
                  price_minor: 1500,
                  currency: "CNY",
                  action: "buy",
                  buyable: true,
                  payment_methods: [
                    { id: "alipay", label: "支付宝", icon_url: null },
                    { id: "wechat", label: "微信支付", icon_url: null },
                  ],
                },
              ]),
            ),
        }),
    });
    const plans = (await (sdk.plans as () => Promise<Record<string, unknown>[]>)()) as Record<
      string,
      unknown
    >[];
    expect(plans[0]!.methods).toEqual(["支付宝", "微信支付"]);
    // 选择器要用 id 回传 `payment_method`，所以两个都要给
    expect(plans[0]!.method_options).toEqual([
      { id: "alipay", label: "支付宝" },
      { id: "wechat", label: "微信支付" },
    ]);
  });

  it("用户选了微信，下单的 payment_method 就是 wechat（不是永远第一种）", async () => {
    const posts: Record<string, unknown>[] = [];
    const plan = {
      plan_id: "p_1",
      name: "月付",
      kind: "period",
      price_minor: 1500,
      currency: "CNY",
      action: "buy",
      buyable: true,
      payment_methods: [
        { id: "alipay", label: "支付宝", icon_url: null },
        { id: "wechat", label: "微信支付", icon_url: null },
      ],
    };
    const { sdk } = load({
      token: "t0ken",
      fetch: (url, init) => {
        if (url.endsWith("/plans")) {
          return Promise.resolve({ ok: true, status: 200, text: () => Promise.resolve(JSON.stringify([plan])) });
        }
        if (url.endsWith("/quote")) {
          return Promise.resolve({ ok: true, status: 200, text: () => Promise.resolve(JSON.stringify({ action: "buy" })) });
        }
        posts.push(JSON.parse(String((init as { body?: string } | undefined)?.body ?? "{}")));
        return Promise.resolve({
          ok: true,
          status: 200,
          text: () =>
            Promise.resolve(
              JSON.stringify({ code: "ORD1", pay_url: "https://pay.test/1" }),
            ),
        });
      },
    });
    await (sdk.checkout as (o: { planId: string; method?: string }) => Promise<unknown>)({
      planId: "p_1",
      method: "wechat",
    });
    expect(posts[0]!.payment_method).toBe("wechat");
  });

  it("选了这一档不支持的方式：拒绝，而不是悄悄换成第一种", async () => {
    const plan = {
      plan_id: "p_1",
      name: "月付",
      kind: "period",
      price_minor: 1500,
      currency: "CNY",
      action: "buy",
      buyable: true,
      payment_methods: [{ id: "alipay", label: "支付宝", icon_url: null }],
    };
    const { sdk } = load({
      token: "t0ken",
      fetch: (url) =>
        Promise.resolve({
          ok: true,
          status: 200,
          text: () => Promise.resolve(JSON.stringify(url.endsWith("/plans") ? [plan] : {})),
        }),
    });
    await expect(
      (sdk.checkout as (o: { planId: string; method?: string }) => Promise<unknown>)({
        planId: "p_1",
        method: "wechat",
      }),
    ).rejects.toMatchObject({ code: "payment_method_unavailable" });
  });

  it("没有可用支付方式时 methods 是空数组（模板就不显示那行）", async () => {
    const { sdk } = load({
      fetch: () =>
        Promise.resolve({
          ok: true,
          status: 200,
          text: () =>
            Promise.resolve(
              JSON.stringify([
                {
                  plan_id: "p_1",
                  name: "月付",
                  kind: "period",
                  price_minor: 1500,
                  currency: "CNY",
                  action: "login_required",
                  buyable: true,
                  payment_methods: null,
                },
              ]),
            ),
        }),
    });
    const plans = (await (sdk.plans as () => Promise<Record<string, unknown>[]>)()) as Record<
      string,
      unknown
    >[];
    expect(plans[0]!.methods).toEqual([]);
    expect(plans[0]!.action).toBe("login_required");
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
