/**
 * 设置字段清单的边界（契约 `site-crm.md` `contract: 7`）。
 *
 * 这份清单是**数据契约本身**：模板只能引用清单里的路径，AI 不能加字段。
 * 所以"删掉一个字段"必须真的变成一个硬错误——否则模板里留着旧占位符，
 * 发布时静默渲染成空白，谁也发现不了。
 *
 * 判据见 `clever-vpn-docs/docs/standards/site-template.md` §3.2（六条）。
 */
import { describe, expect, it } from "vitest";

import { siteCapabilities, siteMeta } from "../src/site/meta";
import {
  SETTING_FIELDS,
  THEME_PRESETS,
  buildScope,
  validateValues,
} from "../src/site/settings";

const paths = (): string[] => Object.keys(SETTING_FIELDS).sort();

describe("字段清单：身份 + 视觉", () => {
  it("只有 5 项，且每一项都真的被种子用得上", () => {
    expect(paths()).toEqual([
      "site.contact_email",
      "site.name",
      "site.tagline",
      "site.theme.brand",
      "site.theme.preset",
    ]);
  });

  it("已删除的字段不再出现在 capabilities 里", () => {
    const declared = new Set(siteCapabilities().map((c) => c.path));
    for (const gone of [
      "site.footer_note",
      "site.hero.title",
      "site.hero.sub",
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

  it("主题是封闭集合，并且带人话标签（表单里不该出现 light/dark）", () => {
    const cap = siteCapabilities().find((c) => c.path === "site.theme.preset");
    expect(cap?.values).toEqual([...THEME_PRESETS]);
    expect(cap?.value_labels).toEqual(["浅色", "深色"]);
  });
});

describe("校验", () => {
  it("写已删除的字段 ⇒ unknown_field（不是静默忽略）", () => {
    expect(validateValues({ site: { hero: { title: "标题" } } })).toMatchObject({
      code: "unknown_field",
    });
  });

  it("主题只能是 light / dark", () => {
    expect(validateValues({ site: { theme: { preset: "sepia" } } })).toMatchObject({
      code: "bad_enum",
    });
    expect(validateValues({ site: { theme: { preset: "dark" } } })).toBeNull();
  });

  it("主色太浅配白字看不清 ⇒ bad_contrast", () => {
    // #f5f5f5 与白字的对比度约 1.1:1
    expect(validateValues({ site: { theme: { brand: "#f5f5f5" } } })).toMatchObject({
      code: "bad_contrast",
    });
    // 品牌蓝足够深，正常通过
    expect(validateValues({ site: { theme: { brand: "#4f46e5" } } })).toBeNull();
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

  it("版权行由站名派生，没有独立设置项", () => {
    const scope = buildScope({ values: { site: { name: "Acme" } } }, "兜底");
    const site = scope.site as { footer: string };
    expect(site.footer).toMatch(/^© \d{4} Acme$/);
  });

  it("meta 的 contract 跟着清单版本走", () => {
    expect(siteMeta().contract).toBe(7);
  });
});
