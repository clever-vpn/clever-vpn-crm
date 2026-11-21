import { describe, it, expect } from "vitest";
import { DEFAULT_CAPACITY, capacityOf, decide } from "../workers/router/src/index";

const map = (over: Record<string, unknown> = {}) => ({
  tenant_id: "t_acme",
  slot: 7,
  status: "active" as const,
  ...over,
});

describe("router 判定（纯函数）", () => {
  it("未知 host ⇒ 404，绝不回落默认租户", () => {
    expect(decide(null, () => true)).toEqual({ kind: "not_found" });
  });

  it("suspended ⇒ 410（域名解析得到、只是停了）", () => {
    expect(decide(map({ status: "suspended" }), () => true)).toEqual({ kind: "gone" });
  });

  it("片没绑定 ⇒ no_binding（部署事故，不是租户问题）", () => {
    const d = decide(map({ slot: 3007 }), () => false, 1000);
    expect(d).toMatchObject({ kind: "no_binding", binding: "SHARD_3" });
  });

  it("正常 ⇒ shard = floor(slot / capacity)", () => {
    expect(decide(map({ slot: 7 }), () => true, 1000)).toMatchObject({
      kind: "forward",
      binding: "SHARD_0",
    });
    expect(decide(map({ slot: 1000 }), () => true, 1000)).toMatchObject({
      kind: "forward",
      binding: "SHARD_1",
    });
    expect(decide(map({ slot: 2007 }), () => true, 1000)).toMatchObject({
      kind: "forward",
      binding: "SHARD_2",
    });
  });

  it("同一批位号在容量变化后会落到不同片（改容量必须重新渲染 router）", () => {
    expect(decide(map({ slot: 1500 }), () => true, 1000)).toMatchObject({ binding: "SHARD_1" });
    expect(decide(map({ slot: 1500 }), () => true, 2000)).toMatchObject({ binding: "SHARD_0" });
  });

  it("status 缺省按 active 处理（老记录没有该字段）", () => {
    expect(decide(map({ status: undefined }), () => true).kind).toBe("forward");
  });
});

describe("capacityOf：非法/缺省都退到默认值", () => {
  it("缺省、空串、非数字、0、负数都按默认容量", () => {
    expect(DEFAULT_CAPACITY).toBe(1000);
    for (const raw of [undefined, "", "abc", "0", "-5"]) {
      expect(capacityOf(raw as string | undefined)).toBe(DEFAULT_CAPACITY);
    }
    expect(capacityOf("1500")).toBe(1500);
  });
});
