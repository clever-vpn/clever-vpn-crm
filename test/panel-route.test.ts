/**
 * 面板路由：**入口就是 `/`**
 *
 * CRM 有自己的域名，让人记一层 `/admin` 是没有理由的。钉住四条：
 *   1. `/` → SPA（不是"CRM 已部署"占位页）；
 *   2. `/admin`、`/admin/`、`/admin/plans` → 302 到规范路径（老书签与邮件链接
 *      不能失效）；
 *   3. `admin/assets/*` 这类**真文件**不参与 302，否则 JS/CSS 全挂；
 *   4. 配了 `SITE_URL` 的自托管：根路径归官网，后台留在 `/admin/`。
 *
 * 为什么用纯函数测：Worker 集成测试跑在 workerd 里，`assets` 层会把 `/admin`、
 * `/admin/plans` 当静态命中先答掉，Worker 收不到请求 —— 在那里断言 302 测的是
 * 静态资源，测不到这里。
 */
import { describe, expect, it } from "vitest";

import {
  isSpaDeepLink,
  looksLikeFile,
  panelRoute,
  stripAdminPrefix,
} from "../src/panel-route";

describe("panelRoute", () => {
  it("根路径给 SPA", () => {
    expect(panelRoute("/", "")).toEqual({ kind: "spa" });
    expect(panelRoute("/index.html", undefined)).toEqual({ kind: "spa" });
  });

  it("老地址 302 到规范路径", () => {
    expect(panelRoute("/admin", "")).toEqual({ kind: "redirect", to: "/" });
    expect(panelRoute("/admin/", "")).toEqual({ kind: "redirect", to: "/" });
    expect(panelRoute("/admin/plans", "")).toEqual({ kind: "redirect", to: "/plans" });
    expect(panelRoute("/admin/marketing/coupons", "")).toEqual({
      kind: "redirect",
      to: "/marketing/coupons",
    });
  });

  it("规范路径原样放行（不循环跳转）", () => {
    expect(panelRoute("/plans", "")).toEqual({ kind: "pass" });
    expect(panelRoute("/settings", "")).toEqual({ kind: "pass" });
  });

  it("真文件不参与 302（admin/assets/*.js 必须照常发出）", () => {
    expect(panelRoute("/admin/assets/index-abc123.js", "")).toEqual({ kind: "pass" });
    expect(panelRoute("/admin/favicon.ico", "")).toEqual({ kind: "pass" });
  });

  it("配了 SITE_URL：根路径归官网，后台留在 /admin/", () => {
    expect(panelRoute("/", "https://acme.example")).toEqual({
      kind: "site",
      to: "https://acme.example",
    });
    // 官网占了 `/`，就不能再把 `/admin/*` 跳走
    expect(panelRoute("/admin/plans", "https://acme.example")).toEqual({ kind: "pass" });
  });

  it("`/administrator` 这种同前缀不同路径不能误伤", () => {
    expect(panelRoute("/administrator", "")).toEqual({ kind: "pass" });
  });
});

describe("工具函数", () => {
  it("stripAdminPrefix", () => {
    expect(stripAdminPrefix("/admin")).toBe("/");
    expect(stripAdminPrefix("/admin/")).toBe("/");
    expect(stripAdminPrefix("/admin/plans")).toBe("/plans");
  });

  it("looksLikeFile", () => {
    expect(looksLikeFile("/admin/assets/x.js")).toBe(true);
    expect(looksLikeFile("/plans")).toBe(false);
    expect(looksLikeFile("/plans/")).toBe(false);
  });

  it("isSpaDeepLink：非文件请求才回落 index.html", () => {
    expect(isSpaDeepLink("/plans")).toBe(true);
    expect(isSpaDeepLink("/marketing/coupons")).toBe(true);
    expect(isSpaDeepLink("/admin/assets/x.css")).toBe(false);
  });
});
