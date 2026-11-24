/**
 * 支付接口模板（只描述协议类型，不含网关实例值）。
 *
 * - 官方模板：qwgua、XArrPay，随 CRM 代码发布；
 * - 导入模板：文件/粘贴，校验后只用于预填表单，不写库；
 * - 模板不允许出现 endpoint / merchant / secret / methods / channel_codes。
 */
import type { GatewayMappingLike } from "./mapping-form";

export interface PaymentTemplate {
  schema_version: 2;
  id: string;
  name: string;
  description?: string;
  source: "official" | "imported" | "ai" | "community";
  mapping: GatewayMappingLike;
}

import qwgua from "./templates/qwgua.json";
import xarrpay from "./templates/xarrpay.json";

export const OFFICIAL_TEMPLATES: PaymentTemplate[] = [
  qwgua as unknown as PaymentTemplate,
  xarrpay as unknown as PaymentTemplate,
];

const ACCOUNT_KEYS = ["endpoint", "merchant_id", "user_id", "secret", "methods", "channel_codes"];
const TEMPLATE_KEYS = ["schema_version", "id", "name", "description", "source", "mapping"];
const TOP_SINGLE_KEYS = ["schema_version", ...TEMPLATE_KEYS];
const TOP_WRAPPER_KEYS = ["schema_version", "template", "templates"];
const SOURCE_VALUES = ["official", "community", "ai", "imported"];
const ID_RE = /^[a-z0-9][a-z0-9-]{0,63}$/;
const MAX_BYTES = 64 * 1024;

function isObject(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === "object" && !Array.isArray(v);
}

/**
 * 解析一个模板文件（单模板或 {templates:[...]}）。
 * 只校验“它是不是模板”；mapping 深校验交给服务端 validateMapping。
 */
export function parseTemplateText(raw: string): { templates: PaymentTemplate[]; errors: string[] } {
  const errors: string[] = [];
  if (new TextEncoder().encode(raw).length > MAX_BYTES) {
    return { templates: [], errors: ["模板文件不能超过 64KB"] };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw) as unknown;
  } catch {
    return { templates: [], errors: ["不是合法 JSON"] };
  }
  if (!isObject(parsed)) return { templates: [], errors: ["模板文件必须是对象"] };
  if (parsed.schema_version !== 2) errors.push("schema_version 必须为 2");

  const wrapped = Array.isArray(parsed.templates)
    ? parsed.templates
    : isObject(parsed.template)
      ? [parsed.template]
      : isObject(parsed.mapping)
        ? [parsed]
        : [];
  if (wrapped.length === 0) errors.push("找不到 template / templates[].mapping");
  const topAllowed = Array.isArray(parsed.templates) || isObject(parsed.template) ? TOP_WRAPPER_KEYS : TOP_SINGLE_KEYS;
  for (const key of Object.keys(parsed)) {
    if (!topAllowed.includes(key)) errors.push(`${key} 不是模板顶层合法键`);
  }

  const templates: PaymentTemplate[] = [];
  const ids = new Set<string>();
  for (const [i, item] of wrapped.entries()) {
    const prefix = wrapped.length > 1 ? `第 ${i + 1} 个模板：` : "";
    const startErrors = errors.length;
    if (!isObject(item)) {
      errors.push(`${prefix}必须是对象`);
      continue;
    }
    for (const key of Object.keys(item)) {
      if (!TEMPLATE_KEYS.includes(key)) errors.push(`${prefix}${key} 不是模板合法键`);
      if (ACCOUNT_KEYS.includes(key)) errors.push(`${prefix}模板不能包含账户字段 ${key}（应在基本信息填写）`);
    }
    if (item.schema_version !== undefined && item.schema_version !== 2) {
      errors.push(`${prefix}schema_version 必须为 2`);
    }
    if (isObject(item.mapping) && "channel_codes" in item.mapping) {
      errors.push(`${prefix}mapping 不能包含 channel_codes（通道号属于网关实例）`);
    }
    if (!isObject(item.mapping)) {
      errors.push(`${prefix}mapping 必填且必须是对象`);
      continue;
    }
    const id = typeof item.id === "string" ? item.id.trim() : "";
    const name = typeof item.name === "string" ? item.name.trim() : "";
    if (!ID_RE.test(id)) errors.push(`${prefix}id 必须是 1–64 位小写字母/数字/连字符`);
    if (!name) errors.push(`${prefix}name 必填`);
    if (name.length > 80) errors.push(`${prefix}name 不能超过 80 字`);
    if (item.description !== undefined && typeof item.description !== "string") {
      errors.push(`${prefix}description 必须是字符串`);
    }
    if (item.source !== undefined && !SOURCE_VALUES.includes(String(item.source))) {
      errors.push(`${prefix}source 非法`);
    }
    if (ids.has(id)) errors.push(`${prefix}id 重复：${id}`);
    ids.add(id);
    if (errors.length > startErrors) continue;
    templates.push({
      schema_version: 2,
      id,
      name,
      description: typeof item.description === "string" ? item.description : undefined,
      source: "imported",
      mapping: item.mapping as unknown as GatewayMappingLike,
    });
  }
  return { templates, errors };
}
