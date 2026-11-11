/**
 * `GET /api/site/meta` —— 平台数据契约的对外形态。
 *
 * 契约 `site-studio-crm.md` v8 §4.4 / 标准 `site-template.md` §3：
 * **字段清单只有一份，归 CRM**；模板只引用，AI 不能新增字段。
 *
 * 这里锁三件事，每一件坏了都会让"预览与发布不一致"：
 *   1. `engine` 与 `render.ts` 的实际 sha256 对得上（不手填版本号）；
 *   2. `capabilities` 里**没有**运行期路径（`plans` / `orders` / `subscription` / `me`）；
 *   3. 每个能力都有 `path` + `kind` + `label` —— 少了任何一个，设置面板就生成不出来。
 */

import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { ENGINE_ID, ENGINE_SHA256 } from "../src/site/engine.generated";
import { SITE_CONTRACT, siteCapabilities, siteMeta } from "../src/site/meta";
import { SDK_VERSION } from "../src/site/sdk";
import { renderTemplate } from "../src/site/render";
import { SETTING_FIELDS, buildScope } from "../src/site/settings";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

describe('engine 版本号 = render.ts 的 sha256（"同一份引擎"这件事的证据）', () => {
  it('生成的常量与实际源码字节一致', () => {
    const sha = createHash("sha256").update(readFileSync(join(root, "src/site/render.ts"))).digest("hex");
    expect(ENGINE_SHA256).toBe(sha);
    expect(ENGINE_ID).toBe(`sha256:${sha.slice(0, 16)}`);
  });

  it('meta 里的 engine 就是那一个（不另起一套）', () => {
    expect(siteMeta().engine).toBe(ENGINE_ID);
  });
});

describe("capabilities：模板能引用什么", () => {
  const caps = siteCapabilities();

  it("每个设置字段都在清单里，且带 kind 与 label", () => {
    for (const path of Object.keys(SETTING_FIELDS)) {
      const cap = caps.find((c) => c.path === path);
      expect(cap, path).toBeDefined();
      expect(cap?.kind, path).toBeTruthy();
      expect(cap?.label, path).not.toBe(path); // 没写标签会回退成路径本身
      expect((cap?.label ?? "").length, path).toBeGreaterThan(0);
    }
  });

  /**
   * 路径必须是**渲染作用域**里的形状：库里叫 `downloads`，但 `buildScope()` 按平台
   * 分组。写成库里那个名字，闸门会放行一个渲染出来是空白的路径。
   */
  it("集合按平台分组（`site.download.<platform>`），带条目上限与字段定义", () => {
    for (const platform of ["ios", "android", "windows", "macos"]) {
      const cap = caps.find((c) => c.path === `site.download.${platform}`);
      expect(cap, platform).toBeDefined();
      expect(cap?.kind).toBe("collection");
      expect(cap?.items?.max).toBeGreaterThan(0);
      expect(Object.keys(cap?.items?.fields ?? {}).sort()).toEqual(["kind", "label", "platform", "url"]);
    }
    // 库里那个名字不是可引用路径
    expect(caps.some((c) => c.path === "downloads")).toBe(false);
  });

  /**
   * 这条是 H7 的地基：运行期数据一旦变成"可填字段"，谁都能新增一个价格设置项，
   * "业务数字不许写死"就形同虚设。
   */
  it("不含运行期路径（套餐/订单/订阅/登录态只能经 SiteCrm 取）", () => {
    const reserved = ["plans", "orders", "subscription", "me", "login", "user"];
    for (const cap of caps) {
      const head = cap.path.split(".")[0]!.toLowerCase();
      expect(reserved, cap.path).not.toContain(head);
    }
  });

  it("路径唯一（重复会让表单渲染两份）", () => {
    const paths = caps.map((c) => c.path);
    expect(new Set(paths).size).toBe(paths.length);
  });
});

describe("响应体", () => {
  it("只有四件东西：契约版本 + 引擎版本 + SDK 版本 + 能力清单", () => {
    // `sdk_version` 是 contract 6 加的：租户排障要看"这个站跑的是哪版 SDK"，
    // studio 预览也用它证明"预览与线上同一份 SDK"（site-crm.md §3.1）。
    expect(Object.keys(siteMeta()).sort()).toEqual([
      "capabilities",
      "contract",
      "engine",
      "sdk_version",
    ]);
    expect(siteMeta().contract).toBe(SITE_CONTRACT);
    expect(siteMeta().sdk_version).toBe(SDK_VERSION);
  });
});

/**
 * 派生值也必须在清单里。
 *
 * 踩过的坑：模板用 `{{site.footer}}`（标准 §3 的 `derived`），而 `capabilities`
 * 只列了设置字段 ⇒ studio 的 H1 判它 `unknown_path` **硬项**，一份合法模板被拦死。
 * 闸门用清单判"能不能引用"，所以清单必须把**渲染作用域里真实存在**的路径都写上。
 */
describe("capabilities：派生值也在清单里（但不能填）", () => {
  const caps = siteCapabilities();

  it("site.footer 被声明为 derived，且不在设置字段里", () => {
    const cap = caps.find((c) => c.path === "site.footer");
    expect(cap).toBeDefined();
    expect(cap?.derived).toBe(true);
    expect(Object.keys(SETTING_FIELDS)).not.toContain("site.footer");
  });

  it("派生值真的能渲染出东西（声明与渲染作用域一致）", () => {
    const scope = buildScope({ values: { site: { name: "Acme" } } }, "兜底");
    const rendered = renderTemplate("<p>{{site.footer}}</p>", scope as never);
    expect(rendered.missing).toEqual([]);
    expect(rendered.html).toContain("Acme");
  });

  it("每个 derived 能力都能在渲染作用域里取到值（不靠手写清单）", () => {
    const scope = buildScope({ values: {} }, "兜底");
    for (const cap of caps.filter((c) => c.derived)) {
      const { missing } = renderTemplate(`{{${cap.path}}}`, scope as never);
      expect(missing, cap.path).toEqual([]);
    }
  });
});
