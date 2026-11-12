/**
 * site-serve 的缓存判据：**名字里有没有内容指纹**。
 *
 * 这条规则错了会静默出事，而且方向相反地两种：
 *   · 该 immutable 的给了 must-revalidate ⇒ 图片每页都回源，白付钱；
 *   · 不该 immutable 的给了（比如 `site.css`）⇒ 改一次样式，老访客一年看不到
 *     （仓库里实打实踩过，见 `workers/site/src/index.ts` 的头部注释）。
 */
import { describe, expect, it } from 'vitest';

import { isFingerprinted } from '../workers/site/src/index';

describe('isFingerprinted', () => {
  it('发布物化后的资产名：带 8 位以上 hex', () => {
    expect(isFingerprinted('assets/logo.9f2c1a8b.webp')).toBe(true);
    expect(isFingerprinted('assets/hero.0123456789abcdef.png')).toBe(true);
    expect(isFingerprinted('a.b.12345678.svg')).toBe(true);
  });

  it('普通产物：没有指纹，必须回源校验', () => {
    expect(isFingerprinted('index.html')).toBe(false);
    expect(isFingerprinted('assets/site.css')).toBe(false);
    expect(isFingerprinted('assets/logo.webp')).toBe(false);
    expect(isFingerprinted('assets/app.min.js')).toBe(false);
  });

  it('hex 太短（< 8）不算指纹', () => {
    expect(isFingerprinted('logo.abc123.webp')).toBe(false);
  });

  it('无扩展名的路径不会误判', () => {
    expect(isFingerprinted('assets/12345678')).toBe(false);
  });
});
