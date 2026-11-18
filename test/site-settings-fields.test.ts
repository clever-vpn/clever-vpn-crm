/**
 * 设置字段清单的边界（契约 `site.md` `contract: 8`）。
 *
 * 这份清单是**数据契约本身**：模板只能引用清单里的路径，AI 不能加字段。
 * 所以"删掉一个字段"必须真的变成一个硬错误——否则模板里留着旧占位符，
 * 发布时静默渲染成空白，谁也发现不了。
 *
 * 判据见 `clever-vpn-docs/docs/standards/site-template.md` §3.2（文件 vs 事实 +
 * 首屏可见的例外）。
 */
import { describe, expect, it } from "vitest";

import { SITE_LIMITS } from "../src/site/limits";
import { siteCapabilities, siteMeta } from "../src/site/meta";
import {
  DEFAULT_COLORS,
  SETTING_FIELDS,
  THEME_COLORS,
  THEME_PRESETS,
  buildScope,
  validateValues,
} from "../src/site/settings";

const paths = (): string[] => Object.keys(SETTING_FIELDS).sort();
const derived = (): string[] =>
  siteCapabilities()
    .filter((c) => c.derived)
    .map((c) => c.path)
    .sort();

describe("字段清单：租户事实", () => {
  it("就是这 12 项", () => {
    expect(paths()).toEqual([
      "site.contact_email",
      "site.hero.sub",
      "site.hero.title",
      "site.legal_name",
      "site.name",
      "site.tagline",
      "site.theme.color.accent",
      "site.theme.color.background",
      "site.theme.color.primary",
      "site.theme.color.surface",
      "site.theme.color.text",
      "site.theme.preset",
    ]);
  });

  it("已删除的字段不再出现在 capabilities 里", () => {
    const declared = new Set(siteCapabilities().map((c) => c.path));
    for (const gone of [
      "site.footer_note",
      "site.hero.layout",
      "site.layout.shell",
      "site.theme.bg",
      "site.theme.text",
      "site.icon.mark",
      "site.icon.image",
      "site.download.note",
    ]) {
      expect(declared.has(gone), `${gone} 应该已经删掉`).toBe(false);
    }
  });

  it("派生值在清单里（闸门要认），但带 derived 标记（表单要跳过）", () => {
    expect(derived()).toEqual(["site.footer"]);
    // 旧主色路径已删除（正式发布、无历史包袱），连派生别名都不留
    expect(paths()).not.toContain("site.theme.brand");
    expect(siteCapabilities().map((c) => c.path)).not.toContain("site.theme.brand");
  });

  it("主题是封闭集合，并且带人话标签（表单里不该出现 light/dark）", () => {
    const cap = siteCapabilities().find((c) => c.path === "site.theme.preset");
    expect(cap?.values).toEqual([...THEME_PRESETS]);
    expect(cap?.value_labels).toEqual(["浅色", "深色"]);
  });

  it("每一项都有 label 与一句 hint（两个表单共用同一份说明）", () => {
    for (const cap of siteCapabilities().filter((c) => !c.derived && c.kind !== "collection")) {
      expect(cap.label, `${cap.path} 缺 label`).not.toBe(cap.path);
      expect(cap.hint, `${cap.path} 缺 hint`).toBeTruthy();
    }
  });

  it("五个颜色令牌都有默认值，且与 buildScope 的兜底一致", () => {
    for (const token of THEME_COLORS) {
      const cap = siteCapabilities().find((c) => c.path === `site.theme.color.${token}`);
      expect(cap?.default, `${token} 缺 default`).toBe(DEFAULT_COLORS[token]);
    }
  });
});

describe("校验", () => {
  it("写已删除的字段 ⇒ unknown_field（不是静默忽略）", () => {
    expect(validateValues({ site: { theme: { brand: "#000000" } } })).toMatchObject({
      code: "unknown_field",
    });
  });

  it("站名收紧到 24：25 个字就拒", () => {
    expect(validateValues({ site: { name: "一".repeat(25) } })).toMatchObject({
      code: "too_long",
    });
    expect(validateValues({ site: { name: "一".repeat(24) } })).toBeNull();
  });

  it("首屏标题 24 / 副标题 60", () => {
    expect(validateValues({ site: { hero: { title: "一".repeat(25) } } })).toMatchObject({
      code: "too_long",
    });
    expect(validateValues({ site: { hero: { sub: "一".repeat(61) } } })).toMatchObject({
      code: "too_long",
    });
    expect(
      validateValues({ site: { hero: { title: "一".repeat(24), sub: "一".repeat(60) } } }),
    ).toBeNull();
  });

  it("主题只能是 light / dark", () => {
    expect(validateValues({ site: { theme: { preset: "sepia" } } })).toMatchObject({
      code: "bad_enum",
    });
    expect(validateValues({ site: { theme: { preset: "dark" } } })).toBeNull();
  });

  it("主色太浅配白字看不清 ⇒ bad_contrast", () => {
    // #f5f5f5 与白字的对比度约 1.1:1
    expect(
      validateValues({ site: { theme: { color: { primary: "#f5f5f5" } } } }),
    ).toMatchObject({ code: "bad_contrast" });
    // 品牌蓝足够深，正常通过
    expect(validateValues({ site: { theme: { color: { primary: "#4f46e5" } } } })).toBeNull();
  });

  it("其余四个令牌只查格式（还没被模板消费，先不设对比度门槛）", () => {
    expect(
      validateValues({ site: { theme: { color: { background: "#f5f5f5" } } } }),
    ).toBeNull();
    expect(
      validateValues({ site: { theme: { color: { accent: "blue" } } } }),
    ).toMatchObject({ code: "bad_color" });
  });

  it("邮箱仍然要求格式", () => {
    expect(validateValues({ site: { contact_email: "nope" } })).toMatchObject({
      code: "bad_email",
    });
  });
});

describe("渲染作用域", () => {
  it("主题默认 light；写了封闭集合外的值也回落到 light", () => {
    const empty = buildScope({ values: {} }, "兜底");
    expect((empty.site as { theme: { preset: string } }).theme.preset).toBe("light");
    const odd = buildScope({ values: { site: { theme: { preset: "sepia" } } } }, "兜底");
    expect((odd.site as { theme: { preset: string } }).theme.preset).toBe("light");
  });

  it("深色主题按原样输出（模板拿它当 class）", () => {
    const scope = buildScope({ values: { site: { theme: { preset: "dark" } } } }, "兜底");
    expect((scope.site as { theme: { preset: string } }).theme.preset).toBe("dark");
  });

  it("五个颜色令牌：没填就用默认值", () => {
    const scope = buildScope({ values: {} }, "兜底");
    const color = (scope.site as { theme: { color: Record<string, string> } }).theme.color;
    expect(color).toEqual(DEFAULT_COLORS);
  });

  it("作用域里没有旧路径 brand（只有 theme.color.primary）", () => {
    const scope = buildScope(
      { values: { site: { theme: { color: { primary: "#123456" } } } } },
      "兜底",
    );
    const theme = (scope.site as { theme: Record<string, unknown> }).theme;
    expect((theme.color as { primary: string }).primary).toBe("#123456");
    expect(theme).not.toHaveProperty("brand");
  });

  it("版权行：有法务主体就用它，没有才用站名", () => {
    const withLegal = buildScope(
      { values: { site: { name: "Acme", legal_name: "某某网络科技有限公司" } } },
      "兜底",
    );
    expect((withLegal.site as { footer: string }).footer).toBe(
      `© ${new Date().getFullYear()} 某某网络科技有限公司`,
    );
    const withoutLegal = buildScope({ values: { site: { name: "Acme" } } }, "兜底");
    expect((withoutLegal.site as { footer: string }).footer).toBe(
      `© ${new Date().getFullYear()} Acme`,
    );
  });

  it("首屏标题与副标题原样进作用域", () => {
    const scope = buildScope(
      { values: { site: { hero: { title: "快", sub: "一键连接" } } } },
      "兜底",
    );
    expect((scope.site as { hero: unknown }).hero).toEqual({ title: "快", sub: "一键连接" });
  });

  it("meta 的 contract 跟着清单版本走", () => {
    expect(siteMeta().contract).toBe(8);
  });
});

describe("meta 的体积上限与配色建议", () => {
  it("limits 就是那一份常量（整版字节）", () => {
    expect(siteMeta().limits).toEqual(SITE_LIMITS);
    expect(SITE_LIMITS).toEqual({
      fileBytes: 2 << 20,
      totalBytes: 32 << 20,
      files: 200,
    });
  });

  it("每套配色都覆盖五个令牌（缺一个就不是成套）", () => {
    const palettes = siteMeta().palettes;
    expect(palettes.length).toBeGreaterThan(0);
    for (const palette of palettes) {
      expect(Object.keys(palette.colors).sort()).toEqual([...THEME_COLORS].sort());
      for (const value of Object.values(palette.colors)) {
        expect(value).toMatch(/^#[0-9a-f]{6}$/i);
      }
    }
  });
});
