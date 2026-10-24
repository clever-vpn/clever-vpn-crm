/**
 * 网关密钥加解密
 *
 * 重点在"解不开的每一种情况都返回 null"：没配主密钥、换过主密钥、密文被改、
 * 版本不认识 —— 绝不能返回半截明文让上层拿去签名。
 */

import { describe, expect, it } from "vitest";

import { decryptSecret, encryptSecret, secretKeyConfigured } from "../../src/payments/secret";

import type { Env } from "../../src/env";

function env(over: Partial<Env> = {}): Env {
  return { DB: {} as never, ASSETS: {} as never, ...over };
}

const KEY = env({ PAYMENT_SECRET_KEY: "unit-test-master-key" });

describe("网关密钥加密", () => {
  it("没配主密钥时拒绝加密（不退化成存明文）", async () => {
    expect(secretKeyConfigured(env())).toBe(false);
    expect(await encryptSecret(env(), "abc")).toBeNull();
  });

  it("往返一致，且带 v1: 前缀", async () => {
    const enc = await encryptSecret(KEY, "epay-secret-123");
    expect(enc).toMatch(/^v1:/);
    expect(enc).not.toContain("epay-secret-123");
    expect(await decryptSecret(KEY, enc)).toBe("epay-secret-123");
  });

  it("同一个明文两次加密结果不同（随机 IV）", async () => {
    const a = await encryptSecret(KEY, "same");
    const b = await encryptSecret(KEY, "same");
    expect(a).not.toBe(b);
    expect(await decryptSecret(KEY, b)).toBe("same");
  });

  it("换主密钥解不开", async () => {
    const enc = await encryptSecret(KEY, "value");
    expect(await decryptSecret(env({ PAYMENT_SECRET_KEY: "another-key" }), enc)).toBeNull();
  });

  it("密文被改一个字节就解不开（GCM 认证）", async () => {
    const enc = (await encryptSecret(KEY, "value"))!;
    const body = enc.slice(3);
    const tampered = `${enc.slice(0, 3)}${body.slice(0, -2)}${body.slice(-2) === "AA" ? "BB" : "AA"}`;
    expect(await decryptSecret(KEY, tampered)).toBeNull();
  });

  it("空 / 非法 / 未知版本一律 null", async () => {
    expect(await decryptSecret(KEY, null)).toBeNull();
    expect(await decryptSecret(KEY, "")).toBeNull();
    expect(await decryptSecret(KEY, "no-version-prefix")).toBeNull();
    expect(await decryptSecret(KEY, "v9:AAAA")).toBeNull();
    expect(await decryptSecret(KEY, "v1:not-base64!!")).toBeNull();
    expect(await decryptSecret(KEY, "v1:")).toBeNull();
  });

  it("没配主密钥时解不开（不会抛错）", async () => {
    const enc = await encryptSecret(KEY, "value");
    expect(await decryptSecret(env(), enc)).toBeNull();
  });
});
