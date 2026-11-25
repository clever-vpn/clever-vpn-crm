import { describe, expect, it } from "vitest";

import { evaluateAiDraft } from "../../src/payments/ai-gate";
import type { AiDraft } from "../../src/payments/ai";
import type { GatewayMapping } from "../../src/payments/mapping";
import { QWGUA_MAPPING } from "./fixtures";

const DOC = [
  "2.1 创建订单：POST /pay/create，成功 code=200，返回 data.payUrl 收银台地址与 data.sign 签名。",
  "2.2 支付通知：status=3 表示成功，我方返回 success。",
  "2.3 查询订单：POST /pay/query，data.status=3 表示已付。",
].join("\n");

function draftWith(mapping: GatewayMapping = structuredClone(QWGUA_MAPPING)): AiDraft {
  return {
    classification: "generic_mapping",
    template: {
      schema_version: 2,
      id: "test-pay",
      name: "测试支付",
      source: "ai",
      mapping,
    },
    evidence: [
      { section: "2.1", quote: "POST /pay/create" },
      { section: "2.2", quote: "我方返回 success" },
    ],
    uncertainty: [],
  };
}

describe("evaluateAiDraft", () => {
  it("结构合法、文档有依据 → complete", () => {
    const report = evaluateAiDraft(DOC, draftWith());
    expect(report, report.warnings.join("；")).toEqual({
      status: "complete",
      missing: [],
      warnings: [],
    });
  });

  it("classification 不是通用映射 → insufficient", () => {
    const draft = draftWith();
    draft.classification = "driver";
    draft.template = null;
    const report = evaluateAiDraft(DOC, draft);
    expect(report.status).toBe("insufficient");
    expect(report.missing.join("；")).toContain("不是通用映射");
  });

  it("pay_url 指向对象前缀/文档没写叶子字段 → soft_gaps", () => {
    const mapping = structuredClone(QWGUA_MAPPING);
    const payUrl = mapping.create.response.fields.find((f) => f.role === "pay_url")!;
    payUrl.field = "datas";
    const report = evaluateAiDraft("datas JSONObject；POST /pay/create；签名；success", draftWith(mapping));
    expect(report.status).toBe("soft_gaps");
    expect(report.warnings.join("；")).toContain("对象");
  });

  it("嵌套 response.sign 缺 data_path → soft_gaps", () => {
    const mapping = structuredClone(QWGUA_MAPPING);
    delete mapping.create.response.sign!.data_path;
    const report = evaluateAiDraft(DOC, draftWith(mapping));
    expect(report.status).toBe("soft_gaps");
    expect(report.warnings.join("；")).toContain("data_path");
  });

  it("顶层 sign + data_path=data 合法，不应误报（布拉格/华俊式）", () => {
    const mapping = structuredClone(QWGUA_MAPPING);
    mapping.create.response.sign = { field: "sign", data_path: "data" };
    mapping.query!.response.sign = { field: "sign", data_path: "data" };
    const report = evaluateAiDraft(DOC, draftWith(mapping));
    expect(report.warnings.join("；")).not.toContain("data_path");
  });

  it("回调应答原文不在文档 → soft_gaps", () => {
    const doc = DOC.replace("我方返回 success", "我方返回任意文本");
    const report = evaluateAiDraft(doc, draftWith());
    expect(report.status).toBe("soft_gaps");
    expect(report.warnings.join("；")).toContain("应答原文");
  });

  it("文档含 HTML 实体时，quote 用渲染后的 &/空格 仍能匹配", () => {
    const doc = `${DOC}
签名：在stringA最后拼接上key[即 StringA + "&amp;key=" + 私钥 ]&nbsp;得到stringSignTemp字符串。`;
    const draft = draftWith();
    draft.evidence = [{
      section: "签名",
      quote: '在stringA最后拼接上key[即 StringA + "&key=" + 私钥 ] 得到stringSignTemp字符串',
    }];
    const report = evaluateAiDraft(doc, draft);
    expect(report.warnings.join("；")).not.toContain("evidence");
  });

  it("evidence 引用伪造 → soft_gaps", () => {
    const draft = draftWith();
    draft.evidence = [{ section: "x", quote: "这句话文档里没有" }];
    const report = evaluateAiDraft(DOC, draft);
    expect(report.status).toBe("soft_gaps");
    expect(report.warnings.join("；")).toContain("evidence");
  });

  it("key_append 写成占位符 → soft_gaps", () => {
    const mapping = structuredClone(QWGUA_MAPPING);
    mapping.create.request.sign.key_append = "{secret}";
    const report = evaluateAiDraft(DOC, draftWith(mapping));
    expect(report.status).toBe("soft_gaps");
    expect(report.warnings.join("；")).toContain("key_append");
  });

  it("有 warnings 但 uncertainty 为空 → 补一条提示", () => {
    const doc = DOC.replace("我方返回 success", "我方返回任意文本");
    const report = evaluateAiDraft(doc, draftWith());
    expect(report.warnings.join("；")).toContain("没有标注 uncertainty");
  });
});
