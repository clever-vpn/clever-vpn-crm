/**
 * 渲染引擎：三个指令的语义（standards/site-template.md §1 / §8）
 *
 * 这里只测引擎本身，不需要 D1/R2 —— 与 `site-publish.test.ts` 的分工是
 * "语义"与"整条流程"。
 */
import { describe, expect, it } from "vitest";

import { renderTemplate } from "../src/site/render";

const scope = {
  site: { name: "Acme", hero: { sub: "" } },
  plans: [
    { id: "p1", name: "月付", price: "¥10.00" },
    { id: "p2", name: "年付", price: "¥100.00" },
  ],
  downloads: [],
};

describe("取值 {{path}}", () => {
  it("文本与属性都能取", () => {
    const r = renderTemplate('<a href="buy?p={{site.name}}">{{site.name}}</a>', scope);
    expect(r.html).toBe('<a href="buy?p=Acme">Acme</a>');
    expect(r.missing).toEqual([]);
  });

  it("取不到 ⇒ 空串 + 记进 missing（绝不把花括号留在产物里）", () => {
    const r = renderTemplate("<p>{{site.nickname}}</p>", scope);
    expect(r.html).toBe("<p></p>");
    expect(r.missing).toEqual(["site.nickname"]);
  });

  it("数字与布尔能渲染，对象/数组渲染成空串", () => {
    const r = renderTemplate("{{n}}|{{b}}|{{o}}", { n: 0, b: false, o: { x: 1 } });
    expect(r.html).toBe("0|false|");
  });

  it("转义 HTML", () => {
    const r = renderTemplate("{{x}}", { x: '<b>"&' });
    expect(r.html).toBe("&lt;b&gt;&quot;&amp;");
  });
});

describe("data-repeat + data-as", () => {
  it("按集合重复，开标签在条目作用域里算（含属性里的取值）", () => {
    const src =
      '<ul><li class="p" data-repeat="plans" data-as="p"><a href="buy?p={{p.id}}">{{p.name}}</a></li></ul>';
    const r = renderTemplate(src, scope);
    expect(r.html).toBe(
      '<ul><li class="p"><a href="buy?p=p1">月付</a></li>' +
        '<li class="p"><a href="buy?p=p2">年付</a></li></ul>',
    );
  });

  it("空集合 ⇒ 元素一个都不出现（父元素保留）", () => {
    const src = '<ul><li data-repeat="downloads" data-as="d">{{d.label}}</li></ul>';
    expect(renderTemplate(src, scope).html).toBe("<ul></ul>");
  });

  it("集合本身不存在 ⇒ 记 missing", () => {
    const r = renderTemplate('<i data-repeat="nope" data-as="x">{{x.a}}</i>', scope);
    expect(r.html).toBe("");
    expect(r.missing).toContain("nope");
  });

  it("只删 data-repeat / data-as，其余属性原样保留", () => {
    const src = '<li class="a" data-x="1" data-repeat="plans" data-as="p" id="i">{{p.id}}</li>';
    expect(renderTemplate(src, scope).html).toBe(
      '<li class="a" data-x="1" id="i">p1</li><li class="a" data-x="1" id="i">p2</li>',
    );
  });
});

describe("data-if", () => {
  it("空值 ⇒ 整个元素连缩进一起消失", () => {
    const src = '<div>\n  <p data-if="site.hero.sub">{{site.hero.sub}}</p>\n  <p>x</p>\n</div>';
    expect(renderTemplate(src, scope).html).toBe("<div>\n  <p>x</p>\n</div>");
  });

  it("有值 ⇒ 保留元素，并删掉 data-if", () => {
    const src = '<p data-if="site.name">{{site.name}}</p>';
    expect(renderTemplate(src, scope).html).toBe("<p>Acme</p>");
  });

  it("0 与 false 不算空", () => {
    expect(renderTemplate('<i data-if="n">{{n}}</i>', { n: 0 }).html).toBe("<i>0</i>");
    expect(renderTemplate('<i data-if="b">{{b}}</i>', { b: false }).html).toBe(
      "<i>false</i>",
    );
  });

  it("包在 repeat 里时按本条数据判断", () => {
    const src =
      '<ul><li data-repeat="plans" data-as="p"><b data-if="p.price">{{p.price}}</b></li></ul>';
    expect(renderTemplate(src, scope).html).toBe(
      "<ul><li><b>¥10.00</b></li><li><b>¥100.00</b></li></ul>",
    );
  });

  it("嵌套：外层 if 为空时整块消失", () => {
    const src = '<div data-if="site.hero.sub"><p>a</p><p>b</p></div>';
    expect(renderTemplate(src, scope).html).toBe("");
  });
});

describe("纪律：逐字节不变", () => {
  it("没有指令与占位符的文件原样返回", () => {
    const src = '<!doctype html>\n<html><!-- c --><body class="x">hi</body></html>\n';
    expect(renderTemplate(src, scope).html).toBe(src);
  });
});
