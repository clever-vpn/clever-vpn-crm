import { describe, it, expect } from "vitest";
import { decide } from "../workers/router/src/index";

const map = (over: Record<string, unknown> = {}) => ({
  tenant_id: "t_acme",
  slot: 7,
  shard: 0,
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
    const d = decide(map({ shard: 3 }), () => false);
    expect(d).toMatchObject({ kind: "no_binding", binding: "SHARD_3" });
  });

  it("正常 ⇒ 转发到 SHARD_<slot 所在片>", () => {
    const d = decide(map({ shard: 2 }), () => true);
    expect(d).toMatchObject({ kind: "forward", binding: "SHARD_2" });
  });

  it("status 缺省按 active 处理（老记录没有该字段）", () => {
    const d = decide(map({ status: undefined }), () => true);
    expect(d.kind).toBe("forward");
  });
});
