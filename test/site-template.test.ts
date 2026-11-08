/**
 * 模板包本身的自检：把 `site-template/` 里的真实页面过一遍渲染器。
 *
 * 为什么要有这层：`renderTemplate` 的单测只会证明"引擎按规格工作"，
 * 证明不了"模板写对了"。模板里少写一个 `data-if`，线上就会多一张空卡片；
 * 写错一个路径，发布时会以 `template_token_unknown` 失败——而这两类错误
 * 都只会在点发布的那一刻才暴露。这里提前到单测。
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

import { renderTemplate } from "../src/site/render";
import { buildScope } from "../src/site/settings";

/** vitest 的 cwd 就是仓库根，直接拼路径，别跟 `URL` 的类型打架 */
const page = (name: string): string =>
  readFileSync(resolve(process.cwd(), "site-template", name), "utf8");

function render(name: string, download: Record<string, string>) {
  const html = page(name);
  const r = renderTemplate(
    html,
    buildScope({ site: { name: "Acme VPN", download } }, "兜底"),
  );
  return r;
}

const ALL = {
  ios: "https://apps.apple.com/app/id1",
  android: "https://play.google.com/store/apps/details?id=x",
  windows: "https://dl.example.com/Acme.exe",
  macos: "https://dl.example.com/Acme.dmg",
  note: "Windows 版只有 64 位",
};

describe("下载页：四个平台各一张卡，没有链接就整块不出现", () => {
  it("全填 ⇒ 四张卡都在，链接原样落到 href", () => {
    const r = render("download.html", ALL);
    expect(r.missing).toEqual([]);
    for (const [text, url] of [
      ["前往 App Store", ALL.ios],
      ["前往 Google Play", ALL.android],
      ["下载 Windows 版", ALL.windows],
      ["下载 Mac 版", ALL.macos],
    ]) {
      expect(r.html).toContain(text);
      expect(r.html).toContain(`href="${url}"`);
    }
    expect(r.html).toContain(ALL.note);
  });

  it("只填 iOS ⇒ 别的平台连标题都不出现", () => {
    const r = render("download.html", { ios: ALL.ios });
    expect(r.missing).toEqual([]);
    expect(r.html).toContain("前往 App Store");
    for (const gone of ["前往 Google Play", "下载 Windows 版", "下载 Mac 版"]) {
      expect(r.html).not.toContain(gone);
    }
    // 备注没填 ⇒ 那一行也不该留个空 <p>
    expect(r.html).not.toContain(`data-if="site.download.note"`);
  });

  it("一个都没填 ⇒ 页面仍完整，不留半截标签", () => {
    const r = render("download.html", {});
    expect(r.missing).toEqual([]);
    expect(r.html).toContain("下载客户端");
    expect(r.html).toContain("装好之后");
    // 渲染后不该再有指令或占位符
    expect(r.html).not.toContain("{{");
    expect(r.html).not.toContain("data-if");
  });

  it("链接里的引号被转义，不能拿来逃出 href", () => {
    const r = render("download.html", {
      ios: 'https://x.test/"><script>alert(1)</script>',
    });
    expect(r.html).toContain("&quot;&gt;&lt;script&gt;");
    expect(r.html).not.toContain("<script>alert(1)</script>");
  });
});

describe("其它页面：不留占位符、不留指令", () => {
  for (const name of ["index.html", "pricing.html", "login.html", "account.html"]) {
    it(name, () => {
      const r = render(name, {});
      expect(r.missing).toEqual([]);
      expect(r.html).not.toContain("{{");
      expect(r.html).not.toContain("data-repeat");
      expect(r.html).not.toContain("data-if");
    });
  }
});
