/**
 * site-serve：客户站点的出口 Worker。
 *
 * 这里唯一容易错、错了又"看不出来"的地方是**指针 → R2 键**的映射：
 * 产物按内容寻址（`art/<artifact_sha>/`），指针换了但键拼错 ⇒ 整站 404，
 * 而 CRM 那边一切正常（发布成功、产物也写了），排障会一开始就查错方向。
 *
 * 没有真 workerd 绑定：KV / R2 用最小的假对象（只实现这一条链路用到的三个方法）。
 */
import { describe, expect, it } from 'vitest';

import site from '../../workers/site/src/index';

/**
 * 每个用例用**自己的 host + tenant**：worker 里有 60 s / 5 s 的 isolate 内存缓存
 * （`remembered()`），共用同一个 host 会让第二个用例读到第一个的指针。
 */
function kv(pointer: unknown, host: string, tenant: string): KVNamespace {
  return {
    async get(key: string) {
      if (key === `host:${host}`) return { tenant_id: tenant, status: 'active' };
      if (key === `site:${tenant}:active`) return pointer;
      return null;
    },
  } as unknown as KVNamespace;
}

/** 最小 R2：按 key 前缀返回固定字节，并记下被读过的 key */
function r2() {
  const reads: string[] = [];
  return {
    reads,
    async head(key: string) {
      reads.push(`head ${key}`);
      return { httpEtag: '"etag-1"', httpMetadata: { contentType: 'text/html; charset=utf-8' } };
    },
    async get(key: string) {
      reads.push(`get ${key}`);
      return {
        body: new Response(`<h1>${key}</h1>`).body,
        httpEtag: '"etag-1"',
        httpMetadata: { contentType: 'text/html; charset=utf-8' },
      };
    },
  };
}

const request = (host: string, path: string, method = 'GET') =>
  new Request(`https://${host}${path}`, { method });

describe('site-serve 读的是内容寻址的产物', () => {
  it('指针里的 artifact_sha 决定 R2 键（`art/<hex>/`，不带 sha256: 前缀）', async () => {
    const host = 'a.example.com';
    const bucket = r2();
    const env = { HOSTS: kv({ templateSeq: 3, artifactSha: 'sha256:abc123' }, host, '1'), SITES: bucket };
    const res = await site.fetch(request(host, '/index.html'), env as never);

    expect(res.status).toBe(200);
    expect(bucket.reads).toContain('get art/abc123/index.html');
    expect(await res.text()).toContain('art/abc123/index.html');
    // 版本号只用于展示/排障，不参与取文件
    expect(res.headers.get('x-site-version')).toBe('3');
    expect(res.headers.get('x-site-artifact')).toBe('sha256:abc123');
  });

  it('设置改了重新烘焙 ⇒ 还是同一个设计版本，但读的是新目录', async () => {
    const host = 'b.example.com';
    const bucket = r2();
    const env = { HOSTS: kv({ templateSeq: 3, artifactSha: 'sha256:def456' }, host, '2'), SITES: bucket };
    const res = await site.fetch(request(host, '/'), env as never);

    expect(res.status).toBe(200);
    // 根路径按 index.html 取
    expect(bucket.reads).toContain('get art/def456/index.html');
    expect(res.headers.get('x-site-version')).toBe('3');
  });

  it('从没发布过 ⇒ 404「站点尚未发布」，而不是去读一个不存在的目录', async () => {
    const host = 'c.example.com';
    const bucket = r2();
    const env = { HOSTS: kv(null, host, '3'), SITES: bucket };
    const res = await site.fetch(request(host, '/index.html'), env as never);

    expect(res.status).toBe(404);
    expect(bucket.reads).toEqual([]);
  });

  it('指针形状不对（缺 artifact_sha）⇒ 当作没发布', async () => {
    const host = 'd.example.com';
    const bucket = r2();
    const env = { HOSTS: kv({ n: 3 }, host, '4'), SITES: bucket };
    const res = await site.fetch(request(host, '/index.html'), env as never);

    expect(res.status).toBe(404);
    expect(bucket.reads).toEqual([]);
  });

  it('未知 host ⇒ 404，绝不回落默认租户', async () => {
    const bucket = r2();
    const env = { HOSTS: kv({ templateSeq: 1, artifactSha: 'sha256:x' }, 'e.example.com', '5'), SITES: bucket };
    const res = await site.fetch(new Request('https://nobody.example.com/'), env as never);
    expect(res.status).toBe(404);
    expect(bucket.reads).toEqual([]);
  });
});
