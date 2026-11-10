/**
 * 模板版本库：`tpl/<sha>/` 内容寻址 + `site_templates` 记账 + 指针。
 *
 * 断言的重点不是"函数能跑通"，而是契约 §4/§5/§9 那几条纪律真的成立：
 *
 *   1. **幂等**：同内容交付两次，版本号不变、只多一个 R2 前缀（不带时间戳）。
 *   2. **内容寻址**：不同内容 = 不同 sha = 不同前缀；同一份内容在两个租户下共用前缀。
 *   3. **版本不可变**：再交付不改写已有 `tpl/<sha>/` 的任何字节。
 *   4. **指针**：交付即成为 `site_settings.template_version`，且 rev 递增（乐观锁）。
 *   5. **越界拒绝**：`..` / 绝对路径 / 反斜杠在写 R2 之前就被挡住，不留半份。
 */
import { beforeEach, describe, expect, it } from "vitest";

import { env } from "./apply-migrations";
import {
  checkTemplatePath,
  describeFiles,
  listTemplateVersions,
  packageSha,
  readTemplateFiles,
  readTemplateVersion,
  storeTemplate,
  stripSha,
  tplPrefix,
} from "../../src/site/templates";

const TENANT = "42";
const SITES: R2Bucket = env.SITES!;

const INDEX = "<!doctype html><html><head><title>t</title></head><body><h1>Hi</h1></body></html>";
const CSS = "h1{color:red}";

const files = (extra: Record<string, string> = {}) => [
  { path: "index.html", body: INDEX },
  { path: "assets/site.css", body: CSS },
  ...Object.entries(extra).map(([path, body]) => ({ path, body })),
];

beforeEach(async () => {
  // 每个用例从干净的模板库开始（同一个 test 文件共用一个 D1）
  await env.DB.prepare("DELETE FROM site_templates").run();
  await env.DB.prepare("UPDATE site_settings SET template_version = '', rev = 0 WHERE id = 1").run();
  const listed = await SITES.list({ prefix: "tpl/", limit: 1000 });
  if (listed.objects.length > 0) {
    await SITES.delete(listed.objects.map((o) => o.key));
  }
  await env.DB.prepare(
    "INSERT INTO site_settings (id, updated_at) VALUES (1, '') ON CONFLICT(id) DO NOTHING",
  ).run();
});

describe("路径与指纹", () => {
  it("拒绝越界路径（写 R2 之前就挡住）", () => {
    for (const bad of ["", "/etc/passwd", "../x.html", "a/../../x", "a\\b.html", "a//b.html", "a/./b"]) {
      expect(checkTemplatePath(bad), bad).not.toBeNull();
    }
    expect(checkTemplatePath("assets/site.css")).toBeNull();
  });

  it("同内容同 sha，且与文件顺序无关", async () => {
    const a = await describeFiles(files());
    const b = await describeFiles([...files()].reverse());
    expect(a.ok && b.ok).toBe(true);
    if (!a.ok || !b.ok) return;
    expect(await packageSha(a.entries)).toBe(await packageSha(b.entries));
  });

  it("内容变了 sha 就变", async () => {
    const a = await describeFiles(files());
    const b = await describeFiles(files({ "extra.txt": "x" }));
    if (!a.ok || !b.ok) throw new Error("fixture invalid");
    expect(await packageSha(a.entries)).not.toBe(await packageSha(b.entries));
  });

  it("空包与超单文件上限都拒收", async () => {
    const empty = await describeFiles([]);
    expect(empty.ok).toBe(false);

    // 单文件上限是 2 MB，这里比它多 1 字节
    const huge = await describeFiles([
      { path: "big.txt", body: new Uint8Array((2 << 20) + 1).fill(0x61) },
    ]);
    expect(huge.ok ? "" : huge.code).toBe("site_bundle_too_large");
  });
});

describe("交付（storeTemplate）", () => {
  it("第一次交付 = v1，写进 tpl/<sha>/files/…，并把指针指向 v1", async () => {
    const result = await storeTemplate(env, TENANT, { files: files(), engine: "1.4.0", actor: "a@b.c" });
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.version).toBe("v1");
    expect(result.idempotent).toBe(false);

    const listed = await SITES.list({ prefix: `${tplPrefix(result.sha)}files/` });
    expect(listed.objects.map((o) => o.key.slice(tplPrefix(result.sha).length)).sort()).toEqual([
      "files/assets/site.css",
      "files/index.html",
    ]);

    const row = await env.DB.prepare("SELECT * FROM site_templates WHERE tenant_id = ?").bind(TENANT).first();
    expect(row?.version).toBe("v1");
    expect(row?.sha).toBe(result.sha);
    expect(row?.files).toBe(2);

    const pointer = await env.DB.prepare("SELECT template_version, rev FROM site_settings WHERE id = 1").first<{
      template_version: string;
      rev: number;
    }>();
    expect(pointer?.template_version).toBe("v1");
    // 指针与数据设置同表，一起参与乐观锁 ⇒ 交付会推进 rev
    expect(Number(pointer?.rev)).toBeGreaterThan(0);
  });

  it("同内容重复交付：版本号不变，idempotent=true，不多写一行", async () => {
    const first = await storeTemplate(env, TENANT, { files: files(), engine: "1.4.0" });
    const second = await storeTemplate(env, TENANT, { files: files(), engine: "1.4.0" });
    if (!first.ok || !second.ok) throw new Error("store failed");

    expect(second.version).toBe(first.version);
    expect(second.sha).toBe(first.sha);
    expect(second.idempotent).toBe(true);

    const count = await env.DB.prepare("SELECT COUNT(*) AS n FROM site_templates WHERE tenant_id = ?")
      .bind(TENANT)
      .first<{ n: number }>();
    expect(Number(count?.n)).toBe(1);
  });

  it("改了内容 = 新版本 v2，父 sha 指向前一版，旧前缀一个字节都没动", async () => {
    const v1 = await storeTemplate(env, TENANT, { files: files(), engine: "1.4.0" });
    if (!v1.ok) throw new Error("v1 failed");
    const before = await readTemplateFiles(env, v1.sha);

    const v2 = await storeTemplate(env, TENANT, {
      files: files({ "extra.txt": "hello" }),
      engine: "1.4.0",
      basePackage: v1.sha,
    });
    if (!v2.ok) throw new Error("v2 failed");

    expect(v2.version).toBe("v2");
    expect(v2.sha).not.toBe(v1.sha);

    const row = await readTemplateVersion(env, TENANT, "v2");
    expect(row?.parent_sha).toBe(v1.sha);

    const after = await readTemplateFiles(env, v1.sha);
    expect(after.map((f) => [f.path, new TextDecoder().decode(f.body)])).toEqual(
      before.map((f) => [f.path, new TextDecoder().decode(f.body)]),
    );

    const pointer = await env.DB.prepare("SELECT template_version FROM site_settings WHERE id = 1").first<{
      template_version: string;
    }>();
    expect(pointer?.template_version).toBe("v2");
  });

  it("内容寻址：两个租户同样的包共用一个前缀，但各有自己的版本号", async () => {
    const a = await storeTemplate(env, "A", { files: files(), engine: "1.4.0" });
    const b = await storeTemplate(env, "B", { files: files(), engine: "1.4.0" });
    if (!a.ok || !b.ok) throw new Error("store failed");

    expect(a.sha).toBe(b.sha);
    expect(a.version).toBe("v1");
    expect(b.version).toBe("v1");

    const prefixes = await SITES.list({ prefix: "tpl/", delimiter: "/" });
    const tops = new Set((prefixes.delimitedPrefixes ?? []).map((p) => p.split("/")[1]));
    expect(tops.size).toBe(1);
    expect(tops.has(stripSha(a.sha))).toBe(true);
  });

  it("指针为空时 readTemplateVersion 返回 null；列表最新在前", async () => {
    expect(await readTemplateVersion(env, TENANT)).toBeNull();

    await storeTemplate(env, TENANT, { files: files(), engine: "1.4.0" });
    await storeTemplate(env, TENANT, { files: files({ "a.txt": "1" }), engine: "1.4.0" });
    const list = await listTemplateVersions(env, TENANT);
    expect(list.map((v) => v.version)).toEqual(["v2", "v1"]);
    expect((await readTemplateVersion(env, TENANT))?.version).toBe("v2");
  });

  it("越界路径整包拒收：不留 R2 对象，不写行", async () => {
    const bad = await storeTemplate(env, TENANT, {
      files: [{ path: "index.html", body: INDEX }, { path: "../escape.html", body: "x" }],
      engine: "1.4.0",
    });
    expect(bad.ok ? "" : bad.code).toBe("site_path_rejected");

    const listed = await SITES.list({ prefix: "tpl/" });
    expect(listed.objects).toHaveLength(0);
    const count = await env.DB.prepare("SELECT COUNT(*) AS n FROM site_templates").first<{ n: number }>();
    expect(Number(count?.n)).toBe(0);
  });
});
