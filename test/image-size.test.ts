/**
 * 图片宽高解析的自检。
 *
 * 为什么要单测而不是"上传一张看看"：这些是**字节级**的解析，错一个偏移就静默返回
 * 一个错的尺寸，然后 AI 按错的尺寸排版 —— 那种 bug 在界面上几乎看不出来。
 *
 * 用**最小的真实样本**（手工拼的字节），不依赖磁盘上的图片文件。
 */

import { describe, expect, it } from 'vitest';

import { imageSizeOf } from '../src/site/image-size';

/** 1×1 透明 PNG（与前端上传测试用的是同一份） */
const PNG_1x1 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

const bytesOf = (b64: string): Uint8Array => {
  const raw = atob(b64);
  const out = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i += 1) out[i] = raw.charCodeAt(i);
  return out;
};

/** 拼一个只够解析头部的 PNG（签名 + IHDR），宽高随便给 */
function pngHeader(width: number, height: number): Uint8Array {
  const b = new Uint8Array(33);
  b.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 0);
  b.set([0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52], 8); // len + "IHDR"
  const view = new DataView(b.buffer);
  view.setUint32(16, width);
  view.setUint32(20, height);
  return b;
}

/** JPEG：SOI + SOF0（宽高在段内 7 / 5） */
function jpegHeader(width: number, height: number): Uint8Array {
  const b = new Uint8Array(20);
  b.set([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x04, 0x00, 0x00], 0); // SOI + APP0（长度 4，占位）
  b.set([0xff, 0xc0, 0x00, 0x11, 0x08], 8); // SOF0，长度 17，精度 8
  const view = new DataView(b.buffer);
  view.setUint16(13, height);
  view.setUint16(15, width);
  return b;
}

/** WebP 无损（VP8L）：14 位宽-1 + 14 位高-1 */
function webpLossless(width: number, height: number): Uint8Array {
  const b = new Uint8Array(30);
  const ascii = (at: number, s: string) => {
    for (let i = 0; i < s.length; i += 1) b[at + i] = s.charCodeAt(i);
  };
  ascii(0, 'RIFF');
  ascii(8, 'WEBP');
  ascii(12, 'VP8L');
  b[20] = 0x2f;
  const bits = (width - 1) | ((height - 1) << 14);
  b[21] = bits & 0xff;
  b[22] = (bits >> 8) & 0xff;
  b[23] = (bits >> 16) & 0xff;
  b[24] = (bits >> 24) & 0xff;
  return b;
}

describe('imageSizeOf', () => {
  it('PNG：读 IHDR（真实 1×1 与合成的大图都对）', () => {
    expect(imageSizeOf(bytesOf(PNG_1x1), 'image/png')).toEqual({ width: 1, height: 1 });
    expect(imageSizeOf(pngHeader(1200, 800), 'image/png')).toEqual({ width: 1200, height: 800 });
  });

  it('JPEG：逐段找到 SOF，宽高不接反', () => {
    expect(imageSizeOf(jpegHeader(1600, 900), 'image/jpeg')).toEqual({ width: 1600, height: 900 });
  });

  it('WebP（无损 VP8L）', () => {
    expect(imageSizeOf(webpLossless(640, 480), 'image/webp')).toEqual({ width: 640, height: 480 });
  });

  it('SVG：width/height 优先，没有就用 viewBox', () => {
    const withAttrs = new TextEncoder().encode('<svg xmlns="http://www.w3.org/2000/svg" width="256" height="256"><rect/></svg>');
    expect(imageSizeOf(withAttrs, 'image/svg+xml')).toEqual({ width: 256, height: 256 });

    const withViewBox = new TextEncoder().encode('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 256"><rect/></svg>');
    expect(imageSizeOf(withViewBox, 'image/svg+xml')).toEqual({ width: 512, height: 256 });
  });

  it('认不出来就返回 null（不抛）：坏字节、错 MIME、宽高为 0', () => {
    expect(imageSizeOf(new Uint8Array([1, 2, 3]), 'image/png')).toBeNull();
    expect(imageSizeOf(bytesOf(PNG_1x1), 'image/gif')).toBeNull();
    expect(imageSizeOf(pngHeader(0, 100), 'image/png')).toBeNull();
    expect(imageSizeOf(new TextEncoder().encode('not an svg'), 'image/svg+xml')).toBeNull();
  });
});
