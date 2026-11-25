import { describe, expect, it } from "vitest";

import { buildAiSupportReport } from "../../web/src/ai-support";

describe("buildAiSupportReport", () => {
  it("包含排障所需信息，不包含文档全文", () => {
    const report = buildAiSupportReport({
      at: "2026-11-24T00:00:00.000Z",
      gatewayName: "易码付",
      model: "deepseek/deepseek-flash",
      attempts: 2,
      classification: "generic_mapping",
      templateName: "易码付聚合支付",
      templateId: "yimapay",
      gate: { status: "soft_gaps", missing: [], warnings: ["回调应答未说明"] },
      summary: [{ label: "下单", value: "POST /order" }],
      evidence: [{ section: "签名", quote: "MD5 排序" }],
      uncertainty: ["回调应答待确认"],
      input: {
        pasteChars: 0,
        fileChars: 100,
        files: [{ name: "创建订单", source: "url", url: "https://docs.example.com/order" }],
      },
      failure: null,
    });
    expect(report).toContain("易码付");
    expect(report).toContain("deepseek/deepseek-flash");
    expect(report).toContain("gate：soft_gaps");
    expect(report).toContain("POST /order");
    expect(report).toContain("MD5 排序");
    expect(report).toContain("https://docs.example.com/order");
    expect(report).toContain("不包含表单里的商户号/密钥");
    // 不传全文，报告里不应出现大段正文
    expect(report.length).toBeLessThan(3000);
  });

  it("失败时包含错误详情", () => {
    const report = buildAiSupportReport({
      at: "2026-11-24T00:00:00.000Z",
      summary: [],
      evidence: [],
      uncertainty: [],
      input: { pasteChars: 0, fileChars: 0, files: [] },
      failure: { title: "文档不足", details: ["缺少查单"] },
    });
    expect(report).toContain("失败：文档不足");
    expect(report).toContain("缺少查单");
  });
});
