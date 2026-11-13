/**
 * 从图片字节里读出**宽高**（契约 `site-assets.md` §7 的"尺寸"一列）。
 *
 * 为什么要它：AI 只看到"2 KB · png"时不知道该放哪 —— 横图当竖图用，排版立刻歪。
 * 尺寸是排版决策的**必需输入**，不是锦上添花。
 *
 * 为什么自己解文件头而不是用 canvas：Worker 里没有 canvas，也不该为了两个整数
 * 引一个栅格化库。PNG / JPEG / WebP / SVG 的头部格式都很小，解出来是几十行纯函数，
 * 而且**可单测**（喂字节，断言宽高）。
 *
 * 一律**失败返回 null**：坏文件不该让上传 500。前端拿到 null 只是少显示一行尺寸。
 */

export interface ImageSize {
  width: number;
  height: number;
}

const u16be = (b: Uint8Array, i: number): number => (b[i]! << 8) | b[i + 1]!;
const u16le = (b: Uint8Array, i: number): number => b[i]! | (b[i + 1]! << 8);
const u24le = (b: Uint8Array, i: number): number => b[i]! | (b[i + 1]! << 8) | (b[i + 2]! << 16);
const u32be = (b: Uint8Array, i: number): number =>
  ((b[i]! << 24) | (b[i + 1]! << 16) | (b[i + 2]! << 8) | b[i + 3]!) >>> 0;

const ok = (width: number, height: number): ImageSize | null =>
  width > 0 && height > 0 && width < 100_000 && height < 100_000 ? { width, height } : null;

/** PNG：8 字节签名 + IHDR（宽高在 16 / 20，大端） */
function pngSize(b: Uint8Array): ImageSize | null {
  if (b.length < 24) return null;
  const sig = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  for (let i = 0; i < sig.length; i += 1) if (b[i] !== sig[i]) return null;
  return ok(u32be(b, 16), u32be(b, 20));
}

/** JPEG：逐段找 SOF（帧头），宽高在段内 5 / 3 字节处 */
function jpegSize(b: Uint8Array): ImageSize | null {
  if (b.length < 4 || b[0] !== 0xff || b[1] !== 0xd8) return null;
  let i = 2;
  while (i + 9 < b.length) {
    if (b[i] !== 0xff) {
      i += 1;
      continue;
    }
    const marker = b[i + 1]!;
    // 独立标记（无长度字段）
    if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
      i += 2;
      continue;
    }
    const len = u16be(b, i + 2);
    if (len < 2) return null;
    const isSof =
      (marker >= 0xc0 && marker <= 0xc3) ||
      (marker >= 0xc5 && marker <= 0xc7) ||
      (marker >= 0xc9 && marker <= 0xcb) ||
      (marker >= 0xcd && marker <= 0xcf);
    if (isSof) return ok(u16be(b, i + 7), u16be(b, i + 5));
    i += 2 + len;
  }
  return null;
}

/** WebP：三种子格式（有损 VP8 / 无损 VP8L / 扩展 VP8X）的宽高位置都不一样 */
function webpSize(b: Uint8Array): ImageSize | null {
  if (b.length < 30) return null;
  const tag = String.fromCharCode(b[0]!, b[1]!, b[2]!, b[3]!);
  const webp = String.fromCharCode(b[8]!, b[9]!, b[10]!, b[11]!);
  if (tag !== 'RIFF' || webp !== 'WEBP') return null;
  const chunk = String.fromCharCode(b[12]!, b[13]!, b[14]!, b[15]!);

  if (chunk === 'VP8 ') {
    // 起始码 0x9d 0x01 0x2a 之后的 14 / 16 字节，取低 14 位
    if (b[23] !== 0x9d || b[24] !== 0x01 || b[25] !== 0x2a) return null;
    return ok(u16le(b, 26) & 0x3fff, u16le(b, 28) & 0x3fff);
  }
  if (chunk === 'VP8L') {
    if (b[20] !== 0x2f) return null;
    const bits = b[21]! | (b[22]! << 8) | (b[23]! << 16) | (b[24]! << 24);
    return ok((bits & 0x3fff) + 1, ((bits >> 14) & 0x3fff) + 1);
  }
  if (chunk === 'VP8X') {
    return ok(u24le(b, 24) + 1, u24le(b, 27) + 1);
  }
  return null;
}

/** SVG：`width`/`height`（可带 px），没有就退回 `viewBox` */
function svgSize(bytes: Uint8Array): ImageSize | null {
  const text = new TextDecoder().decode(bytes.subarray(0, 4096));
  const svg = /<svg\b[^>]*>/i.exec(text)?.[0];
  if (!svg) return null;
  const num = (attr: string): number => {
    const m = new RegExp(`${attr}\\s*=\\s*["']\\s*([0-9.]+)\\s*(?:px)?\\s*["']`, 'i').exec(svg);
    return m ? Math.round(Number(m[1])) : 0;
  };
  const w = num('width');
  const h = num('height');
  if (w > 0 && h > 0) return ok(w, h);
  const vb = /viewBox\s*=\s*["']\s*[-\d.]+[\s,]+[-\d.]+[\s,]+([\d.]+)[\s,]+([\d.]+)\s*["']/i.exec(svg);
  if (vb) return ok(Math.round(Number(vb[1])), Math.round(Number(vb[2])));
  return null;
}

/** 按 MIME 分派；认不出来就 `null`（不抛） */
export function imageSizeOf(bytes: Uint8Array, mime: string): ImageSize | null {
  const type = String(mime ?? '').toLowerCase().split(';')[0]!.trim();
  try {
    if (type === 'image/png') return pngSize(bytes);
    if (type === 'image/jpeg') return jpegSize(bytes);
    if (type === 'image/webp') return webpSize(bytes);
    if (type === 'image/svg+xml') return svgSize(bytes);
    return null;
  } catch {
    return null;
  }
}
