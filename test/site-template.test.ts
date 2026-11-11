/**
 * 模板包本身的自检：把 `site-template/` 里的真实页面过一遍渲染器。
 *
 * 为什么要有这层：`renderTemplate` 的单测只会证明"引擎按规格工作"，
 * 证明不了"模板写对了"。模板里少写一个 `data-if`，线上就会多一张空卡片；
 * 写错一个路径，发布时会以 `template_token_unknown` 失败——而这两类错误
 * 都只会在点发布的那一刻才暴露。这里提前到单测。
 */
import { readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

import { siteCapabilities } from "../src/site/meta";
import { renderTemplate } from "../src/site/render";
import { buildScope } from "../src/site/settings";

/** vitest 的 cwd 就是仓库根，直接拼路径，别跟 `URL` 的类型打架 */
const page = (name: string): string =>
  readFileSync(resolve(process.cwd(), "site-template", name), "utf8");

type Item = { platform: string; kind: string; label: string; url: string };

function render(name: string, downloads: Item[], note = "") {
  const html = page(name);
  return renderTemplate(
    html,
    buildScope(
      {
        values: { site: { name: "Acme VPN", download: { note } } },
        collections: { downloads },
      },
      "兜底",
    ),
  );
}

const item = (
  platform: string,
  label: string,
  url: string,
  kind = "file",
): Item => ({ platform, kind, label, url });

const ALL: Item[] = [
  item("ios", "前往 App Store", "https://apps.apple.com/app/id1", "store"),
  item("android", "前往 Google Play", "https://play.google.com/store/apps/details?id=x", "store"),
  item("windows", "下载 Windows 版", "https://dl.example.com/Acme.exe"),
  item("macos", "下载 Mac 版", "https://dl.example.com/Acme.dmg"),
];

describe("下载页：按平台分组，一个平台可以多个渠道", () => {
  it("四个平台各一条 ⇒ 四张卡都在，链接原样落到 href", () => {
    const r = render("download.html", ALL, "Windows 版只有 64 位");
    expect(r.missing).toEqual([]);
    for (const d of ALL) {
      expect(r.html).toContain(d.label);
      expect(r.html).toContain(`href="${d.url}"`);
    }
    expect(r.html).toContain("Windows 版只有 64 位");
  });

  it("同一平台两条渠道 ⇒ 那张卡里两个按钮，顺序跟录入一致", () => {
    const r = render("download.html", [
      item("windows", "64 位安装包", "https://dl.test/win-x64.exe"),
      item("windows", "32 位安装包", "https://dl.test/win-x86.exe"),
    ]);
    expect(r.missing).toEqual([]);
    const x64 = r.html.indexOf("64 位安装包");
    const x86 = r.html.indexOf("32 位安装包");
    expect(x64).toBeGreaterThan(-1);
    expect(x86).toBeGreaterThan(x64);
    // 只有一个平台有货 ⇒ 别的平台连标题都不出现
    expect(r.html).toContain(">Windows<");
    expect(r.html).not.toContain("iPhone / iPad");
    expect(r.html).not.toContain(">Android<");
    expect(r.html).not.toContain(">Mac<");
  });

  it("一个渠道都没有 ⇒ 页面仍完整，不留半截标签", () => {
    const r = render("download.html", []);
    expect(r.missing).toEqual([]);
    expect(r.html).toContain("下载客户端");
    expect(r.html).toContain("装好之后");
    expect(r.html).not.toContain("{{");
    expect(r.html).not.toContain("data-if");
    expect(r.html).not.toContain("data-repeat");
  });

  it("链接里的引号被转义，不能拿来逃出 href", () => {
    const r = render("download.html", [
      item("ios", "x", 'https://x.test/"><script>alert(1)</script>', "store"),
    ]);
    expect(r.html).toContain("&quot;&gt;&lt;script&gt;");
    expect(r.html).not.toContain("<script>alert(1)</script>");
  });
});

describe("其它页面：不留占位符、不留指令", () => {
  for (const name of ["index.html", "pricing.html", "login.html", "account.html"]) {
    it(name, () => {
      const r = render(name, []);
      expect(r.missing).toEqual([]);
      expect(r.html).not.toContain("{{");
      expect(r.html).not.toContain("data-repeat");
      expect(r.html).not.toContain("data-if");
    });
  }
});

/**
 * 模板引用的每一个路径都必须在契约清单里。
 *
 * 这是把 studio 的 H1 提前到 CRM 这一侧：交付时闸门用 `/api/site/meta` 的
 * `capabilities` 判“这个路径能不能用”，清单漏一项，一份合法模板就会被判死
 * （`{{site.footer}}` 就是这么被拦的）。模板与清单左右互查，谁漂了一目了然。
 */
describe("模板只引用清单里的路径（与 H1 同一条判据）", () => {
  const caps = siteCapabilities();
  const declared = new Set(caps.map((c) => c.path));
  const reserved = new Set(["plans", "orders", "subscription", "me"]);

  /** 站内全部页面（含 legal/ 这类子目录） */
  const pages = readdirSync(resolve(process.cwd(), "site-template"), { recursive: true })
    .map(String)
    .filter((name) => name.endsWith(".html") && !name.startsWith("_"));

  it("根路径有 index.html（交付硬项）", () => {
    expect(pages).toContain("index.html");
  });

  for (const name of pages) {
    it(name, () => {
      const html = page(name);
      // data-as 声明的别名在条目作用域里，不属于契约路径
      const aliases = new Set(
        [...html.matchAll(/\bdata-as\s*=\s*"([^"]*)"/g)].map((m) => m[1]!.trim()).filter(Boolean),
      );
      const refs = new Set<string>();
      for (const m of html.matchAll(/\{\{\s*([a-zA-Z0-9_]+(?:\.[a-zA-Z0-9_]+)*)\s*\}\}/g)) {
        refs.add(m[1]!);
      }
      for (const m of html.matchAll(/\bdata-(?:repeat|if)\s*=\s*"([^"]*)"/g)) {
        const value = m[1]!.trim();
        if (value) refs.add(value);
      }

      const unknown = [...refs].filter((ref) => {
        const head = ref.split(".")[0]!;
        if (aliases.has(head)) return false;
        if (reserved.has(head)) return false;
        return !declared.has(ref);
      });
      expect(unknown, `${name} 引用了清单外的路径`).toEqual([]);
    });
  }
});

/**
 * 模板不能有内联 `<script>`：发布产物的 CSP 会拦掉它，等于线上**静默不执行**。
 * 判据在 studio 的 L0（`inline_script` 硬项），这里提前把人会犯的错拦住 ——
 * 一份被闸门拒收的公共模板，会让每个新租户的第一步就是红的。
 */
describe("模板不含内联脚本（L0 的 inline_script 是硬项）", () => {
  const pages = readdirSync(resolve(process.cwd(), "site-template"), { recursive: true })
    .map(String)
    .filter((name) => name.endsWith(".html"));

  for (const name of pages) {
    it(name, () => {
      // `<script src=...>` 允许；`<script>` 之后直接跟代码的一律不允许
      expect(page(name)).not.toMatch(/<script(?![^>]*\bsrc=)[^>]*>/i);
    });
  }
});
