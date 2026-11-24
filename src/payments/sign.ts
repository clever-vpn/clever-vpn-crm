/**
 * 支付签名 / 验签 —— 只覆盖**一类**协议：扁平参数 + 按参数名排序拼接 + 摘要。
 *
 * 为什么只做这一类：国内聚合支付（易支付族、青蛙、亿宏、华俊…）**主干完全一样**，
 * 差异只有几个开关（`key_append` / `exclude` / `upper`）。而 Stripe / PayPal 那种
 * "HMAC 原始报文"或"回调官方 API 验签"是**另一种范式**，硬塞进这里只会让配置变成
 * 半门 DSL —— 它们是独立的薄 driver（见 `docs/payments.md` §6）。
 *
 * ⚠️ Workers 的 WebCrypto **不支持 MD5**，故用 `@noble/hashes`（与 cf-api 同款）。
 */

import { md5 } from "@noble/hashes/legacy.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex } from "@noble/hashes/utils.js";

export const SIGN_ALGOS = ["md5", "sha256"] as const;
export type SignAlgo = (typeof SIGN_ALGOS)[number];

export interface SignSpec {
  /**
   * 签名字段名，默认 `"sign"`。
   *
   * 虎皮椒（XunHuPay）用 `"hash"` —— 这是它与易支付唯一的签名差异（算法完全相同），
   * 但写错就是“对方读不到签名” ⇒ 永远验签失败。
   */
  field?: string;
  /** 摘要算法，默认 `md5` */
  algo?: SignAlgo;
  /**
   * 拼在明文末尾、**密钥之前**的字符串，默认 `""`。
   *
   * - `""`      → `a=1&b=2` 紧接 `密钥`（易支付 / SSPanel / 青蛙 / 亿宏）
   * - `"&key="` → `a=1&b=2&key=密钥`（华俊）
   */
  key_append?: string;
  /** 不参与签名的参数名，默认 `["sign"]` */
  exclude?: string[];
  /** 摘要结果转大写，默认小写 */
  upper?: boolean;
  /** 参与签名的值是否做 URL 编码，默认 `false`（各家文档都是原文签名） */
  encode?: boolean;
}

export const DEFAULT_EXCLUDE = ["sign"];

/** 签名字段自己永远不参与签名（否则自指），不管 `exclude` 写没写 */
function withField(spec: SignSpec, exclude: readonly string[]): string[] {
  const field = spec.field ?? "sign";
  return exclude.includes(field) ? [...exclude] : [field, ...exclude];
}

function isEmptyValue(v: unknown): boolean {
  return v === undefined || v === null || String(v) === "";
}

/** 定长比较：`^=` 累积差异，避免逐字符早退（防时序侧信道） */
function safeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

function digest(algo: SignAlgo, text: string): string {
  const bytes = new TextEncoder().encode(text);
  return bytesToHex(algo === "sha256" ? sha256(bytes) : md5(bytes));
}

/** 过滤空值与排除项 → 按参数名 ASCII 升序 → `k=v` 用 `&` 连接 */
export function signBase(
  params: Record<string, unknown>,
  exclude: readonly string[],
  encode = false,
): string {
  const skip = new Set(exclude);
  return Object.keys(params)
    .filter((k) => !skip.has(k) && !isEmptyValue(params[k]))
    .sort()
    .map((k) => `${k}=${encode ? encodeURIComponent(String(params[k])) : String(params[k])}`)
    .join("&");
}

/** 明文 = 参数串 + key_append + 密钥 */
export function signPlaintext(
  params: Record<string, unknown>,
  key: string,
  spec: SignSpec = {},
  exclude: readonly string[] = spec.exclude ?? DEFAULT_EXCLUDE,
): string {
  return `${signBase(params, exclude, spec.encode ?? false)}${spec.key_append ?? ""}${key}`;
}

/** 生成签名（`sign` 本身不参与，否则自指） */
export function signParams(
  params: Record<string, unknown>,
  key: string,
  spec: SignSpec = {},
): string {
  const exclude = withField(spec, spec.exclude ?? DEFAULT_EXCLUDE);
  const hex = digest(spec.algo ?? "md5", signPlaintext(params, key, spec, exclude));
  return spec.upper ? hex.toUpperCase() : hex;
}

/**
 * 验签。按 `exclude` 计算一次。
 *
 * 文档必须明确哪些字段参与签名；不清晰的文档不在这里兜底。
 */
export function verifyParams(
  params: Record<string, unknown>,
  key: string,
  spec: SignSpec = {},
): boolean {
  if (!key) return false;
  const got = String(params[spec.field ?? "sign"] ?? "").trim();
  if (!got) return false;

  const exclude = withField(spec, spec.exclude ?? DEFAULT_EXCLUDE);
  const hex = digest(spec.algo ?? "md5", signPlaintext(params, key, spec, exclude));
  const expected = spec.upper ? hex.toUpperCase() : hex;
  return safeEqual(expected.toLowerCase(), got.toLowerCase());
}
