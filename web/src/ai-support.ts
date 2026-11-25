/**
 * 复制给技术支持的诊断文本。
 *
 * 只放排障需要的信息：不放大段文档原文，也不放表单里的商户号/密钥。
 * evidence 引用可能含文档示例值，复制前提示用户确认。
 */
export interface AiSupportGate {
  status: "complete" | "soft_gaps" | "insufficient";
  missing: string[];
  warnings: string[];
}

export interface AiSupportInput {
  at: string;
  gatewayName?: string;
  model?: string;
  attempts?: number;
  classification?: string;
  templateName?: string;
  templateId?: string;
  gate?: AiSupportGate | null;
  summary: { label: string; value: string }[];
  evidence: { section: string; quote: string }[];
  uncertainty: string[];
  input: {
    pasteChars: number;
    fileChars: number;
    files: { name: string; source: "file" | "url"; url?: string }[];
  };
  failure?: { title: string; details: string[] } | null;
}

export function buildAiSupportReport(input: AiSupportInput): string {
  const lines: string[] = [
    "Clever VPN CRM · AI 配置助手诊断",
    `时间：${input.at}`,
    `网关：${input.gatewayName || "（未命名）"}`,
    `模型：${input.model || "（未知）"} / 尝试：${input.attempts ?? "（未知）"}`,
    `classification：${input.classification || "（无）"}`,
    `模板：${input.templateName || "（无）"}${input.templateId ? `（${input.templateId}）` : ""}`,
  ];

  if (input.gate) {
    lines.push(`gate：${input.gate.status}`);
    if (input.gate.missing.length) lines.push(`缺失：${input.gate.missing.join("；")}`);
    if (input.gate.warnings.length) lines.push(`警告：${input.gate.warnings.join("；")}`);
  }

  if (input.summary.length) {
    lines.push("", "配置摘要：");
    for (const row of input.summary) lines.push(`- ${row.label}：${row.value}`);
  }

  if (input.evidence.length) {
    lines.push("", "依据：");
    for (const e of input.evidence) lines.push(`- ${e.section}：${e.quote}`);
  }
  if (input.uncertainty.length) {
    lines.push("", "不确定点：");
    for (const u of input.uncertainty) lines.push(`- ${u}`);
  }

  lines.push(
    "",
    `输入：粘贴 ${input.input.pasteChars} 字 + 文件/页面 ${input.input.fileChars} 字`,
  );
  for (const f of input.input.files) {
    lines.push(`- [${f.source === "url" ? "URL" : "文件"}] ${f.name}${f.url ? `（${f.url}）` : ""}`);
  }

  if (input.failure) {
    lines.push("", `失败：${input.failure.title}`);
    for (const d of input.failure.details) lines.push(`- ${d}`);
  }

  lines.push(
    "",
    "注意：本报告可能包含接口文档原文片段或页面 URL，不包含表单里的商户号/密钥；",
    "发送前请确认没有敏感信息。",
  );
  return lines.join("\n");
}
