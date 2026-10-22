/**
 * 管理员认证用到的密码学原语。全部基于 WebCrypto，不引入额外依赖
 * （Workers 与 Node 20+ 都有 `globalThis.crypto`，因此可直接单测）。
 */

const encoder = new TextEncoder();

/**
 * 默认迭代次数。只用于管理员登录（全站唯一的密码），5 万次约 6ms：
 * 免费版 Workers 单请求 CPU 只有 10ms，再高就可能超限。
 * 付费想更硬：`wrangler secret put ADMIN_PBKDF2_ITERATIONS 210000`。
 */
export const DEFAULT_ITERATIONS = 50_000;
export const MIN_ITERATIONS = 10_000;

export function toBase64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function fromBase64Url(text: string): Uint8Array {
  const padded = text.replace(/-/g, "+").replace(/_/g, "/");
  const binary = atob(padded + "=".repeat((4 - (padded.length % 4)) % 4));
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
  return out;
}

export function randomBytes(length: number): Uint8Array {
  const bytes = new Uint8Array(length);
  crypto.getRandomValues(bytes);
  return bytes;
}

/** 会话 token / CSRF 值：32 字节随机数 */
export function randomToken(length = 32): string {
  return toBase64Url(randomBytes(length));
}

export async function sha256Hex(input: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", encoder.encode(input));
  return [...new Uint8Array(digest)]
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

/** 定长比较，避免计时侧信道 */
export function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

async function pbkdf2(
  password: string,
  salt: Uint8Array,
  iterations: number,
): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(password),
    "PBKDF2",
    false,
    ["deriveBits"],
  );
  const bits = await crypto.subtle.deriveBits(
    { name: "PBKDF2", hash: "SHA-256", salt: salt as BufferSource, iterations },
    key,
    256,
  );
  return new Uint8Array(bits);
}

/** 存储格式：`pbkdf2$sha256$<iterations>$<salt>$<hash>`（salt/hash 为 base64url） */
export async function hashPassword(
  password: string,
  iterations = DEFAULT_ITERATIONS,
): Promise<string> {
  const rounds = Math.max(MIN_ITERATIONS, Math.floor(iterations));
  const salt = randomBytes(16);
  const hash = await pbkdf2(password, salt, rounds);
  return `pbkdf2$sha256$${rounds}$${toBase64Url(salt)}$${toBase64Url(hash)}`;
}

export async function verifyPassword(
  password: string,
  stored: string,
): Promise<boolean> {
  const parts = stored.split("$");
  if (parts.length !== 5 || parts[0] !== "pbkdf2" || parts[1] !== "sha256") {
    return false;
  }
  const iterations = Number(parts[2]);
  if (!Number.isFinite(iterations) || iterations < MIN_ITERATIONS) return false;
  const salt = fromBase64Url(parts[3]!);
  const expected = parts[4]!;
  const actual = toBase64Url(await pbkdf2(password, salt, iterations));
  return timingSafeEqual(actual, expected);
}

// ── TOTP（RFC 6238，HMAC-SHA1/6 位/30 秒）────────────────────────────────

const BASE32_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

export function base32Encode(bytes: Uint8Array): string {
  let bits = 0;
  let value = 0;
  let out = "";
  for (const byte of bytes) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += BASE32_ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += BASE32_ALPHABET[(value << (5 - bits)) & 31];
  return out;
}

export function base32Decode(text: string): Uint8Array {
  const clean = text.toUpperCase().replace(/=+$/, "").replace(/\s/g, "");
  let bits = 0;
  let value = 0;
  const out: number[] = [];
  for (const char of clean) {
    const index = BASE32_ALPHABET.indexOf(char);
    if (index < 0) throw new Error(`invalid base32 character: ${char}`);
    value = (value << 5) | index;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 255);
      bits -= 8;
    }
  }
  return new Uint8Array(out);
}

/** 20 字节随机密钥，base32 编码（认证器 App 认这个格式） */
export function generateTotpSecret(): string {
  return base32Encode(randomBytes(20));
}

async function hotp(secret: Uint8Array, counter: number): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    secret as BufferSource,
    { name: "HMAC", hash: "SHA-1" },
    false,
    ["sign"],
  );
  const message = new Uint8Array(8);
  new DataView(message.buffer).setBigUint64(0, BigInt(counter));
  const mac = new Uint8Array(
    await crypto.subtle.sign("HMAC", key, message as BufferSource),
  );
  const offset = mac[mac.length - 1]! & 0x0f;
  const binary =
    ((mac[offset]! & 0x7f) << 24) |
    (mac[offset + 1]! << 16) |
    (mac[offset + 2]! << 8) |
    mac[offset + 3]!;
  return String(binary % 1_000_000).padStart(6, "0");
}

export async function totpCode(
  secretBase32: string,
  atMs: number = Date.now(),
): Promise<string> {
  return hotp(base32Decode(secretBase32), Math.floor(atMs / 30_000));
}

/** `window` = 允许前后各偏移几个 30 秒窗口（补偿时钟漂移） */
export async function verifyTotp(
  secretBase32: string,
  code: string,
  atMs: number = Date.now(),
  window = 1,
): Promise<boolean> {
  const trimmed = code.replace(/\s/g, "");
  if (!/^\d{6}$/.test(trimmed)) return false;
  const counter = Math.floor(atMs / 30_000);
  const secret = base32Decode(secretBase32);
  for (let drift = -window; drift <= window; drift++) {
    if (timingSafeEqual(await hotp(secret, counter + drift), trimmed)) return true;
  }
  return false;
}
