import { readFileSync } from "node:fs";

import Ajv2020 from "ajv/dist/2020.js";
import { describe, expect, it } from "vitest";

import { EPAY_V1_MAPPING } from "../../src/payments/builtin/epay";
import { validateMapping } from "../../src/payments/mapping";
import { OFFICIAL_TEMPLATES } from "../../web/src/payment-templates";

import {
  HUAJUN_MAPPING,
  HUPIJIAO_MAPPING,
  PRAGUE_MAPPING,
  QWGUA_MAPPING,
  XARRPAY_NATIVE_MAPPING,
  YIHONG_MAPPING,
} from "./fixtures";

const schema = JSON.parse(
  readFileSync("docs/payment-templates.schema.json", "utf8"),
) as Record<string, unknown> & { $id: string; $schema: string };

const ajv = new Ajv2020({ allErrors: true, strict: false });
ajv.addSchema(schema);
const validateTemplate = ajv.getSchema(schema.$id)!;
const validateMappingSchema = ajv.compile({
  $schema: schema.$schema,
  $id: "https://clever-vpn-crm.local/schemas/mapping-root.json",
  $ref: `${schema.$id}#/$defs/mapping`,
});

describe("模板 schema v2", () => {
  it("官方 qwgua / XArrPay 模板通过 schema", () => {
    for (const template of OFFICIAL_TEMPLATES) {
      expect(validateTemplate(template), JSON.stringify(validateTemplate.errors)).toBe(true);
    }
  });

  it("包装 / 目录通过 schema", () => {
    const { schema_version: _sv, ...wrapped } = OFFICIAL_TEMPLATES[0]!;
    expect(validateTemplate({ schema_version: 2, template: wrapped })).toBe(true);
    expect(validateTemplate({ schema_version: 2, templates: [{ id: "a", name: "A", mapping: OFFICIAL_TEMPLATES[0]!.mapping }] })).toBe(true);
  });

  it("夹具与 validateMapping 结果一致", () => {
    const fixtures = [
      ["epay", EPAY_V1_MAPPING, { allowUnsignedQuery: true }],
      ["qwgua", QWGUA_MAPPING, {}],
      ["yihong", YIHONG_MAPPING, {}],
      ["xarrpay", XARRPAY_NATIVE_MAPPING, {}],
      ["prague", PRAGUE_MAPPING, {}],
      ["huajun", HUAJUN_MAPPING, {}],
    ] as const;
    for (const [name, mapping, opts] of fixtures) {
      expect(validateMappingSchema(mapping), `${name}: ${JSON.stringify(validateMappingSchema.errors)}`).toBe(true);
      const runtime = validateMapping(mapping, opts);
      expect(runtime.ok, `${name}: ${runtime.ok ? "" : runtime.errors.join("；")}`).toBe(true);
    }
    expect(validateMappingSchema(HUPIJIAO_MAPPING)).toBe(false);
    expect(validateMapping(HUPIJIAO_MAPPING).ok).toBe(false);
  });

  it("拒绝双 equals/in、未知键、非法 sign mode", () => {
    const base = {
      create: {
        request: {
          path: "/pay",
          fields: [
            { field: "m", role: "merchant", value: "{merchant}" },
            { field: "o", role: "order_no", value: "{order_no}" },
            { field: "a", role: "amount", value: "{amount}", unit: "yuan" },
          ],
          sign: {},
        },
        response: { ok: { path: "code", equals: 1 }, fields: [{ field: "u", role: "pay_url" }] },
      },
      notify: {
        request: {
          fields: [{ field: "o", role: "order_no" }],
          paid_when: { path: "s", equals: 1 },
          sign: {},
        },
        response: { reply: "ok" },
      },
      query: {
        request: { path: "/q", fields: [], sign: { mode: "none" } },
        response: { paid_when: { path: "s", equals: 1 }, fields: [] },
      },
    };
    expect(validateMappingSchema(base)).toBe(true);
    expect(validateMappingSchema({ ...base, response: { ok: { path: "c", equals: 1, in: ["1"] }, fields: [] } })).toBe(false);
    expect(validateMappingSchema({ ...base, extra: 1 })).toBe(false);
    expect(
      validateMappingSchema({
        ...base,
        create: {
          ...base.create,
          response: { ...base.create.response, sign: { field: "sign", spec: { algo: "md5", exlude: [] } } },
        },
      }),
    ).toBe(false);
    expect(
      validateMappingSchema({
        ...base,
        query: { ...base.query, request: { ...base.query.request, sign: { mode: "evil" } } },
      }),
    ).toBe(false);
  });
});
