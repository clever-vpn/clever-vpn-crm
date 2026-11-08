/**
 * 站点发布：`post() → R2 写产物 → D1 记账 → KV 切指针`
 *
 * 断言的重点不是"函数能跑"，而是**契约里那三条纪律真的成立**：
 *
 *   1. **顺序**：指针最后才切。所以发布失败时 KV 里必须还是旧值（线上不受影响）。
 *   2. **版本不可变**：每次发布是一个新 `n`，旧 `n` 的产物一个字节都不动 ——
 *      回滚才有可能。
 *   3. **L0 闸门在服务端**：studio 可以被绕过，指针一翻就是线上，所以这里必须也拦。
 */
import { beforeEach, describe, expect, it } from "vitest";

import { env } from "./apply-migrations";
import { activeKey, lintManifest, publishSite, siteState } from "../../src/site/publish";
import { readSiteSettings, saveSiteSettings } from "../../src/site/settings";

const TENANT = "42";
const BASE = "https://acme.clever-panel.win";

/** 这两个绑定在测试里一定存在（`vitest.workers.config.ts` 注入），断言一次省得满屏 `!` */
const SITES: R2Bucket = env.SITES!;
const HOSTS: KVNamespace = env.HOSTS!;

/** 往"R2"里放一个模板；`tpl` 可选覆写某个文件的正文 */
async function seedTemplate(
  files: Record<string, string> = {
    "index.html": "<!doctype html><h1>Hello</h1>",
    "assets/app.css": "h1{color:red}",
  },
  version = "v1",
) {
  for (const [rel, body] of Object.entries(files)) {
    await SITES.put(`g/templates/basic/${version}/${rel}`, body, {
      httpMetadata: { contentType: rel.endsWith(".css") ? "text/css" : "text/html" },
    });
  }
}

beforeEach(async () => {
  // 每个用例从干净状态开始：清模板、清产物、清指针、清账
  for (const prefix of ["g/templates/basic/", `sites/${TENANT}/`]) {
    const listed = await SITES.list({ prefix });
    for (const o of listed.objects) await SITES.delete(o.key);
  }
  await HOSTS.delete(activeKey(TENANT));
  await env.DB.prepare("DELETE FROM site_versions").run();
});

describe("L0 闸门（服务端那一份）", () => {
  it("缺 index.html ⇒ 拦", () => {
    expect(lintManifest([{ key: "style.css", size: 10 }])).toContain(
      "缺少 index.html（根路径无处可服务）",
    );
  });

  it("路径穿越 / 绝对路径 ⇒ 拦", () => {
    const issues = lintManifest([
      { key: "index.html", size: 10 },
      { key: "../etc/passwd", size: 10 },
      { key: "/abs.html", size: 10 },
    ]);
    expect(issues.some((i) => i.startsWith("非法路径"))).toBe(true);
  });

  it("扩展名不在白名单 ⇒ 拦（不给可执行文件开门）", () => {
    const issues = lintManifest([
      { key: "index.html", size: 10 },
      { key: "shell.php", size: 10 },
    ]);
    expect(issues.some((i) => i.includes("不允许的文件类型"))).toBe(true);
  });

  it("单文件超 1 MB ⇒ 拦", () => {
    const issues = lintManifest([
      { key: "index.html", size: 10 },
      { key: "big.png", size: 2 << 20 },
    ]);
    expect(issues.some((i) => i.includes("单文件超限"))).toBe(true);
  });
});

describe("发布", () => {
  it("模板进、产物出、指针指到 1", async () => {
    await seedTemplate();

    const result = await publishSite(env, TENANT, { actor: "admin@test", apiBase: BASE });
    expect(result).toMatchObject({ ok: true, version: 1, files: 2 });

    const html = await SITES.get(
      `sites/${TENANT}/versions/1/public/index.html`,
    );
    expect(await html?.text()).toContain("Hello");
    // 子目录结构必须保留，否则 assets/app.css 会 404
    expect(
      await SITES.head(`sites/${TENANT}/versions/1/public/assets/app.css`),
    ).not.toBeNull();

    // 指针是 site-serve 读的那把 key，值形状必须是 { n }
    expect(await HOSTS.get(activeKey(TENANT), "json")).toEqual({ n: 1 });
  });

  it("再发一版 ⇒ n=2，且第 1 版原样保留（回滚的前提）", async () => {
    await seedTemplate();
    await publishSite(env, TENANT, { apiBase: BASE });
    await publishSite(env, TENANT, { apiBase: BASE });

    expect(await HOSTS.get(activeKey(TENANT), "json")).toEqual({ n: 2 });
    expect(
      await SITES.head(`sites/${TENANT}/versions/1/public/index.html`),
    ).not.toBeNull();
    expect(
      await SITES.head(`sites/${TENANT}/versions/2/public/index.html`),
    ).not.toBeNull();
  });

  it("模板不在 R2 ⇒ 明确报错，指针不动", async () => {
    await seedTemplate();
    await publishSite(env, TENANT, { apiBase: BASE });
    // 清掉模板，模拟"没上传模板就点发布"
    const listed = await SITES.list({ prefix: "g/templates/basic/" });
    for (const o of listed.objects) await SITES.delete(o.key);

    const again = await publishSite(env, TENANT, { apiBase: BASE });
    expect(again).toMatchObject({ ok: false, code: "template_missing" });
    // 关键：线上仍是 1，不是"半成品 2"
    expect(await HOSTS.get(activeKey(TENANT), "json")).toEqual({ n: 1 });
  });

  it("L0 失败 ⇒ 不写产物、不记账、不切指针", async () => {
    await seedTemplate({ "style.css": "h1{color:red}" }); // 没有 index.html

    const result = await publishSite(env, TENANT, { apiBase: BASE });
    expect(result).toMatchObject({ ok: false, code: "l0_failed" });
    expect(await HOSTS.get(activeKey(TENANT))).toBeNull();

    const rows = await env.DB.prepare(
      "SELECT COUNT(*) AS c FROM site_versions",
    ).first<{ c: number }>();
    expect(rows?.c).toBe(0);
  });

  it("没有绑定 R2 ⇒ 报 r2_not_configured，而不是静默成功", async () => {
    const bare = { ...env, SITES: undefined };
    expect(await publishSite(bare as never, TENANT, { apiBase: BASE })).toMatchObject({
      ok: false,
      code: "r2_not_configured",
    });
  });
});

describe("状态", () => {
  it("没发布过 ⇒ active 为 null；发过 ⇒ active 与版本列表一致", async () => {
    await seedTemplate();
    expect((await siteState(env, TENANT)).active).toBeNull();

    await publishSite(env, TENANT, { apiBase: BASE });
    const state = await siteState(env, TENANT);
    expect(state.active).toBe(1);
    expect(state.versions[0]).toMatchObject({ seq: 1, template: "basic" });
    expect(state.templateReady).toBe(true);
  });
});

describe("config.js：发布时注入 CRM 地址", () => {
  it("产物里的 config.js 是注入后的，不是模板占位", async () => {
    await seedTemplate({
      "index.html": "<!doctype html><h1>Hello</h1>",
      "config.js": 'window.CRM_API_BASE = "https://crm.example.com";',
    });

    await publishSite(env, TENANT, { apiBase: BASE });

    const js = await SITES.get(`sites/${TENANT}/versions/1/public/config.js`);
    const body = (await js?.text()) ?? "";
    expect(body).toContain(BASE);
    // 占位值必须消失：它是"站点发上去了但 API 全挂"的典型原因
    expect(body).not.toContain("crm.example.com");
  });

  it("没给 apiBase ⇒ 直接拒绝，不写产物", async () => {
    await seedTemplate();
    const result = await publishSite(env, TENANT, {});
    expect(result).toMatchObject({ ok: false, code: "api_base_missing" });
    expect(await HOSTS.get(activeKey(TENANT))).toBeNull();
  });
});

describe("站点设置：单行 JSON + rev 乐观锁", () => {
  it("校验：色值、邮箱、长度、未知字段", async () => {
    expect(
      await saveSiteSettings(env, { values: { site: { theme: { brand: "red" } } } }),
    ).toMatchObject({ ok: false, code: "bad_color" });
    expect(
      await saveSiteSettings(env, { values: { site: { contact_email: "nope" } } }),
    ).toMatchObject({ ok: false, code: "bad_email" });
    expect(
      await saveSiteSettings(env, { values: { site: { name: "x".repeat(41) } } }),
    ).toMatchObject({ ok: false, code: "too_long" });
    expect(
      await saveSiteSettings(env, { values: { site: { nickname: "x" } } }),
    ).toMatchObject({ ok: false, code: "unknown_field" });
  });

  it("整份替换、rev 递增、永远只有一行", async () => {
    const a = await saveSiteSettings(env, { values: { site: { name: "Acme VPN" } } });
    expect(a.ok && a.settings.rev).toBe(1);
    const b = await saveSiteSettings(env, {
      values: { site: { name: "Acme 2", tagline: "快" } },
    });
    expect(b.ok && b.settings.rev).toBe(2);
    const got = await readSiteSettings(env);
    expect(got.values).toMatchObject({ site: { name: "Acme 2", tagline: "快" } });
    const rows = await env.DB.prepare(
      "SELECT COUNT(*) AS c FROM site_settings",
    ).first<{ c: number }>();
    expect(rows?.c).toBe(1);
  });

  it("rev 不匹配 ⇒ rev_conflict（后台与 studio 同时改）", async () => {
    const first = await saveSiteSettings(env, { values: { site: { name: "A" } } });
    const rev = first.ok ? first.settings.rev : 0;
    expect(
      await saveSiteSettings(env, { ifRev: rev - 1, values: { site: { name: "B" } } }),
    ).toMatchObject({ ok: false, code: "rev_conflict" });
    expect(
      await saveSiteSettings(env, { ifRev: rev, values: { site: { name: "B" } } }),
    ).toMatchObject({ ok: true });
  });
});

describe("发布：把设置烘焙进产物", () => {
  it("占位符替换；没设的用兜底名与默认文案", async () => {
    await seedTemplate({
      "index.html":
        "<title>{{site.name}}</title><h1>{{site.hero.title}}</h1><footer>{{site.footer}}</footer>",
    });
    await saveSiteSettings(env, { values: { site: { name: "Acme VPN" } } });

    const r = await publishSite(env, TENANT, { apiBase: BASE });
    expect(r.ok).toBe(true);

    const html = await (
      await SITES.get(`sites/${TENANT}/versions/1/public/index.html`)
    )?.text();
    expect(html).toContain("<title>Acme VPN</title>");
    // 标题留空 ⇒ 默认文案，首页不会出现空 h1
    expect(html).toContain("<h1>连通世界，只需要一次点击。</h1>");
    // 版权行没设 ⇒ 自动生成，且带当前年份
    expect(html).toMatch(/© \d{4} Acme VPN/);
  });

  it("模板用了没有数据的路径 ⇒ 发布被拦，线上不变", async () => {
    await seedTemplate({ "index.html": "<h1>{{site.nickname}}</h1>" });
    const r = await publishSite(env, TENANT, { apiBase: BASE });
    expect(r).toMatchObject({ ok: false, code: "template_token_unknown" });
    expect(await HOSTS.get(activeKey(TENANT))).toBeNull();
  });

  it("主题色留空 ⇒ 回落默认色（否则 `--brand: ;` 整份 CSS 失效）", async () => {
    await seedTemplate({
      "index.html": "<h1>{{site.name}}</h1>",
      "site.css": ":root{--brand: {{site.theme.brand}};}",
    });
    await saveSiteSettings(env, { values: { site: { name: "Acme" } } });

    await publishSite(env, TENANT, { apiBase: BASE });
    const css = await (
      await SITES.get(`sites/${TENANT}/versions/1/public/site.css`)
    )?.text();
    expect(css).toContain("--brand: #4f46e5");
  });

  it("配了客服邮箱 ⇒ 页脚出现 mailto；没配 ⇒ 整段链接消失", async () => {
    await seedTemplate({
      "index.html":
        '<footer><a data-if="site.contact_email" href="mailto:{{site.contact_email}}">联系我们</a></footer>',
    });

    await publishSite(env, TENANT, { apiBase: BASE });
    let html = await (
      await SITES.get(`sites/${TENANT}/versions/1/public/index.html`)
    )?.text();
    expect(html).toContain("<footer></footer>");

    await saveSiteSettings(env, {
      values: { site: { name: "Acme", contact_email: "help@acme.test" } },
    });
    await publishSite(env, TENANT, { apiBase: BASE });
    html = await (
      await SITES.get(`sites/${TENANT}/versions/2/public/index.html`)
    )?.text();
    expect(html).toContain('href="mailto:help@acme.test"');
    expect(html).toContain("联系我们");
  });

  it("设置值过 HTML 转义（站点名里能放引号，不会破坏属性）", async () => {
    await seedTemplate({
      "index.html": '<h1 title="{{site.name}}">{{site.name}}</h1>',
    });
    await saveSiteSettings(env, {
      values: { site: { name: '快 <script>不稳</h1>"' } },
    });

    await publishSite(env, TENANT, { apiBase: BASE });
    const html = await (
      await SITES.get(`sites/${TENANT}/versions/1/public/index.html`)
    )?.text();
    expect(html).toContain(
      '<h1 title="快 &lt;script&gt;不稳&lt;/h1&gt;&quot;">快 &lt;script&gt;不稳&lt;/h1&gt;&quot;</h1>',
    );
  });
});
