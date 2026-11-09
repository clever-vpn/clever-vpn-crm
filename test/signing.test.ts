import { describe, it, expect } from "vitest";
import { signingKeyOf } from "../src/signing";

describe("签名密钥取值", () => {
  it("用 SIGNING_SECRET（唯一来源，没有旧名回退）", () => {
    expect(signingKeyOf({ SIGNING_SECRET: "new" } as never)).toBe("new");
  });

  it("已废弃的 SESSION_SECRET 不再被读取", () => {
    expect(signingKeyOf({ SESSION_SECRET: "old" } as never)).toBe("");
  });

  it("都没配 ⇒ 空串（调用方据此判定功能不可用，而不是用空密钥签）", () => {
    expect(signingKeyOf({} as never)).toBe("");
    expect(signingKeyOf({ SIGNING_SECRET: "   " } as never)).toBe("");
  });
});
