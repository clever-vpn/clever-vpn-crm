/**
 * 后台设置表单 = **由 capabilities 生成**（`web/src/site-fields.ts`）。
 *
 * 为什么值得一条单测：这张表单以前是手写的，字段清单一改它就悄悄少一项 ——
 * 不报错、不崩，只是那个字段在后台消失了。`typecheck` 抓不到（前端类型是手写镜像），
 * 只有把"清单 → 控件"这段纯映射钉住，才不会再犯。
 */
import { describe, expect, it } from "vitest";

import { siteCapabilities } from "../src/site/meta";
import { isInternalSetting, SETTING_FIELDS } from "../src/site/settings";
import {
  COLOR_TOKENS,
  formFields,
  getPath,
  initialValues,
  palettePatch,
  type SiteCapability,
  type SitePalette,
} from "../web/src/site-fields";

const fields = () => formFields(siteCapabilities());

describe("清单 → 表单", () => {
  it("每一个可填字段都出现在表单里（internal 的工程配置除外）", () => {
    const rendered = fields().map((f) => f.path);
    const expectable = Object.keys(SETTING_FIELDS).filter((p) => !isInternalSetting(p));
    expect(rendered.sort()).toEqual(expectable.sort());
  });

  it("派生值与集合不进表单（填了也不生效）", () => {
    const rendered = new Set(fields().map((f) => f.path));
    expect(rendered.has("site.footer")).toBe(false);
    expect(rendered.has("site.theme.brand")).toBe(false);
    expect(rendered.has("site.download.ios")).toBe(false);
  });

  it("控件按 kind 选：色值给取色器、枚举给下拉、其余给输入框", () => {
    const byPath = new Map(fields().map((f) => [f.path, f]));
    expect(byPath.get("site.theme.color.primary")?.control).toBe("color");
    expect(byPath.get("site.theme.preset")?.control).toBe("select");
    expect(byPath.get("site.contact_email")?.control).toBe("email");
    expect(byPath.get("site.hero.title")?.control).toBe("text");
  });

  it("枚举的中文标签来自契约，不是表单里写死的", () => {
    const preset = fields().find((f) => f.path === "site.theme.preset");
    expect(preset?.options).toEqual([
      { value: "light", label: "浅色" },
      { value: "dark", label: "深色" },
    ]);
  });

  it("上限跟着契约走（站名 24、副标题 60）", () => {
    const byPath = new Map(fields().map((f) => [f.path, f]));
    expect(byPath.get("site.name")?.max).toBe(24);
    expect(byPath.get("site.hero.sub")?.max).toBe(60);
  });

  it("不认识的 kind 跳过（宁可少一项，也不猜一个写坏数据的控件）", () => {
    const weird: SiteCapability = { path: "site.mystery", kind: "hologram", label: "？" };
    expect(formFields([weird])).toEqual([]);
  });
});

describe("回填", () => {
  it("库里的值按路径取出来（嵌套形状就是保存时的形状）", () => {
    const out = initialValues(fields(), {
      site: { name: "Acme", hero: { title: "快" }, theme: { color: { primary: "#123456" } } },
    });
    expect(getPath(out, "site.name")).toBe("Acme");
    expect(getPath(out, "site.hero.title")).toBe("快");
    expect(getPath(out, "site.theme.color.primary")).toBe("#123456");
  });

  it("没填的项用契约的默认值（色值 / 主题）", () => {
    const out = initialValues(fields(), {});
    expect(getPath(out, "site.theme.preset")).toBe("light");
    expect(getPath(out, "site.theme.color.primary")).toBe("#4f46e5");
  });

  it("库里残留的已删路径不回填（否则保存时被判 unknown_field）", () => {
    const out = initialValues(fields(), {
      site: { name: "Acme", theme: { brand: "#ff0000" } },
    });
    expect(getPath(out, "site.theme")).not.toHaveProperty("brand");
    expect(getPath(out, "site.name")).toBe("Acme");
  });
});

describe("配色建议", () => {
  /**
   * 应用一套方案 = `preset` + 主色 + 强调色，**中性三色不写**。
   *
   * 写进去的后果很具体：方案里的底色是"浅色白底"，租户之后把主题切成深色，
   * 底色还是白 —— 看上去就像切换没生效。中性三色必须继续跟随主题。
   */
  it("只写 preset + 主色 + 强调色，中性三色保持跟随主题", () => {
    const palette: SitePalette = {
      id: "x",
      label: "X",
      preset: "dark",
      colors: {
        primary: "#111111",
        accent: "#222222",
        background: "#333333",
        surface: "#444444",
        text: "#555555",
      },
    };
    const patch = palettePatch(palette) as {
      site: { theme: { color: Record<string, string>; preset?: string } };
    };
    expect(Object.keys(patch.site.theme.color).sort()).toEqual(["accent", "primary"]);
    expect(patch.site.theme.color.primary).toBe("#111111");
    expect(patch.site.theme.preset).toBe("dark");
    expect(Object.keys(patch.site.theme.color)).not.toContain("background");
  });
});
