import { describe, expect, it } from "vitest";

import { EPAY_V1_MAPPING } from "../../src/payments/builtin/epay";
import type { GatewayMapping } from "../../src/payments/mapping";
import {
  describeMapping,
  emptyState,
  fromMapping,
  requiredChecks,
  toMapping,
} from "../../web/src/mapping-form";

import {
  HUAJUN_MAPPING,
  PRAGUE_MAPPING,
  QWGUA_MAPPING,
  XARRPAY_NATIVE_MAPPING,
  YIHONG_MAPPING,
} from "../payments/fixtures";

const METHODS = ["alipay", "wechat"];

function canon(value: unknown): unknown {
  if (Array.isArray(value)) {
    const out = value.map(canon);
    if (out.every((v) => v && typeof v === "object" && "field" in (v as object))) {
      return [...out].sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
    }
    return out;
  }
  if (value && typeof value === "object") {
    const obj = value as Record<string, unknown>;
    if (typeof obj.path === "string" && ("equals" in obj || "in" in obj)) {
      const values =
        Array.isArray(obj.in) && obj.in.length > 0
          ? obj.in.map((x) => String(x))
          : obj.equals !== undefined && obj.equals !== null
            ? [String(obj.equals)]
            : [];
      return { path: obj.path, values };
    }
    return Object.fromEntries(
      Object.entries(obj)
        .filter(([, v]) => v !== undefined)
        .map(([k, v]) => [k, canon(v)]),
    );
  }
  return value;
}

function roundTrip(fixture: GatewayMapping): GatewayMapping {
  const { state, issues } = fromMapping(fixture, METHODS);
  expect(issues).toEqual([]);
  return toMapping(state) as unknown as GatewayMapping;
}

const FIXTURES: [string, GatewayMapping][] = [
  ["易支付（内置）", EPAY_V1_MAPPING],
  ["青蛙", QWGUA_MAPPING],
  ["亿宏", YIHONG_MAPPING],
  ["华俊", HUAJUN_MAPPING],
  ["XArrPay 原生", XARRPAY_NATIVE_MAPPING],
  ["布拉格", PRAGUE_MAPPING],
];

describe("真实协议夹具 round-trip", () => {
  it.each(FIXTURES)("%s：进表单再出来不丢信息", (_name, fixture) => {
    expect(canon(roundTrip(fixture))).toEqual(canon(fixture));
  });
});

describe("默认值 / 容错", () => {
  it("没有映射时给空白表单，不报 issue", () => {
    const { state, issues } = fromMapping(null, METHODS);
    expect(issues).toEqual([]);
    expect(state.response.pay_url).toBe("");
    expect(state.sign.enabled).toBe(true);
    expect(state.notify.format).toBe("json");
  });

  it("非对象给空白表单并提示", () => {
    const { state, issues } = fromMapping("not-a-mapping", METHODS);
    expect(issues).toHaveLength(1);
    expect(issues[0]).toContain("不是对象");
    expect(state.create.path).toBe("");
  });

  it("response.sign.spec 能完整往返", () => {
    const spec = { algo: "sha256" as const, field: "hash", exclude: ["sign"], upper: true };
    const raw: GatewayMapping = {
      ...EPAY_V1_MAPPING,
      create: {
        ...EPAY_V1_MAPPING.create,
        response: {
          ...EPAY_V1_MAPPING.create.response,
          sign: { field: "data.sign", data_path: "data", spec },
        },
      },
    };
    const { state } = fromMapping(raw, METHODS);
    expect(state.response.sign.spec).toEqual(spec);
    expect((toMapping(state) as unknown as GatewayMapping).create.response.sign?.spec).toEqual(spec);
  });

  it("顶层未知键提示，且保留给保存时拒绝", () => {
    const { state, issues } = fromMapping({ ...EPAY_V1_MAPPING, extra: 1 }, METHODS);
    expect(issues.join("")).toContain("extra");
    expect(state.unknown.extra).toBe(1);
  });
});

describe("表单产出 / 必填", () => {
  it("产出的结构与服务端 GatewayMapping 兼容", () => {
    const mapping = toMapping(fromMapping(EPAY_V1_MAPPING, METHODS).state) as unknown as GatewayMapping;
    expect(mapping.create.request.path).toBe("/mapi.php");
    expect(mapping.query?.request.sign).toEqual({ mode: "none" });
    expect(mapping.create.request.fields.find((f) => f.role === "amount")?.unit).toBe("yuan");
  });

  it("空白表单列出必须补的项，不再有 undefined", () => {
    const state = emptyState(METHODS);
    state.sign.enabled = false;
    state.notify_sign.enabled = false;
    state.query_sign.enabled = false;
    const checks = requiredChecks(state);
    expect(checks.length).toBeGreaterThanOrEqual(9);
    expect(checks.every((c) => !c.ok)).toBe(true);
    expect(JSON.stringify(describeMapping(state))).not.toContain("undefined");
  });
});
