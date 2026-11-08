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

const TENANT = "42";

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

    const result = await publishSite(env, TENANT, { actor: "admin@test" });
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
    await publishSite(env, TENANT, {});
    await publishSite(env, TENANT, {});

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
    await publishSite(env, TENANT, {});
    // 清掉模板，模拟"没上传模板就点发布"
    const listed = await SITES.list({ prefix: "g/templates/basic/" });
    for (const o of listed.objects) await SITES.delete(o.key);

    const again = await publishSite(env, TENANT, {});
    expect(again).toMatchObject({ ok: false, code: "template_missing" });
    // 关键：线上仍是 1，不是"半成品 2"
    expect(await HOSTS.get(activeKey(TENANT), "json")).toEqual({ n: 1 });
  });

  it("L0 失败 ⇒ 不写产物、不记账、不切指针", async () => {
    await seedTemplate({ "style.css": "h1{color:red}" }); // 没有 index.html

    const result = await publishSite(env, TENANT, {});
    expect(result).toMatchObject({ ok: false, code: "l0_failed" });
    expect(await HOSTS.get(activeKey(TENANT))).toBeNull();

    const rows = await env.DB.prepare(
      "SELECT COUNT(*) AS c FROM site_versions",
    ).first<{ c: number }>();
    expect(rows?.c).toBe(0);
  });

  it("没有绑定 R2 ⇒ 报 r2_not_configured，而不是静默成功", async () => {
    const bare = { ...env, SITES: undefined };
    expect(await publishSite(bare as never, TENANT, {})).toMatchObject({
      ok: false,
      code: "r2_not_configured",
    });
  });
});

describe("状态", () => {
  it("没发布过 ⇒ active 为 null；发过 ⇒ active 与版本列表一致", async () => {
    await seedTemplate();
    expect((await siteState(env, TENANT)).active).toBeNull();

    await publishSite(env, TENANT, {});
    const state = await siteState(env, TENANT);
    expect(state.active).toBe(1);
    expect(state.versions[0]).toMatchObject({ seq: 1, template: "basic" });
    expect(state.templateReady).toBe(true);
  });
});
