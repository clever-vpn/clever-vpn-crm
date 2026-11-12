/**
 * 站点资产：元数据进 D1、字节进 R2。
 *
 * 断言的重点：
 *   1. **先 R2 后 D1** —— 反过来的话，列表里会出现指向不存在对象的坏图；
 *   2. 上限与类型是真拦，不是只写在注释里；
 *   3. **软删除**：删掉的行不再出现在列表里，但 R2 的字节还在（已发布版本可能还
 *      在引用它）。
 */
import { beforeEach, describe, expect, it } from "vitest";

import { env } from "./apply-migrations";
import {
  ASSET_LIMITS,
  deleteSiteAsset,
  getSiteAsset,
  listSiteAssets,
  putSiteAsset,
  readSiteAssetBytes,
} from "../../src/site/assets";

const TENANT = "77";
const SITES: R2Bucket = env.SITES!;

/** 一个最小的合法 PNG 头（内容不重要，存的是字节） */
const png = (n = 64): Uint8Array => {
  const bytes = new Uint8Array(n);
  bytes.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 0);
  for (let i = 8; i < n; i += 1) bytes[i] = i % 251;
  return bytes;
};

beforeEach(async () => {
  await env.DB.prepare(`DELETE FROM site_assets WHERE tenant_id = ?`).bind(TENANT).run();
  const listed = await SITES.list({ prefix: `assets/${TENANT}/` });
  for (const obj of listed.objects) await SITES.delete(obj.key);
});

describe('putSiteAsset', () => {
  it('存进去之后能列出、能读回字节、元数据齐全', async () => {
    const put = await putSiteAsset(env, TENANT, {
      kind: "logo",
      name: "logo.png",
      mime: "image/png",
      bytes: png(128),
    });
    expect(put.ok).toBe(true);
    if (!put.ok) return;

    expect(put.value.id).toMatch(/^a_[0-9a-f]{12}$/);
    expect(put.value.bytes).toBe(128);
    expect(put.value.sha256).toMatch(/^[0-9a-f]{64}$/);

    const list = await listSiteAssets(env, TENANT);
    expect(list.map((a) => a.id)).toEqual([put.value.id]);

    const obj = await readSiteAssetBytes(env, TENANT, put.value.id);
    expect(obj).not.toBeNull();
    expect(obj!.httpMetadata?.contentType).toBe("image/png");
    expect(new Uint8Array(await obj!.arrayBuffer()).byteLength).toBe(128);
  });

  it('先写 R2 再写 D1：R2 里对象存在，D1 里才有行', async () => {
    const put = await putSiteAsset(env, TENANT, { mime: "image/png", bytes: png() });
    expect(put.ok).toBe(true);
    if (!put.ok) return;
    const obj = await SITES.head(`assets/${TENANT}/${put.value.id}.png`);
    expect(obj).not.toBeNull();
  });

  it('不收的类型 / 空文件 / 超限都被拦下，且不留半份数据', async () => {
    const bad = await putSiteAsset(env, TENANT, {
      mime: "application/pdf",
      bytes: png(),
    });
    expect(bad.ok).toBe(false);
    if (!bad.ok) expect(bad.code).toBe("asset_mime_unsupported");

    const empty = await putSiteAsset(env, TENANT, { mime: "image/png", bytes: new Uint8Array(0) });
    expect(empty.ok).toBe(false);
    if (!empty.ok) expect(empty.code).toBe("asset_empty");

    const huge = await putSiteAsset(env, TENANT, {
      mime: "image/png",
      bytes: png(ASSET_LIMITS.bytes + 1),
    });
    expect(huge.ok).toBe(false);
    if (!huge.ok) expect(huge.code).toBe("asset_too_large");

    expect(await listSiteAssets(env, TENANT)).toHaveLength(0);
  });

  it('数量上限是真的拦（软删除的不算占位）', async () => {
    const ids: string[] = [];
    for (let i = 0; i < ASSET_LIMITS.perTenant; i += 1) {
      const r = await putSiteAsset(env, TENANT, { mime: "image/png", bytes: png(16 + i) });
      expect(r.ok).toBe(true);
      if (r.ok) ids.push(r.value.id);
    }
    const over = await putSiteAsset(env, TENANT, { mime: "image/png", bytes: png(999) });
    expect(over.ok).toBe(false);
    if (!over.ok) expect(over.code).toBe("asset_quota_exceeded");

    // 删掉一个就能再存一个
    expect(await deleteSiteAsset(env, TENANT, ids[0]!)).toBe(true);
    const again = await putSiteAsset(env, TENANT, { mime: "image/png", bytes: png(999) });
    expect(again.ok).toBe(true);
  });

  it('svg 也收（矢量 logo 是常见情形）', async () => {
    const svg = new TextEncoder().encode('<svg xmlns="http://www.w3.org/2000/svg"/>');
    const put = await putSiteAsset(env, TENANT, {
      mime: "image/svg+xml; charset=utf-8",
      bytes: svg,
    });
    expect(put.ok).toBe(true);
    if (put.ok) expect(put.value.mime).toBe("image/svg+xml");
  });
});

describe('deleteSiteAsset', () => {
  it('软删除：列表里没了、读不到，但 R2 的字节还在', async () => {
    const put = await putSiteAsset(env, TENANT, { mime: "image/png", bytes: png() });
    expect(put.ok).toBe(true);
    if (!put.ok) return;

    expect(await deleteSiteAsset(env, TENANT, put.value.id)).toBe(true);
    expect(await listSiteAssets(env, TENANT)).toHaveLength(0);
    expect(await getSiteAsset(env, TENANT, put.value.id)).toBeNull();
    // 已发布版本可能还在引用：字节不能没
    expect(await SITES.head(`assets/${TENANT}/${put.value.id}.png`)).not.toBeNull();
  });

  it('重复删除是幂等的（第二次返回 false，不报错）', async () => {
    const put = await putSiteAsset(env, TENANT, { mime: "image/png", bytes: png() });
    expect(put.ok).toBe(true);
    if (!put.ok) return;
    expect(await deleteSiteAsset(env, TENANT, put.value.id)).toBe(true);
    expect(await deleteSiteAsset(env, TENANT, put.value.id)).toBe(false);
  });

  it('别的租户删不掉（租户隔离）', async () => {
    const put = await putSiteAsset(env, TENANT, { mime: "image/png", bytes: png() });
    expect(put.ok).toBe(true);
    if (!put.ok) return;
    expect(await deleteSiteAsset(env, "other", put.value.id)).toBe(false);
    expect(await listSiteAssets(env, TENANT)).toHaveLength(1);
  });
});
