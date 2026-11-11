/**
 * 用**真 SDK**跑一遍样例数据，证明"预览看到的就是线上会渲染的"。
 *
 * 为什么需要这条测试：`sampleDataOf()` 是给模板作者看的视图模型，`SAMPLE_PLANS_RAW`
 * 是给预览宿主当 `/plans` 响应用的原始形状。两者的对齐**只能**靠真 SDK 的
 * `planView()` 来证明 —— 手写第二份映射（或者改了一边忘了另一边）都会让预览与线上
 * 悄悄分叉，而分叉的表现是"预览正常、发布后价格卡全空"，最难查。
 *
 * 做法：把 `SDK_JS`（线上逐字节的那份）放进一个假 window 里执行，`fetch` 指向原始
 * 样例，然后比较 `plans()` / `orders()` 的输出。
 */
import { describe, expect, it } from "vitest";

import { SDK_JS, SDK_VERSION } from "../src/site/sdk";
import { SAMPLE_PLANS_RAW, sampleDataOf } from "../src/site/sample";

type Json = Record<string, unknown>;

interface FakeWindow {
  CRM_API_BASE?: string;
  localStorage?: { getItem: (k: string) => string | null; setItem: (k: string, v: string) => void; removeItem: (k: string) => void };
  console?: Json;
  SiteCrm?: Json;
}

/** 在假环境里执行真 SDK，返回 `window.SiteCrm` 与调用记录 */
function boot(options: { token?: string } = {}) {
  // 样例只取**一次**：`sampleDataOf()` 里的日期跟着 `new Date()` 走，两次调用之间
  // 跨过一毫秒就会让"同一个样例"不相等（假失败）。
  const sample = sampleDataOf();
  const store: Record<string, string> = options.token ? { crm_token: options.token } : {};
  const calls: string[] = [];
  const win: FakeWindow = {
    CRM_API_BASE: "https://crm.test",
    localStorage: {
      getItem: (k) => (k in store ? store[k]! : null),
      setItem: (k, v) => {
        store[k] = v;
      },
      removeItem: (k) => {
        delete store[k];
      },
    },
  };

  const json = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

  const fetchStub = async (url: string) => {
    calls.push(String(url));
    const path = String(url).replace("https://crm.test/api/app/v1", "");
    if (path.startsWith("/plans")) return json(SAMPLE_PLANS_RAW);
    if (path === "/me") return json(sample.me);
    if (path.startsWith("/orders?")) return json({ items: sample.orders });
    return json({ error: { code: "not_found", message: "没有这个接口" } }, 404);
  };

  // SDK 是 IIFE，只认 window/fetch + location/open；这里给最小替身，不引入 jsdom。
  // `localStorage` 要单独传：SDK 里是裸标识符（不是 window.localStorage）。
  const fn = new Function(
    "window",
    "localStorage",
    "fetch",
    "location",
    "JSON",
    "Promise",
    "Date",
    SDK_JS,
  );
  fn(win, win.localStorage, fetchStub, { origin: "https://site.test", assign() {} }, JSON, Promise, Date);
  return {
    sdk: win.SiteCrm as unknown as {
      version: string;
      plans: () => Promise<Json[]>;
      orders: () => Promise<Json[]>;
      me: () => Promise<Json | null>;
    },
    calls,
    sample,
  };
}

describe("真 SDK × 样例数据", () => {
  it("version 与 /api/site/meta 的 sdk_version 同源", () => {
    const { sdk } = boot();
    expect(sdk.version).toBe(SDK_VERSION);
  });

  it("plans() 的每个字段都与 sample-data 的视图模型一致（kind / action 也在）", async () => {
    const { sdk, sample: all } = boot();
    const plans = await sdk.plans();
    const sample = all.plans;

    expect(plans.map((p) => p.id)).toEqual(sample.map((p) => p.id));
    for (const [i, want] of sample.entries()) {
      expect(plans[i]).toEqual(want);
    }
    // 这两项是 mock 时代漏掉的（真 SDK 有、手写副本没有），单独钉一下
    expect(plans[0]).toHaveProperty("kind");
    expect(plans[0]).toHaveProperty("action");
  });

  it("orders() 取 items，me() 需要 token", async () => {
    const anon = boot();
    await expect(anon.sdk.me()).resolves.toBeNull();
    expect(anon.calls.some((u) => u.endsWith("/me"))).toBe(false);

    const signed = boot({ token: "sess_test" });
    const me = await signed.sdk.me();
    expect(me).toEqual(signed.sample.me);

    const orders = await signed.sdk.orders();
    expect(orders).toEqual(signed.sample.orders);
  });
});
