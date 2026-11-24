import { describe, expect, it } from "vitest";

import { validateMapping } from "../../src/payments/mapping";
import { fromMapping, toMapping } from "../../web/src/mapping-form";
import { OFFICIAL_TEMPLATES, parseTemplateText } from "../../web/src/payment-templates";

import { QWGUA_MAPPING, XARRPAY_NATIVE_MAPPING } from "../payments/fixtures";

const METHODS = ["alipay", "wechat"];

describe("官方支付接口模板", () => {
  it("qwgua / XArrPay 都是合法 mapping，且能进表单再出来", () => {
    for (const tpl of OFFICIAL_TEMPLATES) {
      const result = validateMapping(tpl.mapping);
      expect(result.ok, `${tpl.id}: ${result.ok ? "" : result.errors.join("；")}`).toBe(true);
      const round = toMapping(fromMapping(tpl.mapping, METHODS).state);
      expect(round.create.request.path).toBe(tpl.mapping.create.request.path);
      expect(round.query?.request.path).toBe(tpl.mapping.query?.request.path);
    }
  });

  it("模板不包含账户值", () => {
    for (const tpl of OFFICIAL_TEMPLATES) {
      const obj = tpl as unknown as Record<string, unknown>;
      for (const key of ["endpoint", "merchant_id", "secret", "methods", "channel_codes"]) {
        expect(obj).not.toHaveProperty(key);
      }
      expect(tpl.mapping as unknown as Record<string, unknown>).not.toHaveProperty("channel_codes");
    }
  });

  it("官方 qwgua 模板与夹具的协议字段一致（金额单位、路径）", () => {
    const q = OFFICIAL_TEMPLATES.find((t) => t.id === "qwgua")!;
    expect(q.mapping.create.request.path).toBe(QWGUA_MAPPING.create.request.path);
    expect(q.mapping.query?.request.path).toBe(QWGUA_MAPPING.query?.request.path);
    expect(q.mapping.create.request.fields.find((f) => f.role === "amount")?.unit).toBe(
      QWGUA_MAPPING.create.request.fields.find((f) => f.role === "amount")?.unit,
    );
    const x = OFFICIAL_TEMPLATES.find((t) => t.id === "xarrpay")!;
    expect(x.mapping.create.request.fields.find((f) => f.role === "amount")?.unit).toBe(
      XARRPAY_NATIVE_MAPPING.create.request.fields.find((f) => f.role === "amount")?.unit,
    );
    expect(x.mapping.notify.request.fields.find((f) => f.role === "amount")?.unit).toBe(
      XARRPAY_NATIVE_MAPPING.notify.request.fields.find((f) => f.role === "amount")?.unit,
    );
    expect(x.mapping.query?.request.path).toBe(XARRPAY_NATIVE_MAPPING.query?.request.path);
  });
});

describe("导入模板文件", () => {
  const template = {
    schema_version: 2,
    template: {
      id: "community-x",
      name: "社区某支付",
      source: "community",
      mapping: { ...OFFICIAL_TEMPLATES[0]!.mapping },
    },
  };

  it("单模板、目录都能解析", () => {
    const one = parseTemplateText(JSON.stringify(template));
    expect(one.errors).toEqual([]);
    expect(one.templates).toHaveLength(1);
    expect(one.templates[0]!.source).toBe("imported");

    const many = parseTemplateText(
      JSON.stringify({
        schema_version: 2,
        templates: [template.template, { ...template.template, id: "community-y", name: "第二个" }],
      }),
    );
    expect(many.errors).toEqual([]);
    expect(many.templates).toHaveLength(2);
  });

  it("拒绝重复 id / 未知顶层键 / 非法 id / 非法 source", () => {
    const base = {
      schema_version: 2,
      templates: [
        { id: "same-id", name: "A", mapping: OFFICIAL_TEMPLATES[0]!.mapping },
        { id: "same-id", name: "B", mapping: OFFICIAL_TEMPLATES[0]!.mapping },
      ],
    };
    const dup = parseTemplateText(JSON.stringify(base));
    expect(dup.errors.join("；")).toContain("id 重复");

    const unknown = parseTemplateText(JSON.stringify({ ...base, extra: 1 }));
    expect(unknown.errors.join("；")).toContain("extra 不是模板顶层合法键");

    const badId = parseTemplateText(
      JSON.stringify({ schema_version: 2, template: { id: "Bad ID", name: "x", mapping: {} } }),
    );
    expect(badId.errors.join("；")).toContain("id 必须是");

    const badSource = parseTemplateText(
      JSON.stringify({
        schema_version: 2,
        template: { id: "x", name: "x", source: "evil", mapping: {} },
      }),
    );
    expect(badSource.errors.join("；")).toContain("source 非法");
  });

  it("拒绝账户字段", () => {
    const bad = parseTemplateText(
      JSON.stringify({
        schema_version: 2,
        template: {
          id: "bad",
          name: "带账号",
          endpoint: "https://pay.example.com",
          channel_codes: { alipay: "1" },
          mapping: {},
        },
      }),
    );
    expect(bad.templates).toHaveLength(0);
    expect(bad.errors.join("；")).toContain("endpoint");
    expect(bad.errors.join("；")).toContain("channel_codes");
  });

  it("拒绝 mapping.channel_codes / 非法 JSON / 超大文件", () => {
    const bad = parseTemplateText(
      JSON.stringify({
        schema_version: 2,
        template: { id: "bad", name: "bad", mapping: { channel_codes: { alipay: "1" } } },
      }),
    );
    expect(bad.errors.join("；")).toContain("channel_codes");
    expect(parseTemplateText("{bad").errors).toContain("不是合法 JSON");
    expect(parseTemplateText(" ".repeat(70 * 1024)).errors.join("；")).toContain("64KB");
  });
});
