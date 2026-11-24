/**
 * 支付网关映射解释器（`driver = generic_json_v1`）—— v2。
 *
 * 根只有 create / notify / query；每个 API 分 request / response。
 * 字段用统一的 FieldSpec：field = 请求 body 字段名 / 响应路径，role 说明语义，
 * amount/timestamp/nonce 等差异放在字段属性里，不再有全局 amount_unit/sign。
 */

import { SIGN_ALGOS, signParams, verifyParams, type SignAlgo, type SignSpec } from "./sign";

export const DRIVERS = ["epay_v1", "epay_v2", "generic_json_v1", "stripe", "paypal", "manual"] as const;
export type Driver = (typeof DRIVERS)[number];

export const AMOUNT_UNITS = ["yuan", "cent"] as const;
export type AmountUnit = (typeof AMOUNT_UNITS)[number];

export type BodyFormat = "form" | "json";
export type HttpMethod = "GET" | "POST";
export type TimestampFormat = "s" | "ms" | "ymdhms";

export interface WhenSpec {
  path: string;
  equals?: string | number;
  in?: (string | number)[];
}

export type FieldRole =
  | "merchant" | "order_no" | "amount" | "subject" | "body"
  | "notify_url" | "return_url" | "client_ip" | "channel"
  | "timestamp" | "nonce" | "pay_url" | "trade_no" | "expires_at" | "message";

export interface FieldSpec {
  /** 请求：body/form 实际字段名；响应：点号路径 */
  field: string;
  /** 语义角色；常量可省略 */
  role?: FieldRole;
  /** 请求：占位符或字面量；响应不写 */
  value?: string;
  /** amount：yuan / cent */
  unit?: AmountUnit;
  /** timestamp：s / ms / ymdhms */
  format?: TimestampFormat;
  /** timestamp：ymdhms 固定 Asia/Shanghai */
  timezone?: string;
  /** nonce：十六进制长度，默认 32 */
  length?: number;
  /** JSON 请求里按数字发送 */
  numeric?: boolean;
}

export interface AuthSpec {
  header: string;
  value: string;
}

export interface SignResponseSpec {
  /** 响应里签名字段的路径；必填 */
  field: string;
  /** 被签名对象路径；不写 = 整个响应体 */
  data_path?: string;
  /** 验签算法；不写 = 沿用同端点 request.sign */
  spec?: SignSpec;
}

interface RequestCommon {
  method?: HttpMethod;
  format?: BodyFormat;
  auth?: AuthSpec;
}

export interface CreateRequest extends RequestCommon {
  path: string;
  fields: FieldSpec[];
  sign: SignSpec;
}

export interface CreateResponse {
  ok: WhenSpec;
  fields: FieldSpec[];
  sign?: SignResponseSpec;
}

export interface NotifyRequest {
  method?: HttpMethod;
  format?: BodyFormat;
  fields: FieldSpec[];
  paid_when: WhenSpec;
  sign: SignSpec;
}

export interface NotifyResponse {
  reply: string;
}

export type QuerySign = SignSpec | { mode: "none" };

export interface QueryRequest extends RequestCommon {
  path: string;
  fields: FieldSpec[];
  sign: QuerySign;
}

export interface QueryResponse {
  ok?: WhenSpec;
  paid_when: WhenSpec;
  terminal_when?: WhenSpec;
  fields: FieldSpec[];
  sign?: SignResponseSpec;
}

export interface GatewayMapping {
  create: { request: CreateRequest; response: CreateResponse };
  notify: { request: NotifyRequest; response: NotifyResponse };
  /** mock/历史数据可以没有；generic 新配置由 validateMapping 要求必填 */
  query?: { request: QueryRequest; response: QueryResponse };
}

export interface MappingValidationOptions {
  /** 仅易支付 V1 preset：查单不签名 */
  allowUnsignedQuery?: boolean;
}

// ─────────────────────────────────────────────────────────────
// 读值 / 比对 / 金额 / 时间
// ─────────────────────────────────────────────────────────────

export function readPath(payload: unknown, path: string): unknown {
  let cur: unknown = payload;
  for (const seg of path.split(".")) {
    if (cur === null || typeof cur !== "object") return undefined;
    cur = (cur as Record<string, unknown>)[seg];
  }
  return cur;
}

export function matchesWhen(spec: WhenSpec | undefined, payload: unknown): boolean {
  if (!spec) return false;
  const actual = readPath(payload, spec.path);
  if (actual === undefined || actual === null) return false;
  const a = String(actual);
  if (spec.in && spec.in.length > 0) return spec.in.some((v) => String(v) === a);
  if (spec.equals !== undefined) return String(spec.equals) === a;
  return false;
}

export function formatAmount(minor: number, unit: AmountUnit): string | number {
  return unit === "cent" ? Math.round(minor) : (minor / 100).toFixed(2);
}

export function parseAmount(raw: unknown, unit: AmountUnit): number | null {
  if (raw === undefined || raw === null || raw === "") return null;
  const n = Number(String(raw).trim());
  if (!Number.isFinite(n)) return null;
  return unit === "cent" ? Math.round(n) : Math.round(n * 100);
}

function formatTimestamp(now: Date, format: TimestampFormat = "s"): string {
  if (format === "ms") return String(now.getTime());
  if (format === "s") return String(Math.floor(now.getTime() / 1000));
  const d = new Date(now.getTime() + 8 * 3600_000);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getUTCFullYear()}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}${p(
    d.getUTCHours(),
  )}${p(d.getUTCMinutes())}${p(d.getUTCSeconds())}`;
}

function randomHex(length = 32): string {
  const chars = Math.max(2, Math.ceil(length / 2));
  const buf = new Uint8Array(chars);
  crypto.getRandomValues(buf);
  return [...buf].map((b) => b.toString(16).padStart(2, "0")).join("").slice(0, length);
}

// ─────────────────────────────────────────────────────────────
// 校验
// ─────────────────────────────────────────────────────────────

export type MappingValidation = { ok: true; mapping: GatewayMapping } | { ok: false; errors: string[] };

const isNonEmptyStr = (v: unknown): v is string => typeof v === "string" && v.trim() !== "";
const isStrOrNum = (v: unknown): v is string | number => typeof v === "string" || typeof v === "number";

const TOP_KEYS = ["create", "notify", "query"] as const;
const API_KEYS = ["request", "response"] as const;
const REQUEST_COMMON_KEYS = ["method", "format", "auth"] as const;
const CREATE_REQUEST_KEYS = [...REQUEST_COMMON_KEYS, "path", "fields", "sign"] as const;
const NOTIFY_REQUEST_KEYS = ["method", "format", "fields", "paid_when", "sign"] as const;
const QUERY_REQUEST_KEYS = [...REQUEST_COMMON_KEYS, "path", "fields", "sign"] as const;
const FIELD_KEYS = ["field", "role", "value", "unit", "format", "timezone", "length", "numeric"] as const;
const RESPONSE_KEYS = ["ok", "fields", "sign"] as const;
const NOTIFY_RESPONSE_KEYS = ["reply"] as const;
const QUERY_RESPONSE_KEYS = ["ok", "paid_when", "terminal_when", "fields", "sign"] as const;
const SIGN_KEYS = ["field", "algo", "key_append", "exclude", "upper", "encode"] as const;
const AUTH_KEYS = ["header", "value"] as const;
const RESPONSE_SIGN_KEYS = ["field", "data_path", "spec"] as const;
const WHEN_KEYS = ["path", "equals", "in"] as const;
const ROLES: readonly FieldRole[] = [
  "merchant", "order_no", "amount", "subject", "body",
  "notify_url", "return_url", "client_ip", "channel",
  "timestamp", "nonce", "pay_url", "trade_no", "expires_at", "message",
];

function unknownErrors(value: unknown, allowed: readonly string[], prefix: string): string[] {
  if (!value || typeof value !== "object" || Array.isArray(value)) return [];
  return Object.keys(value)
    .filter((key) => !allowed.includes(key))
    .map((key) => `${prefix}${key} 不是合法键（未知键）`);
}

function checkWhenShape(spec: unknown, label: string, errors: string[]): void {
  if (spec === undefined) return;
  if (!spec || typeof spec !== "object" || Array.isArray(spec)) {
    errors.push(`${label} 必须是对象`);
    return;
  }
  errors.push(...unknownErrors(spec, WHEN_KEYS, `${label}.`));
  const s = spec as WhenSpec;
  if (s.equals !== undefined && s.in !== undefined) errors.push(`${label} 不能同时有 equals 和 in（二选一）`);
  if (s.equals !== undefined && !isStrOrNum(s.equals)) errors.push(`${label}.equals 只能是字符串或数字`);
  if (s.in !== undefined && (!Array.isArray(s.in) || s.in.some((v) => !isStrOrNum(v)))) {
    errors.push(`${label}.in 只能是字符串/数字数组`);
  }
}

function whenRequiredCheck(spec: WhenSpec | undefined, label: string, errors: string[]): void {
  if (!spec || typeof spec !== "object" || Array.isArray(spec)) {
    errors.push(`${label} 必填`);
    return;
  }
  if (!isNonEmptyStr(spec.path)) errors.push(`${label}.path 必填`);
  if (spec.equals === undefined && (!spec.in || spec.in.length === 0)) {
    errors.push(`${label} 需要 equals 或 in`);
  }
}

function checkSignSpec(spec: unknown, label: string, errors: string[]): void {
  if (!spec || typeof spec !== "object" || Array.isArray(spec)) {
    errors.push(`${label} 必须是对象`);
    return;
  }
  errors.push(...unknownErrors(spec, SIGN_KEYS, `${label}.`));
  const s = spec as SignSpec;
  if (s.field !== undefined && !isNonEmptyStr(s.field)) errors.push(`${label}.field 必须是非空字符串`);
  if (s.algo !== undefined && !SIGN_ALGOS.includes(s.algo as SignAlgo)) errors.push(`${label}.algo 只能是 ${SIGN_ALGOS.join(" / ")}`);
  if (s.key_append !== undefined && typeof s.key_append !== "string") errors.push(`${label}.key_append 必须是字符串`);
  if (s.exclude !== undefined && (!Array.isArray(s.exclude) || s.exclude.some((x) => typeof x !== "string"))) {
    errors.push(`${label}.exclude 必须是字符串数组`);
  }
  if (s.upper !== undefined && typeof s.upper !== "boolean") errors.push(`${label}.upper 只能是布尔值`);
  if (s.encode !== undefined && typeof s.encode !== "boolean") errors.push(`${label}.encode 只能是布尔值`);
}

function checkResponseSign(spec: unknown, label: string, errors: string[]): void {
  if (spec === undefined) return;
  if (!spec || typeof spec !== "object" || Array.isArray(spec)) {
    errors.push(`${label} 必须是对象`);
    return;
  }
  errors.push(...unknownErrors(spec, RESPONSE_SIGN_KEYS, `${label}.`));
  const s = spec as SignResponseSpec;
  if (!isNonEmptyStr(s.field)) errors.push(`${label}.field 必填（响应签名路径）`);
  if (s.data_path !== undefined && typeof s.data_path !== "string") errors.push(`${label}.data_path 必须是字符串`);
  if (s.spec !== undefined) checkSignSpec(s.spec, `${label}.spec`, errors);
}

function checkAuth(value: unknown, label: string, errors: string[]): void {
  if (value === undefined) return;
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    errors.push(`${label} 必须是对象`);
    return;
  }
  errors.push(...unknownErrors(value, AUTH_KEYS, `${label}.`));
  const a = value as AuthSpec;
  if (!isNonEmptyStr(a.header) || !isNonEmptyStr(a.value)) {
    errors.push(`${label}.header / value 必须同时填写`);
  }
}

function checkField(value: unknown, label: string, errors: string[], request: boolean): FieldSpec | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    errors.push(`${label} 必须是对象`);
    return null;
  }
  errors.push(...unknownErrors(value, FIELD_KEYS, `${label}.`));
  const f = value as FieldSpec;
  if (!isNonEmptyStr(f.field)) errors.push(`${label}.field 必填`);
  if (f.role !== undefined && !ROLES.includes(f.role)) errors.push(`${label}.role 非法`);
  if (f.value !== undefined && typeof f.value !== "string") errors.push(`${label}.value 必须是字符串`);
  if (!request && f.value !== undefined) errors.push(`${label}.value 只能出现在请求字段里`);
  if (request && f.value === undefined && f.role === undefined) {
    // 常量：没有 role/value 不合法；常量必须至少体现“字面量”
    errors.push(`${label} 需要 value（常量）或 role`);
  }
  if (f.unit !== undefined && !AMOUNT_UNITS.includes(f.unit)) errors.push(`${label}.unit 只能是 yuan / cent`);
  if (f.format !== undefined && !["s", "ms", "ymdhms"].includes(f.format)) errors.push(`${label}.format 只能是 s / ms / ymdhms`);
  if (f.timezone !== undefined && typeof f.timezone !== "string") errors.push(`${label}.timezone 必须是字符串`);
  if (f.length !== undefined && (!Number.isInteger(f.length) || f.length < 2)) errors.push(`${label}.length 必须是 >=2 的整数`);
  if (f.numeric !== undefined && typeof f.numeric !== "boolean") errors.push(`${label}.numeric 只能是布尔值`);
  if (f.role === "amount" && f.unit === undefined) errors.push(`${label}.unit 必填（amount 字段必须有单位）`);
  return f;
}

function checkFields(value: unknown, label: string, errors: string[], request: boolean): FieldSpec[] {
  if (!Array.isArray(value)) {
    errors.push(`${label} 必须是数组`);
    return [];
  }
  const out: FieldSpec[] = [];
  const seen = new Set<string>();
  for (const [i, item] of value.entries()) {
    const f = checkField(item, `${label}[${i}]`, errors, request);
    if (f) {
      if (seen.has(f.field)) errors.push(`${label}[${i}].field 重复：${f.field}`);
      seen.add(f.field);
      out.push(f);
    }
  }
  return out;
}

function hasRole(fields: FieldSpec[], role: FieldRole): boolean {
  return fields.some((f) => f.role === role);
}

export function validateMapping(input: unknown, opts: MappingValidationOptions = {}): MappingValidation {
  const errors: string[] = [];
  const m = (input && typeof input === "object" && !Array.isArray(input) ? input : {}) as Partial<GatewayMapping>;
  errors.push(...unknownErrors(input, TOP_KEYS, ""));

  const create = m.create;
  if (!create || typeof create !== "object" || Array.isArray(create)) {
    errors.push("create 必须是对象");
  } else {
    errors.push(...unknownErrors(create, API_KEYS, "create."));
    const req = create.request;
    if (!req || typeof req !== "object" || Array.isArray(req)) {
      errors.push("create.request 必须是对象");
    } else {
      errors.push(...unknownErrors(req, CREATE_REQUEST_KEYS, "create.request."));
      if (!isNonEmptyStr(req.path)) errors.push("create.request.path 必填");
      if (req.method !== undefined && !["GET", "POST"].includes(String(req.method))) errors.push("create.request.method 只能是 GET / POST");
      if (req.format !== undefined && !["form", "json"].includes(String(req.format))) errors.push("create.request.format 只能是 form / json");
      checkAuth(req.auth, "create.request.auth", errors);
      const fields = checkFields(req.fields, "create.request.fields", errors, true);
      for (const role of ["merchant", "order_no", "amount"] as const) {
        if (!hasRole(fields, role)) errors.push(`create.request.fields 缺少 role=${role}`);
      }
      if (!req.sign || typeof req.sign !== "object" || Array.isArray(req.sign)) {
        errors.push("create.request.sign 必填");
      } else {
        checkSignSpec(req.sign, "create.request.sign", errors);
      }
    }
    const resp = create.response;
    if (!resp || typeof resp !== "object" || Array.isArray(resp)) {
      errors.push("create.response 必须是对象");
    } else {
      errors.push(...unknownErrors(resp, RESPONSE_KEYS, "create.response."));
      checkWhenShape(resp.ok, "create.response.ok", errors);
      whenRequiredCheck(resp.ok, "create.response.ok", errors);
      const fields = checkFields(resp.fields, "create.response.fields", errors, false);
      if (!hasRole(fields, "pay_url")) errors.push("create.response.fields 缺少 role=pay_url");
      checkResponseSign(resp.sign, "create.response.sign", errors);
    }
  }

  const notify = m.notify;
  if (!notify || typeof notify !== "object" || Array.isArray(notify)) {
    errors.push("notify 必须是对象");
  } else {
    errors.push(...unknownErrors(notify, API_KEYS, "notify."));
    const req = notify.request;
    if (!req || typeof req !== "object" || Array.isArray(req)) {
      errors.push("notify.request 必须是对象");
    } else {
      errors.push(...unknownErrors(req, NOTIFY_REQUEST_KEYS, "notify.request."));
      if (req.method !== undefined && !["GET", "POST"].includes(String(req.method))) errors.push("notify.request.method 只能是 GET / POST");
      if (req.format !== undefined && !["form", "json"].includes(String(req.format))) errors.push("notify.request.format 只能是 form / json");
      const fields = checkFields(req.fields, "notify.request.fields", errors, true);
      if (!hasRole(fields, "order_no")) errors.push("notify.request.fields 缺少 role=order_no");
      checkWhenShape(req.paid_when, "notify.request.paid_when", errors);
      whenRequiredCheck(req.paid_when, "notify.request.paid_when", errors);
      if (!req.sign || typeof req.sign !== "object" || Array.isArray(req.sign)) {
        errors.push("notify.request.sign 必填");
      } else {
        checkSignSpec(req.sign, "notify.request.sign", errors);
      }
    }
    const resp = notify.response;
    if (!resp || typeof resp !== "object" || Array.isArray(resp)) {
      errors.push("notify.response 必须是对象");
    } else {
      errors.push(...unknownErrors(resp, NOTIFY_RESPONSE_KEYS, "notify.response."));
      if (!isNonEmptyStr(resp.reply)) errors.push("notify.response.reply 必填（应答原文）");
    }
  }

  const query = m.query;
  if (!query || typeof query !== "object" || Array.isArray(query)) {
    errors.push("query 必须是对象");
  } else {
    errors.push(...unknownErrors(query, API_KEYS, "query."));
    const req = query.request;
    if (!req || typeof req !== "object" || Array.isArray(req)) {
      errors.push("query.request 必须是对象");
    } else {
      errors.push(...unknownErrors(req, QUERY_REQUEST_KEYS, "query.request."));
      if (!isNonEmptyStr(req.path)) errors.push("query.request.path 必填");
      if (req.method !== undefined && !["GET", "POST"].includes(String(req.method))) errors.push("query.request.method 只能是 GET / POST");
      if (req.format !== undefined && !["form", "json"].includes(String(req.format))) errors.push("query.request.format 只能是 form / json");
      checkAuth(req.auth, "query.request.auth", errors);
      const fields = checkFields(req.fields, "query.request.fields", errors, true);
      const amount = fields.filter((f) => f.role === "amount");
      if (amount.length > 1) errors.push("query.request.fields 只能有一个 role=amount");
      const sign = req.sign as unknown;
      if (sign && typeof sign === "object" && !Array.isArray(sign) && "mode" in sign) {
        if ((sign as { mode: string }).mode !== "none") errors.push('query.request.sign.mode 只能是 "none"');
        else if (!opts.allowUnsignedQuery) errors.push('query.request.sign={mode:"none"} 只允许易支付 V1 preset');
      } else {
        checkSignSpec(sign, "query.request.sign", errors);
      }
    }
    const resp = query.response;
    if (!resp || typeof resp !== "object" || Array.isArray(resp)) {
      errors.push("query.response 必须是对象");
    } else {
      errors.push(...unknownErrors(resp, QUERY_RESPONSE_KEYS, "query.response."));
      checkWhenShape(resp.ok, "query.response.ok", errors);
      checkWhenShape(resp.paid_when, "query.response.paid_when", errors);
      checkWhenShape(resp.terminal_when, "query.response.terminal_when", errors);
      whenRequiredCheck(resp.paid_when, "query.response.paid_when", errors);
      if (resp.terminal_when !== undefined) whenRequiredCheck(resp.terminal_when, "query.response.terminal_when", errors);
      checkFields(resp.fields, "query.response.fields", errors, false);
      checkResponseSign(resp.sign, "query.response.sign", errors);
    }
  }

  if (errors.length) return { ok: false, errors };
  return { ok: true, mapping: m as GatewayMapping };
}

// ─────────────────────────────────────────────────────────────
// 下单
// ─────────────────────────────────────────────────────────────

export interface ChargeContext {
  merchant: string;
  secret: string;
  orderNo: string;
  amountMinor: number;
  currency: string;
  subject: string;
  method: string;
  notifyUrl: string;
  returnUrl?: string;
  clientIp?: string;
  endpoint: string;
  channelCodes?: Record<string, string | number>;
  now: Date;
}

export interface BuiltRequest {
  url: string;
  method: HttpMethod;
  headers: Record<string, string>;
  body: string | null;
}

function joinUrl(endpoint: string, path: string): string {
  return `${endpoint.replace(/\/+$/, "")}/${path.replace(/^\/+/, "")}`;
}

function baseHeaders(auth: AuthSpec | undefined, secret: string): Record<string, string> {
  const headers: Record<string, string> = {};
  if (auth) headers[auth.header] = auth.value.replace(/\{key\}/g, secret);
  return headers;
}

function coerceNumeric(params: Record<string, unknown>, fields: FieldSpec[], format: BodyFormat): Record<string, unknown> {
  if (format !== "json") return params;
  const out = { ...params };
  for (const f of fields) {
    if (!f.numeric) continue;
    const value = out[f.field];
    if (value === undefined || value === null || value === "") continue;
    const n = Number(value);
    if (Number.isFinite(n)) out[f.field] = n;
  }
  return out;
}

function requestValue(f: FieldSpec, ctx: ChargeContext): string | number | undefined {
  if (f.value === "{merchant}") return ctx.merchant;
  if (f.value === "{order_no}") return ctx.orderNo;
  if (f.value === "{amount}") return formatAmount(ctx.amountMinor, f.unit ?? "yuan");
  if (f.value === "{subject}") return ctx.subject;
  if (f.value === "{body}") return ctx.subject;
  if (f.value === "{notify_url}") return ctx.notifyUrl;
  if (f.value === "{return_url}") return ctx.returnUrl;
  if (f.value === "{client_ip}") return ctx.clientIp;
  if (f.value === "{channel}") {
    const code = ctx.channelCodes?.[ctx.method] ?? ctx.method;
    return String(code) === "" ? undefined : code;
  }
  if (f.value === "{timestamp}") return formatTimestamp(ctx.now, f.format ?? "s");
  if (f.value === "{nonce}") return randomHex(f.length ?? 32);
  return f.value;
}

function sendRequest(
  endpoint: string,
  path: string,
  method: HttpMethod,
  format: BodyFormat,
  headers: Record<string, string>,
  params: Record<string, unknown>,
): BuiltRequest {
  const url = joinUrl(endpoint, path);
  if (method === "GET") {
    const qs = new URLSearchParams();
    for (const [k, v] of Object.entries(params)) qs.set(k, String(v));
    return { url: `${url}?${qs.toString()}`, method, headers, body: null };
  }
  if (format === "json") {
    headers["Content-Type"] = "application/json";
    return { url, method, headers, body: JSON.stringify(params) };
  }
  headers["Content-Type"] = "application/x-www-form-urlencoded";
  const form = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) form.set(k, String(v));
  return { url, method, headers, body: form.toString() };
}

export function buildCreateRequest(mapping: GatewayMapping, ctx: ChargeContext): BuiltRequest {
  const req = mapping.create.request;
  const params: Record<string, unknown> = {};
  for (const f of req.fields) {
    const value = requestValue(f, ctx);
    if (value !== undefined && String(value) !== "") params[f.field] = value;
  }
  const headers = baseHeaders(req.auth, ctx.secret);
  params[req.sign.field ?? "sign"] = signParams(params, ctx.secret, req.sign);
  const method = req.method ?? "POST";
  const format = req.format ?? "form";
  return sendRequest(ctx.endpoint, req.path, method, format, headers, coerceNumeric(params, req.fields, format));
}

// ─────────────────────────────────────────────────────────────
// 响应
// ─────────────────────────────────────────────────────────────

export interface CreateResult {
  ok: boolean;
  payUrl?: string;
  tradeNo?: string;
  expiresAt?: string;
  message?: string;
}

function verifyResponseSign(
  spec: SignResponseSpec | undefined,
  fallback: SignSpec | { mode: "none" } | undefined,
  payload: unknown,
  secret: string | undefined,
): boolean {
  if (!spec) return true;
  if (!secret) return false;
  const data = spec.data_path ? readPath(payload, spec.data_path) : payload;
  if (!data || typeof data !== "object") return false;
  const signRaw = readPath(payload, spec.field);
  if (signRaw === undefined || signRaw === null) return false;
  const use = spec.spec ?? (fallback && !("mode" in fallback) ? fallback : undefined);
  if (!use) return false;
  const merged: Record<string, unknown> = { ...(data as Record<string, unknown>) };
  merged[use.field ?? "sign"] = signRaw;
  return verifyParams(merged, secret, use);
}

export function parseCreateResponse(mapping: GatewayMapping, payload: unknown, secret?: string): CreateResult {
  const r = mapping.create.response;
  const ok = matchesWhen(r.ok, payload);
  if (!ok) {
    const messageField = r.fields.find((f) => f.role === "message");
    return { ok: false, message: messageField ? String(readPath(payload, messageField.field) ?? "") || "网关返回失败" : "网关返回失败" };
  }
  if (!verifyResponseSign(r.sign, mapping.create.request.sign, payload, secret)) {
    return { ok: false, message: "网关响应签名校验失败" };
  }
  let payUrl: string | undefined;
  for (const f of r.fields.filter((x) => x.role === "pay_url")) {
    const v = readPath(payload, f.field);
    if (typeof v === "string" && v.trim()) {
      payUrl = v.trim();
      break;
    }
  }
  const trade = r.fields.find((f) => f.role === "trade_no");
  const expiry = r.fields.find((f) => f.role === "expires_at");
  const tradeRaw = trade ? readPath(payload, trade.field) : undefined;
  const expiresRaw = expiry ? readPath(payload, expiry.field) : undefined;
  return {
    ok: true,
    payUrl,
    tradeNo: tradeRaw === undefined || tradeRaw === null ? undefined : String(tradeRaw),
    expiresAt: expiresRaw === undefined || expiresRaw === null ? undefined : String(expiresRaw),
  };
}

// ─────────────────────────────────────────────────────────────
// 回调
// ─────────────────────────────────────────────────────────────

export async function readNotifyParams(mapping: GatewayMapping, request: Request): Promise<Record<string, unknown>> {
  const n = mapping.notify.request;
  const method = n.method ?? "POST";
  if (method === "GET") return Object.fromEntries(new URL(request.url).searchParams);
  if ((n.format ?? "json") === "json") {
    try {
      const parsed = JSON.parse(await request.text()) as unknown;
      return parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : {};
    } catch {
      return {};
    }
  }
  const form = await request.formData().catch(() => null);
  if (!form) return {};
  const out: Record<string, unknown> = {};
  for (const [k, v] of form.entries()) out[k] = typeof v === "string" ? v : v.name;
  return out;
}

export interface NotifyResult {
  signOk: boolean;
  paid: boolean;
  orderNo: string | null;
  tradeNo: string | null;
  amountMinor: number | null;
  raw: string;
}

export function parseNotify(mapping: GatewayMapping, params: Record<string, unknown>, secret: string): NotifyResult {
  const n = mapping.notify.request;
  const field = (role: FieldRole): FieldSpec | undefined => n.fields.find((f) => f.role === role);
  const order = field("order_no");
  const trade = field("trade_no");
  const amount = field("amount");
  const orderRaw = order ? params[order.field] : undefined;
  const tradeRaw = trade ? params[trade.field] : undefined;
  return {
    signOk: verifyParams(params, secret, n.sign),
    paid: matchesWhen(n.paid_when, params),
    orderNo: orderRaw === undefined || orderRaw === null ? null : String(orderRaw),
    tradeNo: tradeRaw === undefined || tradeRaw === null ? null : String(tradeRaw),
    amountMinor: amount ? parseAmount(params[amount.field], amount.unit ?? "yuan") : null,
    raw: JSON.stringify(params),
  };
}

// ─────────────────────────────────────────────────────────────
// 查单
// ─────────────────────────────────────────────────────────────

export interface QueryContext {
  merchant: string;
  secret: string;
  orderNo: string;
  amountMinor: number;
  subject: string;
  method: string;
  endpoint: string;
  channelCodes?: Record<string, string | number>;
  now: Date;
}

export function hasQuery(mapping: GatewayMapping): boolean {
  return isNonEmptyStr(mapping.query?.request.path);
}

function queryValue(f: FieldSpec, ctx: QueryContext): string | number | undefined {
  if (f.value === "{merchant}") return ctx.merchant;
  if (f.value === "{secret}") return ctx.secret;
  if (f.value === "{order_no}") return ctx.orderNo;
  if (f.value === "{amount}") return formatAmount(ctx.amountMinor, f.unit ?? "yuan");
  if (f.value === "{subject}") return ctx.subject;
  if (f.value === "{channel}") {
    const code = ctx.channelCodes?.[ctx.method] ?? ctx.method;
    return String(code) === "" ? undefined : code;
  }
  if (f.value === "{timestamp}") return formatTimestamp(ctx.now, f.format ?? "s");
  if (f.value === "{nonce}") return randomHex(f.length ?? 32);
  return f.value;
}

export function buildQueryRequest(mapping: GatewayMapping, ctx: QueryContext): BuiltRequest {
  const q = mapping.query?.request;
  if (!q) throw new Error("该网关没有配置查单接口");
  const params: Record<string, unknown> = {};
  for (const f of q.fields) {
    const value = queryValue(f, ctx);
    if (value !== undefined && String(value) !== "") params[f.field] = value;
  }
  const headers = baseHeaders(q.auth, ctx.secret);
  const sign = q.sign as unknown;
  if (sign && typeof sign === "object" && !("mode" in sign)) {
    const spec = sign as SignSpec;
    params[spec.field ?? "sign"] = signParams(params, ctx.secret, spec);
  }
  const method = q.method ?? "POST";
  const format = q.format ?? "form";
  return sendRequest(ctx.endpoint, q.path, method, format, headers, coerceNumeric(params, q.fields, format));
}

export interface QueryResult {
  ok: boolean;
  paid: boolean;
  terminal: boolean;
  amountMinor: number | null;
  tradeNo: string | null;
  message?: string;
}

export function parseQueryResponse(mapping: GatewayMapping, payload: unknown, secret?: string): QueryResult {
  const r = mapping.query?.response;
  const qreq = mapping.query?.request;
  if (!r || !qreq) {
    return { ok: false, paid: false, terminal: false, amountMinor: null, tradeNo: null, message: "该网关不支持查单" };
  }
  const ok = r.ok ? matchesWhen(r.ok, payload) : true;
  const fallback = qreq.sign as { mode: "none" } | SignSpec;
  if (!verifyResponseSign(r.sign, "mode" in fallback ? undefined : fallback, payload, secret)) {
    return { ok: false, paid: false, terminal: false, amountMinor: null, tradeNo: null, message: "网关响应签名校验失败" };
  }
  const field = (role: FieldRole): FieldSpec | undefined => r.fields.find((f) => f.role === role);
  const amount = field("amount");
  const trade = field("trade_no");
  const message = field("message");
  const tradeRaw = trade ? readPath(payload, trade.field) : undefined;
  const messageRaw = message ? readPath(payload, message.field) : undefined;
  return {
    ok,
    paid: matchesWhen(r.paid_when, payload),
    terminal: matchesWhen(r.terminal_when, payload),
    amountMinor: amount ? parseAmount(readPath(payload, amount.field), amount.unit ?? "yuan") : null,
    tradeNo: tradeRaw === undefined || tradeRaw === null ? null : String(tradeRaw),
    message: messageRaw === undefined || messageRaw === null ? undefined : String(messageRaw),
  };
}
