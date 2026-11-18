/**
 * 站点发布 / 烘焙：`烘焙（写 art/<sha>/）→ D1 记账 → KV 切指针`
 *
 * 断言的重点不是"函数能跑"，而是**契约里那几条纪律真的成立**：
 *
 *   1. **顺序**：指针最后才切。所以烘焙/发布失败时 KV 里必须还是旧值（线上不受影响）。
 *   2. **产物按内容寻址**：`art/<sha>/` 写进去就不再改 —— 同内容只占一份，
 *      不同内容绝不同目录（设置改了 ⇒ 新 sha）。
 *   3. **L0 闸门在服务端**：studio 可以被绕过，指针一翻就是线上，所以这里必须也拦。
 *   4. **设置改了不产生版本**：`reprintSite()` 只换指针的 `artifact_sha`。
 */
import { beforeEach, describe, expect, it } from "vitest";

import { env } from "./apply-migrations";
import { lintManifest } from "../../src/site/bake";
import {
  activeKey,
  publishSite,
  readPointer,
  reprintSite,
  siteState,
} from "../../src/site/publish";
import { storeSource } from "../../src/site/source";
import {
  buildScope,
  readSiteSettings,
  saveSiteSettings,
} from "../../src/site/settings";

const TENANT = "42";
const BASE = "https://acme.clever-panel.win";

/** 这两个绑定在测试里一定存在（`vitest.workers.config.ts` 注入），断言一次省得满屏 `!` */
const SITES: R2Bucket = env.SITES!;
const HOSTS: KVNamespace = env.HOSTS!;

/**
 * 造一份**租户源包**并写进内容寻址存储，返回它的 sha。
 *
 * Contract 14 之后没有"公共模板目录"这回事：种子在代码里（`seed.generated.ts`），
 * 租户的源包按 `tpl/<sha>/files/` 存。测试里用自己的一份，断言才有意义。
 */
async function sourceOf(
  files: Record<string, string> = {
    "index.html": "<!doctype html><h1>Hello</h1>",
    "assets/app.css": "h1{color:red}",
  },
): Promise<string> {
  const stored = await storeSource(
    env,
    Object.entries(files).map(([path, body]) => ({ path, body })),
  );
  if (!stored.ok) throw new Error(stored.message);
  return stored.sha;
}

/** 产物目录：内容寻址（`art/<sha>/`），sha 由发布/烘焙的返回值给 */
const artOf = (sha: string): string => `art/${sha.replace(/^sha256:/, "")}/`;

const shaOf = (r: { ok: boolean; artifactSha?: string }): string => {
  if (!r.ok || !r.artifactSha) throw new Error("发布/烘焙没有产物");
  return r.artifactSha;
};

beforeEach(async () => {
  // 每个用例从干净状态开始：清模板、清产物、清指针、清账
  for (const prefix of [`sites/${TENANT}/`]) {
    const listed = await SITES.list({ prefix });
    for (const o of listed.objects) await SITES.delete(o.key);
  }
  await HOSTS.delete(activeKey(TENANT));
  await env.DB.prepare("DELETE FROM site_releases").run();
  await env.DB.prepare("DELETE FROM site_pointer_log").run();
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

  it("单文件超 2 MB ⇒ 拦（整版口径，与 meta.limits 同一个数）", () => {
    const issues = lintManifest([
      { key: "index.html", size: 10 },
      { key: "big.png", size: (2 << 20) + 1 },
    ]);
    expect(issues.some((i) => i.includes("单文件超限"))).toBe(true);
  });
});

describe("发布", () => {
  it("模板进、产物出、指针指到 1", async () => {
    const sha = await sourceOf();

    const result = await publishSite(env, TENANT, { sourceSha: sha, actor: "admin@test", apiBase: BASE });
    // 2 个模板文件 + 3 个平台文件（config / SDK / 支付回跳页）
    expect(result).toMatchObject({ ok: true, version: 1, files: 5 });
    const art = artOf(shaOf(result as never));

    // 平台文件随产物烘焙：两个站点出口（自部署 / 托管）都只是读 R2，
    // SDK 只有这一份，不会因为出口实现不同而漂移。
    const sdk = await SITES.get(`${art}_crm/sdk.js`);
    expect(await sdk?.text()).toContain("window.SiteCrm = SiteCrm");
    const back = await SITES.get(`${art}_crm/return.html`);
    expect(await back?.text()).toContain("支付已提交");

    const html = await SITES.get(`${art}index.html`);
    expect(await html?.text()).toContain("Hello");
    // 子目录结构必须保留，否则 assets/app.css 会 404
    expect(await SITES.head(`${art}assets/app.css`)).not.toBeNull();

    // 指针 = { 设计版本, 产物 }：`site-serve` 读它，只认 artifact_sha 取文件
    expect(await readPointer(env, TENANT)).toMatchObject({
      templateSeq: 1,
      artifactSha: shaOf(result as never),
      settingsRev: 0,
    });
  });

  it("同内容再发一版 ⇒ 版本号 +1，但产物只有一份（内容寻址，不重复占字节）", async () => {
    const sha = await sourceOf();
    const first = await publishSite(env, TENANT, { sourceSha: sha, apiBase: BASE });
    const second = await publishSite(env, TENANT, { sourceSha: sha, apiBase: BASE });

    expect(second).toMatchObject({ ok: true, version: 2 });
    // 同样的源包 + 同样的设置 ⇒ 同一个 sha ⇒ 同一个目录
    expect(shaOf(second as never)).toBe(shaOf(first as never));
    expect(await SITES.head(`${artOf(shaOf(first as never))}index.html`)).not.toBeNull();
    expect(await readPointer(env, TENANT)).toMatchObject({ templateSeq: 2 });

    // 两版都在账上（版本号是租户看的数字，与产物去重无关）
    const rows = await env.DB.prepare(
      "SELECT COUNT(*) AS c FROM site_releases",
    ).first<{ c: number }>();
    expect(rows?.c).toBe(2);
  });

  /**
   * 幂等的边界：**只认最新那一版**。
   *
   * 场景来自实测：站点改回三天前的样子再发布 —— 那是一次**新**发布，必须产生新
   * 版本并把指针挪过去。早先按 `idem_key` 全表查，会命中旧那一行，接口回 200 +
   * 旧 seq、指针不动 ⇒ 界面"发布成功"而线上没变。更糟的是那一版若引用了已删的
   * 素材，草稿每次重建都会还原那个死指针，站点就此发不出去。
   */
  it("改回旧内容再发 ⇒ 是新版本，不是幂等命中（指针要跟着动）", async () => {
    const first = await sourceOf({ "index.html": "<!doctype html><h1>第一版</h1>" });
    const second = await sourceOf({ "index.html": "<!doctype html><h1>第二版</h1>" });

    // studio 传的 idem_key 就是内容 sha：内容一样 ⇒ 键一样
    const A = "sha256:content-a";
    const B = "sha256:content-b";

    const a = await publishSite(env, TENANT, { sourceSha: first, idemKey: A, apiBase: BASE });
    const b = await publishSite(env, TENANT, { sourceSha: second, idemKey: B, apiBase: BASE });
    expect(a).toMatchObject({ ok: true, version: 1, idempotent: false });
    expect(b).toMatchObject({ ok: true, version: 2, idempotent: false });

    // 同一份内容连发两次 ⇒ 第二次才是幂等
    const dup = await publishSite(env, TENANT, { sourceSha: second, idemKey: B, apiBase: BASE });
    expect(dup).toMatchObject({ ok: true, version: 2, idempotent: true });

    // 退回第一版：内容虽然和 v1 一样，但要成为 v3 —— 否则线上还停在第二版
    const back = await publishSite(env, TENANT, { sourceSha: first, idemKey: A, apiBase: BASE });
    expect(back).toMatchObject({ ok: true, version: 3, idempotent: false });
    expect(await readPointer(env, TENANT)).toMatchObject({ templateSeq: 3 });
    // 线上的字节 = 第一版（v1 那份产物原样还在，没有被 v2 覆盖过）
    expect(await (await SITES.get(`${artOf(shaOf(back as never))}index.html`))?.text()).toContain(
      "第一版",
    );
  });

  it("源包内容没了 ⇒ 明确报错，指针不动", async () => {
    const sha = await sourceOf();
    await publishSite(env, TENANT, { sourceSha: sha, apiBase: BASE });
    // 清掉源包内容，模拟"内容存储被清过"
    const listed = await SITES.list({ prefix: "tpl/" });
    for (const o of listed.objects) await SITES.delete(o.key);

    const again = await publishSite(env, TENANT, { sourceSha: sha, apiBase: BASE });
    expect(again).toMatchObject({ ok: false, code: "source_missing" });
    // 关键：线上仍是 1，不是"半成品 2"
    expect(await readPointer(env, TENANT)).toMatchObject({ templateSeq: 1 });
  });

  it("L0 失败 ⇒ 不写产物、不记账、不切指针", async () => {
    const sha = await sourceOf({ "style.css": "h1{color:red}" }); // 没有 index.html

    const result = await publishSite(env, TENANT, { sourceSha: sha, apiBase: BASE });
    expect(result).toMatchObject({ ok: false, code: "l0_failed" });
    expect(await readPointer(env, TENANT)).toBeNull();

    const rows = await env.DB.prepare(
      "SELECT COUNT(*) AS c FROM site_releases",
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
    const sha = await sourceOf();
    expect((await siteState(env, TENANT)).active).toBeNull();

    await publishSite(env, TENANT, { sourceSha: sha, apiBase: BASE });
    const state = await siteState(env, TENANT);
    expect(state.active).toBe(1);
    expect(state.sourceFrom).toBe("release:v1");
    expect(state.releases[0]).toMatchObject({ seq: 1, source_sha: sha });
  });
});

describe("平台文件：发布时写 /_crm/config.js", () => {
  it("三个平台文件都在，config.js 写的是本次发布的 CRM 地址", async () => {
    const sha = await sourceOf();

    const r = await publishSite(env, TENANT, { sourceSha: sha, apiBase: BASE });
    const art = artOf(shaOf(r as never));

    // 源包里没有 `_crm/`（L0 直接拒），所以这三个只能由烘焙写
    for (const path of ["_crm/config.js", "_crm/sdk.js", "_crm/return.html"]) {
      const file = await SITES.get(`${art}${path}`);
      expect(file, path).toBeTruthy();
    }

    const body = (await (await SITES.get(`${art}_crm/config.js`))?.text()) ?? "";
    expect(body).toContain(`window.CRM_API_BASE = ${JSON.stringify(BASE)}`);
  });

  it("源包里带 config.js ⇒ 不再被特殊对待，就是普通文件（也不该有人再这么写）", async () => {
    // 契约 contract 6：根 `config.js` 已作废。这里只钉住"发布器不再改写它"，
    // 免得有人以为改它能生效。
    const sha = await sourceOf({
      "index.html": "<!doctype html><h1>Hello</h1>",
      "config.js": 'window.CRM_API_BASE = "https://crm.example.com";',
    });

    const r = await publishSite(env, TENANT, { sourceSha: sha, apiBase: BASE });
    const art = artOf(shaOf(r as never));

    const own = await SITES.get(`${art}config.js`);
    expect((await own?.text()) ?? "").toContain("crm.example.com");
    const platform = await SITES.get(`${art}_crm/config.js`);
    expect((await platform?.text()) ?? "").toContain(BASE);
  });

  it("没给 apiBase ⇒ 直接拒绝，不写产物", async () => {
    const sha = await sourceOf();
    const result = await publishSite(env, TENANT, { sourceSha: sha });
    expect(result).toMatchObject({ ok: false, code: "api_base_missing" });
    expect(await readPointer(env, TENANT)).toBeNull();
  });
});

describe("站点设置：单行 JSON + rev 乐观锁", () => {
  it("校验：色值、邮箱、长度、未知字段", async () => {
    expect(
      await saveSiteSettings(env, { values: { site: { theme: { color: { primary: "red" } } } } }),
    ).toMatchObject({ ok: false, code: "bad_color" });
    expect(
      await saveSiteSettings(env, { values: { site: { contact_email: "nope" } } }),
    ).toMatchObject({ ok: false, code: "bad_email" });
    expect(
      await saveSiteSettings(env, { values: { site: { name: "x".repeat(25) } } }),
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

  it("下载入口是集合：同平台可以挂多个渠道", async () => {
    const r = await saveSiteSettings(env, {
      // `contract: 7`：下载页的补充说明不是设置项了（单页单处，写进 HTML）
      values: {},
      collections: {
        downloads: [
          { platform: "windows", kind: "file", label: "64 位安装包", url: "https://dl.test/win-x64.exe" },
          { platform: "windows", kind: "file", label: "32 位安装包", url: "https://dl.test/win-x86.exe" },
          { platform: "ios", kind: "store", label: "", url: "https://apps.apple.com/app/id1" },
        ],
      },
    });
    expect(r).toMatchObject({ ok: true });

    const got = await readSiteSettings(env);
    // label 留空 ⇒ 按 kind 兜一个，别在页面上留个空按钮
    expect(got.collections.downloads[2]).toMatchObject({
      platform: "ios",
      label: "应用商店",
    });

    const scope = buildScope(got, "兜底") as unknown as {
      site: { download: Record<string, Array<{ label: string; url: string }>> };
    };
    const windows: Array<{ label: string }> = scope.site.download.windows ?? [];
    expect(windows).toHaveLength(2);
    expect(windows[0]?.label).toBe("64 位安装包");
    expect(scope.site.download.macos).toEqual([]);
  });

  it("下载入口的校验：平台/渠道是封闭集合，链接只收 http(s)", async () => {
    const base = { values: {}, collections: { downloads: [] as unknown[] } };
    const save = (item: Record<string, unknown>) =>
      saveSiteSettings(env, {
        ...base,
        collections: { downloads: [item] },
      });

    expect(await save({ platform: "symbian", kind: "store", url: "https://a.b" }))
      .toMatchObject({ ok: false, code: "bad_platform" });
    expect(await save({ platform: "ios", kind: "torrent", url: "https://a.b" }))
      .toMatchObject({ ok: false, code: "bad_kind" });
    for (const bad of ["javascript:alert(1)", "//cdn.example.com/a.dmg", "ftp://x/y", ""]) {
      expect(await save({ platform: "ios", kind: "file", url: bad })).toMatchObject({
        ok: false,
        code: "bad_url",
      });
    }
    expect(
      await saveSiteSettings(env, {
        values: {},
        collections: {
          downloads: Array.from({ length: 21 }, () => ({
            platform: "ios",
            kind: "file",
            url: "https://a.b/c",
          })),
        },
      }),
    ).toMatchObject({ ok: false, code: "too_many" });
  });

  it("只改设置、不传集合 ⇒ 下载入口原样保留", async () => {
    await saveSiteSettings(env, {
      values: { site: { name: "A" } },
      collections: {
        downloads: [{ platform: "macos", kind: "file", url: "https://dl.test/a.dmg" }],
      },
    });
    const r = await saveSiteSettings(env, { values: { site: { name: "B" } } });
    expect(r).toMatchObject({ ok: true });
    const got = await readSiteSettings(env);
    expect(got.collections.downloads).toHaveLength(1);
  });
});

describe("发布：把设置烘焙进产物", () => {
  it("占位符替换；没设的用兜底名与派生版权行", async () => {
    const seed1 = await sourceOf({
      "index.html":
        "<title>{{site.name}}</title><h1>{{site.tagline}}</h1><footer>{{site.footer}}</footer>",
    });
    await saveSiteSettings(env, {
      values: { site: { name: "Acme VPN", tagline: "快、稳、不记日志" } },
    });

    const r = await publishSite(env, TENANT, { sourceSha: seed1, apiBase: BASE });
    expect(r.ok).toBe(true);

    const html = await (await SITES.get(`${artOf(shaOf(r as never))}index.html`))?.text();
    expect(html).toContain("<title>Acme VPN</title>");
    expect(html).toContain("<h1>快、稳、不记日志</h1>");
    // 版权行**不再是设置项**：由站名派生（`contract: 7`）
    expect(html).toMatch(/© \d{4} Acme VPN/);
  });

  it("模板用了没有数据的路径 ⇒ 发布被拦，线上不变", async () => {
    const seed2 = await sourceOf({ "index.html": "<h1>{{site.nickname}}</h1>" });
    const r = await publishSite(env, TENANT, { sourceSha: seed2, apiBase: BASE });
    expect(r).toMatchObject({ ok: false, code: "template_token_unknown" });
    expect(await readPointer(env, TENANT)).toBeNull();
  });

  it("主题色留空 ⇒ 回落默认色（否则 `--brand: ;` 整份 CSS 失效）", async () => {
    const seed3 = await sourceOf({
      "index.html": "<h1>{{site.name}}</h1>",
      "site.css": ":root{--brand: {{site.theme.color.primary}};}",
    });
    await saveSiteSettings(env, { values: { site: { name: "Acme" } } });

    const r = await publishSite(env, TENANT, { sourceSha: seed3, apiBase: BASE });
    const css = await (await SITES.get(`${artOf(shaOf(r as never))}site.css`))?.text();
    expect(css).toContain("--brand: #4f46e5");
  });

  it("配了客服邮箱 ⇒ 页脚出现 mailto；没配 ⇒ 整段链接消失", async () => {
    const seed4 = await sourceOf({
      "index.html":
        '<footer><a data-if="site.contact_email" href="mailto:{{site.contact_email}}">联系我们</a></footer>',
    });
    await saveSiteSettings(env, {
      values: { site: { name: "Acme", contact_email: "help@acme.test" } },
    });

    const r = await publishSite(env, TENANT, { sourceSha: seed4, apiBase: BASE });
    const html = await (await SITES.get(`${artOf(shaOf(r as never))}index.html`))?.text();
    expect(html).toContain('href="mailto:help@acme.test"');
    expect(html).toContain("联系我们");

    // 清掉邮箱再烘焙：`data-if` 判空 ⇒ 整段链接消失
    await saveSiteSettings(env, { values: { site: { name: "Acme" } } });
    const again = await reprintSite(env, TENANT, { apiBase: BASE });
    expect(again).toMatchObject({ ok: true, baked: true });
    const html2 = await (
      await SITES.get(`${artOf((again as { artifactSha: string }).artifactSha)}index.html`)
    )?.text();
    expect(html2).toContain("<footer></footer>");
  });

  it("设置值过 HTML 转义（站点名里能放引号，不会破坏属性）", async () => {
    const seed5 = await sourceOf({
      "index.html": '<h1 title="{{site.name}}">{{site.name}}</h1>',
    });
    await saveSiteSettings(env, {
      values: { site: { name: '快 <script>不稳</h1>"' } },
    });

    const r = await publishSite(env, TENANT, { sourceSha: seed5, apiBase: BASE });
    const html = await (await SITES.get(`${artOf(shaOf(r as never))}index.html`))?.text();
    expect(html).toContain(
      '<h1 title="快 &lt;script&gt;不稳&lt;/h1&gt;&quot;">快 &lt;script&gt;不稳&lt;/h1&gt;&quot;</h1>',
    );
  });
});

/**
 * 图片的路径**就是 URL**（2026-11-13 起）。
 *
 * 早先发布时会按内容把 `assets/logo.png` 改成 `assets/logo.9f2c1a8b.png` 并把
 * HTML / CSS 里的引用一起改写。代价是"租户看到的路径"和"线上地址"不一致，发布
 * 还要多一趟改写 —— 对一个品牌站十来张图来说不值。
 *
 * 现在这条要盯住两件事：
 *   · 产物里**还是那个路径**（否则租户按路径取图会 404）；
 *   · 文本引用**不被改动**（否则两处路径漂移，改完这一版下版就找不到了）。
 * 缓存失效靠 `must-revalidate` + ETag（见 `workers/site`），不再靠换文件名。
 */
describe("图片路径即 URL", () => {
  const PNG_A = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 1, 2, 3, 4]);
  const PNG_B = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 9, 9, 9, 9]);

  async function publishWith(png: Uint8Array): Promise<string> {
    const stored = await storeSource(env, [
      { path: "index.html", body: '<!doctype html><img src="assets/logo.png">' },
      { path: "assets/site.css", body: ".hero{background:url(assets/logo.png)}" },
      { path: "assets/logo.png", body: png },
    ]);
    if (!stored.ok) throw new Error(stored.message);
    const res = await publishSite(env, TENANT, {
      sourceSha: stored.sha,
      apiBase: BASE,
      idemKey: `path-${Date.now()}-${Math.random()}`,
    });
    if (!res.ok) throw new Error(res.message);
    return res.artifactSha;
  }

  it("产物里路径不变、引用不改写", async () => {
    const prefix = artOf(await publishWith(PNG_A));

    const listed = await SITES.list({ prefix: `${prefix}assets/` });
    const keys = listed.objects.map((o) => o.key.slice(prefix.length)).sort();
    expect(keys).toEqual(["assets/logo.png", "assets/site.css"]);

    const html = await (await SITES.get(`${prefix}index.html`))!.text();
    expect(html).toContain('src="assets/logo.png"');

    const css = await (await SITES.get(`${prefix}assets/site.css`))!.text();
    expect(css).toContain("url(assets/logo.png)");
  });

  it("改了字节 ⇒ 新产物里是**同一个路径**的新字节（靠 revalidate 生效）", async () => {
    const a = await publishWith(PNG_A);
    const b = await publishWith(PNG_B);
    // 字节变了 ⇒ 整版 sha 必须变（否则两份内容会撞进同一个 art/ 目录）
    expect(a).not.toBe(b);
    const read = async (sha: string) =>
      new Uint8Array(await (await SITES.get(`${artOf(sha)}assets/logo.png`))!.arrayBuffer());
    expect(Array.from(await read(a))).toEqual(Array.from(PNG_A));
    expect(Array.from(await read(b))).toEqual(Array.from(PNG_B));
  });
});
