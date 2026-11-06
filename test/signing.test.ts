import { describe, it, expect } from "vitest";
import { signingKeyOf } from "../src/signing";

describe("签名密钥取值", () => {
  it("优先用新名 SIGNING_SECRET", () => {
    expect(signingKeyOf({ SIGNING_SECRET: "new", SESSION_SECRET: "old" } as never)).toBe("new");
  });

  it("没配新名时兼容旧名 SESSION_SECRET（老部署不失效）", () => {
    expect(signingKeyOf({ SESSION_SECRET: "old" } as never)).toBe("old");
  });

  it("都没配 ⇒ 空串（调用方据此判定功能不可用，而不是用空密钥签）", () => {
    expect(signingKeyOf({} as never)).toBe("");
    expect(signingKeyOf({ SIGNING_SECRET: "   " } as never)).toBe("");
  });
});
