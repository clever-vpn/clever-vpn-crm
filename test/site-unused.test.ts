/**
 * S2：**设了值、但产物里没用到**。
 *
 * 这条软项存在的理由：租户在后台改了一个值、保存成功、页面没变 —— 他不知道这是
 * "模板没接这个字段"，只会以为工具坏了。所以每次烘焙都把结论算出来给他看。
 *
 * 两条容易错的边界，这里都钉住：
 *   · 派生值算消费（`{{site.footer}}` 用了站名与法务主体），不能把它们误报成未使用；
 *   · 没填的字段不算未使用（没填当然用不上）。
 */
import { describe, expect, it } from "vitest";

import { unusedOf } from "../src/site/bake";
import { renderTemplate } from "../src/site/render";
import { SETTING_FIELDS, buildScope } from "../src/site/settings";
import { seedFiles } from "../src/site/source";

const page = (body: string) => [{ path: "index.html", body }];

/** 所有设置都填上（用来问"这份模板到底接了几个"） */
const allValues = (): Record<string, unknown> => {
  const values: Record<string, unknown> = { site: { theme: { color: {} } } };
  for (const path of Object.keys(SETTING_FIELDS)) {
    const parts = path.split(".");
    let cur = values as Record<string, unknown>;
    for (const part of parts.slice(0, -1)) {
      cur[part] = (cur[part] as Record<string, unknown>) ?? {};
      cur = cur[part] as Record<string, unknown>;
    }
    cur[parts[parts.length - 1]!] = /color|preset/.test(path) ? "#123456" : "x";
  }
  return values;
};

describe("unusedOf", () => {
  it("引用了的路径不算未使用（`{{}}` / data-if / data-repeat）", () => {
    const values = { site: { name: "Acme", tagline: "口号", hero: { sub: "副标题" } } };
    const unused = unusedOf(
      page(
        '<title>{{site.name}}</title><p data-if="site.hero.sub">{{site.hero.sub}}</p><p data-if="site.tagline">…</p>',
      ),
      values,
    );
    expect(unused).toEqual([]);
  });

  it("设了值但模板没引用 ⇒ 报出来", () => {
    const unused = unusedOf(page("<h1>写死的标题</h1>"), {
      site: { name: "Acme", hero: { title: "快" } },
    });
    expect(unused.sort()).toEqual(["site.hero.title", "site.name"]);
  });

  it("没填的字段不报（没填当然用不上）", () => {
    expect(unusedOf(page("<h1>x</h1>"), { site: { name: "Acme", legal_name: "  " } })).toEqual([
      "site.name",
    ]);
  });

  it("`{{site.footer}}` 算消费了站名与法务主体（派生值在引擎里用它们）", () => {
    const unused = unusedOf(page("<footer>{{site.footer}}</footer>"), {
      site: { name: "Acme", legal_name: "某某科技有限公司" },
    });
    expect(unused).toEqual([]);
  });

  it("只看 .html/.css/.js 这类文本文件（二进制不算引用）", () => {
    const unused = unusedOf([{ path: "assets/logo.png", body: new Uint8Array([1, 2, 3]) }], {
      site: { name: "Acme" },
    });
    expect(unused).toEqual(["site.name"]);
  });
});

describe("种子模板：U3 之后每个设置都接上了", () => {
  it("12 个字段全部有引用（否则就是「设了值改了看不见」）", () => {
    const unused = unusedOf(seedFiles(), allValues());
    expect(unused).toEqual([]);
  });
});

/**
 * 种子的**可见性**：设置改了，产物里真的变了。
 *
 * 这条盯的是 U3 的目的 —— `contract: 8` 加了首屏与五个颜色令牌，如果种子还写着
 * 硬编码文案与色值，租户填了也看不见（"改了设置没变"是最伤信任的一种失败）。
 */
describe("种子产物：设置真的写进去了", () => {
  const texts = (): Record<string, string> =>
    Object.fromEntries(
      seedFiles()
        .filter((f) => typeof f.body === "string")
        .map((f) => [f.path, f.body as string]),
    );

  it("每个文本文件都能用当前作用域渲染（没有未定义占位符）", () => {
    const scope = buildScope({ values: { site: { name: "Acme" } } }, "兜底");
    for (const [path, text] of Object.entries(texts())) {
      const rendered = renderTemplate(text, scope);
      expect(rendered.missing, `${path} 引用了契约里没有的路径`).toEqual([]);
    }
  });

  it("首屏用设置里的标题与副标题", () => {
    const scope = buildScope(
      { values: { site: { name: "Acme", hero: { title: "快", sub: "一键连接" } } } },
      "兜底",
    );
    const html = renderTemplate(texts()["index.html"]!, scope).html;
    expect(html).toContain("<h1>快</h1>");
    expect(html).toContain('<p class="lead">一键连接</p>');
  });

  it("副标题留空 ⇒ 整个段落消失（`data-if` 判空）", () => {
    const scope = buildScope({ values: { site: { name: "Acme" } } }, "兜底");
    const html = renderTemplate(texts()["index.html"]!, scope).html;
    expect(html).toContain("<h1>Acme</h1>"); // 标题回落到站名
    expect(html).not.toContain('class="lead"');
  });

  it("颜色令牌写进 CSS，且没填时跟随主题（浅色/深色两套）", () => {
    const light = buildScope({ values: {} }, "兜底");
    const lightCss = renderTemplate(texts()["site.css"]!, light).html;
    expect(lightCss).toContain("--bg: #ffffff");
    expect(lightCss).toContain("--text: #0d1626");

    const dark = buildScope({ values: { site: { theme: { preset: "dark" } } } }, "兜底");
    const darkCss = renderTemplate(texts()["site.css"]!, dark).html;
    expect(darkCss).toContain("--bg: #0b1020");
    expect(darkCss).toContain("--surface: #141d31");
  });

  it("法务主体写进条款/隐私页（留空则整行消失）", () => {
    const withLegal = buildScope(
      { values: { site: { name: "Acme", legal_name: "某某网络科技有限公司" } } },
      "兜底",
    );
    for (const path of ["legal/terms.html", "legal/privacy.html"]) {
      const html = renderTemplate(texts()[path]!, withLegal).html;
      expect(html, path).toContain("某某网络科技有限公司");
    }
    const without = buildScope({ values: { site: { name: "Acme" } } }, "兜底");
    expect(renderTemplate(texts()["legal/terms.html"]!, without).html).not.toContain("服务提供方");
  });
});
