/**
 * 平台子域的解析：`{slug}.<SITE_ZONE>` / `{slug}.<ADMIN_ZONE>`。
 *
 * 契约 `cf-api-hosting` §2：平台子域**不进** `host:` 映射，而是由后缀取 slug，
 * 再查 registry（内存 → KV `slug:` → D1）。这样"绑了自定义域"不会让二级域失效。
 */
import { describe, expect, it } from 'vitest';

import site, { platformSlug as siteSlug } from '../workers/site/src/index';
import { platformSlug as routerSlug } from '../workers/router/src/index';

const r2 = () => ({
  async head() {
    return { httpEtag: '"e"', httpMetadata: { contentType: 'text/html; charset=utf-8' } };
  },
  async get() {
    return {
      body: new Response('<h1>ok</h1>').body,
      httpEtag: '"e"',
      httpMetadata: { contentType: 'text/html; charset=utf-8' },
    };
  },
});

/** 只实现这条链路用到的读 */
const kv = (data: Record<string, unknown>) =>
  ({
    async get(key: string) {
      return data[key] === undefined ? null : data[key];
    },
    async put() {},
    async delete() {},
  }) as unknown as KVNamespace;

const d1 = (row: Record<string, unknown> | null) =>
  ({
    prepare() {
      return {
        bind() {
          return { async first() { return row; } };
        },
      };
    },
  }) as unknown as D1Database;

const request = (host: string) => new Request(`https://${host}/`);

describe('platformSlug：只认一级 <slug>.<zone>', () => {
  for (const fn of [siteSlug, routerSlug]) {
    it('正常 slug', () => {
      expect(fn('acme.clever-link.win', 'clever-link.win')).toBe('acme');
      expect(fn('a-b.clever-link.win', 'clever-link.win')).toBe('a-b');
    });
    it('不是这个 zone / 多级子域 / 非法字符 ⇒ null', () => {
      expect(fn('acme.other.com', 'clever-link.win')).toBeNull();
      expect(fn('a.b.clever-link.win', 'clever-link.win')).toBeNull();
      expect(fn('clever-link.win', 'clever-link.win')).toBeNull();
      expect(fn('-bad.clever-link.win', 'clever-link.win')).toBeNull();
      expect(fn('acme.clever-link.win', '')).toBeNull();
    });
  }
});

describe('site-serve：平台子域按 slug 解析', () => {
  it('KV 里有 slug 缓存 ⇒ 不查 D1', async () => {
    let d1Calls = 0;
    const env = {
      HOSTS: kv({ 'slug:acme': { tenant_id: '7', status: 'active' } }),
      SITES: r2(),
      SITE_ZONE: 'clever-link.win',
      REGISTRY: {
        prepare() {
          d1Calls += 1;
          return { bind: () => ({ first: async () => null }) };
        },
      },
      ADMIN_ZONE: 'clever-panel.win',
    };
    // 指针也要有，才能真的吐页面
    (env.HOSTS as unknown as { get: (k: string) => unknown }).get = async (key: string) => {
      if (key === 'slug:acme') return { tenant_id: '7', status: 'active' };
      if (key === 'site:7:active') return { templateSeq: 1, artifactSha: 'sha256:abc' };
      return null;
    };
    const res = await site.fetch(request('acme.clever-link.win'), env as never);
    expect(res.status).toBe(200);
    expect(d1Calls).toBe(0);
  });

  it('KV 没有 ⇒ 查 D1；D1 也没有 ⇒ 404', async () => {
    const env = {
      HOSTS: kv({}),
      SITES: r2(),
      SITE_ZONE: 'clever-link.win',
      REGISTRY: d1({ id: 9, status: 'active' }),
    };
    const res = await site.fetch(request('acme2.clever-link.win'), env as never);
    // 查到 tenant 了，但没发布过 ⇒ 404「站点尚未发布」（不是"未知域名"）
    expect(res.status).toBe(404);
    expect(await res.text()).toContain('尚未发布');
  });

  it('suspended ⇒ 410', async () => {
    const env = {
      HOSTS: kv({}),
      SITES: r2(),
      SITE_ZONE: 'clever-link.win',
      REGISTRY: d1({ id: 9, status: 'suspended' }),
    };
    const res = await site.fetch(request('acme3.clever-link.win'), env as never);
    expect(res.status).toBe(410);
  });
});
