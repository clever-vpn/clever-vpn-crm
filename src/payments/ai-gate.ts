/**
 * AI 草稿的 completeness gate：**规则裁决，不是模型自评**。
 *
 * 模型只负责提出 mapping / evidence / uncertainty；这个文件用文档原文做
 * 确定性回查，回答「这份草稿能不能直接应用、哪些地方是猜的」。
 *
 * 不调用模型、不写库、不读租户数据；不替代 `validateMapping`：
 *   - `validateMapping` 管「结构合法」；
 *   - gate 管「事实有没有文档依据、文档是否缺关键信息」。
 */

import { validateMapping, type GatewayMapping } from "./mapping";

import type { AiDraft } from "./ai";

export type AiGateStatus = "complete" | "soft_gaps" | "insufficient";

export interface AiGateReport {
  status: AiGateStatus;
  /** 硬缺失：不能应用 */
  missing: string[];
  /** 软缺失 / 未证实：可应用但必须提示 */
  warnings: string[];
}

const MAX_EVIDENCE_WARNINGS = 3;
const DOC_GAP_PHRASES = [
  "请联系客服",
  "联系客服获取",
  "未提供",
  "未说明",
  "待补充",
  "暂未",
  "tbd",
  "todo",
];

function decodeEntities(text: string): string {
  return text
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#0*39;|&apos;/gi, "'")
    .replace(/&hellip;/gi, "…");
}

function normalize(text: string): string {
  return decodeEntities(text).replace(/\u00a0/g, " ").replace(/\s+/g, " ").trim().toLowerCase();
}

function contains(haystack: string, needle: string): boolean {
  const n = normalize(needle);
  return n.length > 0 && normalize(haystack).includes(n);
}

/** evidence 引用比对：忽略空白、标点、引号；省略号只比最长的一段。 */
function normalizeEvidence(text: string): string {
  return decodeEntities(text)
    .toLowerCase()
    .replace(/[\u00a0\s]+/g, " ")
    .replace(/[`"'“”‘’]/g, "")
    .replace(/[，。、；：（）()【】\[\]{}<>《》!?！？,;:]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function evidenceContains(doc: string, quote: string): boolean {
  const segments = quote
    .split(/…|\.\.\./)
    .map((s) => s.trim())
    .filter((s) => s.length > 0)
    .sort((a, b) => b.length - a.length);
  const needle = normalizeEvidence(segments[0] ?? quote);
  return needle.length > 0 && normalizeEvidence(doc).includes(needle);
}

function lastSegment(path: string): string {
  const parts = path.split(".");
  return parts[parts.length - 1] ?? path;
}

function pushUnique(list: string[], message: string): void {
  if (!list.includes(message)) list.push(message);
}

function responseSignWarnings(
  mapping: GatewayMapping,
  doc: string,
  warnings: string[],
): void {
  const hasDocSign = /签名|验签|sign/i.test(doc);
  for (const [label, sign] of [
    ["create.response.sign", mapping.create.response.sign],
    ["query.response.sign", mapping.query?.response.sign],
  ] as const) {
    if (!sign) continue;
    const field = String(sign.field ?? "");
    const dataPath = String(sign.data_path ?? "");
    if (field.includes(".") && !dataPath) {
      pushUnique(warnings, `${label}.field=${field} 是嵌套路径，但没写 data_path；请核对验签对象`);
    }
    if (field.includes(".") && dataPath && !field.startsWith(`${dataPath}.`)) {
      pushUnique(warnings, `${label}.data_path=${dataPath} 不是 field=${field} 的父路径`);
    }
    if (!hasDocSign) {
      pushUnique(warnings, `配置了 ${label}，但文档里找不到“签名/验签/sign”依据`);
    }
  }
  const signConfigured = Boolean(mapping.create.response.sign || mapping.query?.response.sign);
  if (!signConfigured && /响应签名|响应验签/.test(doc)) {
    pushUnique(warnings, "文档提到“响应签名/响应验签”，但没配置 response.sign");
  }
}

function payUrlWarnings(mapping: GatewayMapping, doc: string, warnings: string[]): void {
  const groups: { label: string; fields: GatewayMapping["create"]["response"]["fields"] }[] = [
    { label: "create.response", fields: mapping.create.response.fields },
  ];
  if (mapping.query) groups.push({ label: "query.response", fields: mapping.query.response.fields });

  for (const group of groups) {
    const payUrls = group.fields.filter((f) => f.role === "pay_url");
    for (const field of payUrls) {
      const path = field.field;
      const parentPrefix = group.fields.some(
        (other) => other.field !== path && other.field.startsWith(`${path}.`),
      );
      if (parentPrefix) {
        pushUnique(warnings, `${group.label}.pay_url=${path} 是对象前缀，不是具体收银台字段；请核对`);
      }
      const leaf = lastSegment(path);
      if (!contains(doc, path) && !contains(doc, leaf)) {
        pushUnique(warnings, `${group.label}.pay_url=${path} 在文档里找不到依据；请向厂商确认收银台字段`);
      }
      // 文档只写「datas 是 JSONObject / 对象」而没列子字段
      const escaped = path.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      const objectOnly = new RegExp(`${escaped}\\s*(jsonobject|对象|object)`, "i").test(doc);
      if (!path.includes(".") && objectOnly) {
        pushUnique(warnings,
          `${group.label}.pay_url=${path} 文档只说明它是对象，未列具体收银台字段；请向厂商索取字段说明`);
      }
    }
  }
}

function signKeyAppendWarnings(mapping: GatewayMapping, warnings: string[]): void {
  const specs: [string, unknown][] = [
    ["create.request.sign", mapping.create.request.sign],
    ["notify.request.sign", mapping.notify.request.sign],
    ["query.request.sign", mapping.query?.request.sign],
  ];
  for (const [label, sign] of specs) {
    if (!sign || typeof sign !== "object" || !("key_append" in sign)) continue;
    const keyAppend = String((sign as { key_append?: unknown }).key_append ?? "");
    if (keyAppend.includes("{secret}") || keyAppend.includes("{key}")) {
      pushUnique(warnings, `${label}.key_append 不能写 {secret}/{key}；密钥由运行时追加，这里只写分隔符`);
    }
  }
}

function evidenceWarnings(doc: string, draft: AiDraft, warnings: string[]): void {
  if (draft.evidence.length === 0) {
    pushUnique(warnings, "AI 没有给出 evidence：关键映射无法回溯到文档原文");
    return;
  }
  let shown = 0;
  for (const ev of draft.evidence) {
    // 引用末尾的省略号不参与匹配；中间有省略号的整句匹配失败时由人核对。
    const quote = ev.quote.replace(/[.…]+$/u, "").trim();
    if (quote && !evidenceContains(doc, quote)) {
      if (shown < MAX_EVIDENCE_WARNINGS) {
        pushUnique(warnings, `evidence 引用在文档里找不到：${ev.section}「${quote.slice(0, 60)}」`);
      }
      shown += 1;
    }
  }
  if (shown > MAX_EVIDENCE_WARNINGS) {
    pushUnique(warnings, `还有 ${shown - MAX_EVIDENCE_WARNINGS} 条 evidence 引用无法在文档中定位`);
  }
}

function replyWarning(mapping: GatewayMapping, doc: string, warnings: string[]): void {
  const reply = mapping.notify.response.reply;
  if (!contains(doc, reply)) {
    pushUnique(warnings, `通知应答原文 ${JSON.stringify(reply)} 在文档里找不到；写错会被厂商无限重推`);
  }
}

function docGapWarnings(doc: string, warnings: string[]): void {
  const hits: string[] = [];
  for (const phrase of DOC_GAP_PHRASES) {
    if (doc.toLowerCase().includes(phrase)) hits.push(phrase);
    if (hits.length >= 3) break;
  }
  if (hits.length > 0) {
    pushUnique(warnings, `文档自述可能不完整（出现：${hits.join("、")}）；请向厂商索取更完整的文档`);
  }
}

/** 文档 + AI 草稿 → 完整性报告。 */
export function evaluateAiDraft(document: string, draft: AiDraft): AiGateReport {
  const missing: string[] = [];
  const warnings: string[] = [];

  if (draft.classification !== "generic_mapping" || draft.template === null) {
    missing.push(
      `classification=${draft.classification}：不是通用映射，无法用接口配置表单应用`,
    );
    return { status: "insufficient", missing, warnings };
  }

  const mapping = draft.template.mapping;
  const validated = validateMapping(mapping);
  if (!validated.ok) {
    missing.push(...validated.errors.map((e) => `mapping 不合法：${e}`));
    return { status: "insufficient", missing, warnings };
  }

  const doc = normalize(document);
  responseSignWarnings(mapping, document, warnings);
  payUrlWarnings(mapping, document, warnings);
  signKeyAppendWarnings(mapping, warnings);
  evidenceWarnings(doc, draft, warnings);
  replyWarning(mapping, document, warnings);
  docGapWarnings(document, warnings);

  if (warnings.length > 0 && draft.uncertainty.length === 0) {
    pushUnique(warnings, "AI 没有标注 uncertainty，但存在未证实项；请人工核对");
  }

  return {
    status: warnings.length > 0 ? "soft_gaps" : "complete",
    missing,
    warnings,
  };
}
