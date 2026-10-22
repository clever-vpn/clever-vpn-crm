import { describe, expect, it } from "vitest";
import {
  base32Decode,
  base32Encode,
  hashPassword,
  totpCode,
  verifyPassword,
  verifyTotp,
} from "../src/admin/crypto";

describe("密码哈希", () => {
  it("能验证正确密码、拒绝错误密码", async () => {
    const stored = await hashPassword("correct horse battery staple", 10_000);
    expect(stored.startsWith("pbkdf2$sha256$10000$")).toBe(true);
    expect(await verifyPassword("correct horse battery staple", stored)).toBe(true);
    expect(await verifyPassword("wrong password", stored)).toBe(false);
  });

  it("拒绝格式非法或迭代次数过低的哈希", async () => {
    expect(await verifyPassword("x", "nope")).toBe(false);
    expect(await verifyPassword("x", "pbkdf2$sha256$100$AAA$BBB")).toBe(false);
  });
});

describe("base32", () => {
  it("编解码可往返", () => {
    const bytes = new Uint8Array([0, 1, 2, 250, 251, 252]);
    expect([...base32Decode(base32Encode(bytes))]).toEqual([...bytes]);
  });
});

describe("TOTP", () => {
  // RFC 6238 附录 B 的种子：ASCII "12345678901234567890"
  const secret = base32Encode(new TextEncoder().encode("12345678901234567890"));

  it("匹配 RFC 6238 测试向量（T=59s，取 6 位）", async () => {
    expect(await totpCode(secret, 59_000)).toBe("287082");
  });

  it("允许 ±1 个时间窗的时钟漂移", async () => {
    expect(await verifyTotp(secret, "287082", 59_000)).toBe(true);
    expect(await verifyTotp(secret, "287082", 89_000)).toBe(true);
    expect(await verifyTotp(secret, "287082", 500_000)).toBe(false);
    expect(await verifyTotp(secret, "000000", 59_000)).toBe(false);
    expect(await verifyTotp(secret, "28708", 59_000)).toBe(false);
  });
});
