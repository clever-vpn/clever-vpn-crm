/**
 * 单客户线路权益的**纯函数**部分（`normalizeLineIds`）
 *
 * 存储/推送语义（先推平台、再写本地、失败不改）在 `test/workers/subscription-lines.test.ts`，
 * 这里只钉"输入归一"：正整数、去重、升序；`[]` = 全部线路。
 */
import { describe, expect, it } from "vitest";

import { normalizeLineIds } from "../src/subscriptions/lines";

describe("normalizeLineIds", () => {
  it("去重并升序", () => {
    expect(normalizeLineIds([3, 1, 3, 2])).toEqual([1, 2, 3]);
  });

  it("接受数字字符串（表单/JSON 里常见），其它类型一律忽略", () => {
    expect(normalizeLineIds(["2", 1])).toEqual([1, 2]);
    expect(normalizeLineIds([null, undefined, true, {}, "x", 0, -1, 1.5])).toEqual([]);
  });

  it("非数组 ⇒ 空（= 全部线路）", () => {
    expect(normalizeLineIds(null)).toEqual([]);
    expect(normalizeLineIds("[1,2]")).toEqual([]);
  });
});
