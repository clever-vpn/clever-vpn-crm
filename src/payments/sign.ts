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
  /**
   * **仅验签时**额外尝试的**完整**排除集合（直接作为替代方案，不叠加）。
   *
   * 为什么需要：有的厂商文档没写清"回调是否带 `attach`/`format`"，
   * 我们只能两种集合都试一遍（亿宏就是：下单排除 `format`/`attach`，回调未知）。
   * 最多 3 组，防止配置失控。
   */
  exclude_variants?: string[][];
  /** 摘要结果转大写，默认小写 */
  upper?: boolean;
  /** 参与签名的值是否做 URL 编码，默认 `false`（各家文档都是原文签名） */
  encode?: boolean;
}

export const DEFAULT_EXCLUDE = ["sign"];

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
  const hex = digest(spec.algo ?? "md5", signPlaintext(params, key, spec));
  return spec.upper ? hex.toUpperCase() : hex;
}

/**
 * 验签。按 `exclude` 与 `exclude_variants` 依次尝试，任一匹配即通过。
 *
 * **必须**用"收到什么就签什么"的方式比较 —— 厂商明确要求"接口可能增加字段，
 * 验签必须兼容扩展字段"（华俊文档原话），所以不能校验参数集合完全一致。
 */
export function verifyParams(
  params: Record<string, unknown>,
  key: string,
  spec: SignSpec = {},
): boolean {
  if (!key) return false;
  const got = String(params.sign ?? "").trim();
  if (!got) return false;

  const base = spec.exclude ?? DEFAULT_EXCLUDE;
  // 每个候选都是**完整的**排除集合（基集与变体并列）
  const candidates: string[][] = [base, ...(spec.exclude_variants ?? [])]

  return candidates.some((exclude) => {
    const hex = digest(spec.algo ?? "md5", signPlaintext(params, key, spec, exclude));
    const expected = spec.upper ? hex.toUpperCase() : hex;
    return safeEqual(expected.toLowerCase(), got.toLowerCase());
  });
}
