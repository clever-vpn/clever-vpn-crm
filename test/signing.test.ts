import { describe, it, expect } from "vitest";
import { appSecretConfigured, encryptionKeyOf, signingKeyOf } from "../src/secrets";

/**
 * 一把主密钥、两个用途。
 *
 * 判据是"两个用途派生出的字节不同"，不是"字符串长什么样"——所以这里比较的是
 * 派生结果之间的关系，而不是硬编码某个具体值。
 */
describe("主密钥派生", () => {
  it("没配 ⇒ 空串 / null（调用方据此判定功能不可用，而不是用空密钥签）", async () => {
    expect(signingKeyOf({} as never)).toBe("");
    expect(signingKeyOf({ APP_SECRET: "   " } as never)).toBe("");
    expect(appSecretConfigured({} as never)).toBe(false);
    expect(appSecretConfigured({ APP_SECRET: "x" } as never)).toBe(true);
    expect(await encryptionKeyOf({} as never)).toBeNull();
  });

  it("签名密钥由主密钥派生，并随主密钥变化", () => {
    const a = signingKeyOf({ APP_SECRET: "master-a" } as never);
    const b = signingKeyOf({ APP_SECRET: "master-b" } as never);
    expect(a).not.toBe(b);
    expect(a).toContain("master-a");
    // 同一个主密钥 ⇒ 稳定（重启/多实例签出的值必须一致）
    expect(signingKeyOf({ APP_SECRET: "master-a" } as never)).toBe(a);
  });

  it("签名与加密用的是两把不同的密钥（同一主密钥下也不复用字节）", async () => {
    const env = { APP_SECRET: "master-a" } as never;
    const signing = signingKeyOf(env);

    // 拿签名密钥材料去加密，再用派生的加密密钥解密 ⇒ 必须失败
    const raw = await crypto.subtle.importKey(
      "raw",
      await crypto.subtle.digest("SHA-256", new TextEncoder().encode(signing)),
      { name: "AES-GCM" },
      false,
      ["encrypt"],
    );
    const iv = new Uint8Array(12);
    const ct = await crypto.subtle.encrypt(
      { name: "AES-GCM", iv },
      raw,
      new TextEncoder().encode("x"),
    );

    const encKey = await encryptionKeyOf(env);
    await expect(crypto.subtle.decrypt({ name: "AES-GCM", iv }, encKey!, ct)).rejects.toThrow();
  });
});
