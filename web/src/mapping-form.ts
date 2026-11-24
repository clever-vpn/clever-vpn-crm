/**
 * 支付网关映射的**表单状态**（`generic_json_v1`）。
 *
 * 为什么需要这一层：后台原来只有一个 JSON 文本框，运营要手写 30 多个键、嵌套对象和
 * `{path, equals|in}` 判定。这里把「存储格式」和「编辑状态」分开：
 *
 *   mapping JSON（服务端权威） ⇄ MappingFormState（表单） ⇄ 控件
 *
 * - 固定结构（下单、响应、回调、查单、签名）用带标签的字段编辑；
 * - 真正动态的 map（`fields` / `constants` / `query.fields`）用 KV 行；
 * - 表单不认识的键放在 `unknown` 里原样带回，服务端 `validateMapping` 会报错（不静默丢）。
 *
 * 类型刻意与 `src/payments/mapping.ts` 的 `GatewayMapping` 对齐，但**不 import 服务端代码**
 * （web 是独立构建）。`test/web/mapping-form.test.ts` 会做一次结构兼容检查。
 */

export type HttpMethod = "GET" | "POST";
export type BodyFormat = "form" | "json";
export type AmountUnit = "yuan" | "cent";
export type AmountUnitChoice = "follow" | AmountUnit;
export type TimestampFormat = "s" | "ms" | "ymdhms";
export type SignAlgo = "md5" | "sha256";

/** 与 `WhenSpec` 对齐；表单里统一用字符串，`matchesWhen` 本来就会转字符串比较 */
export interface WhenSpecLike {
  path: string;
  equals?: string | number;
  in?: (string | number)[];
}

export interface FieldMapLike {
  merchant: string;
  order_no: string;
  amount: string;
  subject?: string;
  body?: string;
  notify_url?: string;
  return_url?: string;
  client_ip?: string;
  channel?: string;
  timestamp?: string;
  nonce?: string;
}

export interface SignSpecLike {
  field?: string;
  algo?: SignAlgo;
  key_append?: string;
  exclude?: string[];
  upper?: boolean;
  encode?: boolean;
}

export type QuerySignLike = SignSpecLike | { mode: "none" };

export interface FieldSpecLike {
  field: string;
  role?: FieldRoleLike;
  value?: string;
  unit?: AmountUnit;
  format?: TimestampFormat;
  timezone?: string;
  length?: number;
  numeric?: boolean;
}

export type FieldRoleLike =
  | "merchant" | "order_no" | "amount" | "subject" | "body"
  | "notify_url" | "return_url" | "client_ip" | "channel"
  | "timestamp" | "nonce" | "pay_url" | "trade_no" | "expires_at" | "message";

export interface SignResponseSpecLike {
  field: string;
  data_path?: string;
  spec?: SignSpecLike;
}

export interface GatewayMappingLike {
  create: {
    request: {
      method?: HttpMethod;
      path: string;
      format?: BodyFormat;
      fields: FieldSpecLike[];
      auth?: { header: string; value: string };
      sign: SignSpecLike;
    };
    response: {
      ok: WhenSpecLike;
      fields: FieldSpecLike[];
      sign?: SignResponseSpecLike;
    };
  };
  notify: {
    request: {
      method?: HttpMethod;
      format?: BodyFormat;
      fields: FieldSpecLike[];
      paid_when: WhenSpecLike;
      sign: SignSpecLike;
    };
    response: { reply: string };
  };
  query?: {
    request: {
      method?: HttpMethod;
      path: string;
      format?: BodyFormat;
      fields: FieldSpecLike[];
      auth?: { header: string; value: string };
      sign: QuerySignLike;
    };
    response: {
      ok?: WhenSpecLike;
      paid_when: WhenSpecLike;
      terminal_when?: WhenSpecLike;
      fields: FieldSpecLike[];
      sign?: SignResponseSpecLike;
    };
  };
}

// ─────────────────────────────────────────────────────────────
// 表单状态
// ─────────────────────────────────────────────────────────────

export interface WhenInput {
  path: string;
  /** 一个值 = equals；多个值 = in。空数组在保存时会被服务端拒绝。 */
  values: string[];
}

export interface KvRow {
  key: string;
  value: string;
  /** JSON 下单时 `"902"` 与 `902` 不同；表单必须能保留原类型 */
  type: "text" | "number";
}

export type CallbackFieldMode = "follow" | "custom" | "none";

export type SignState = {
  enabled: boolean;
  field: string;
  algo: SignAlgo;
  key_append: string;
  exclude: string[];
  upper: boolean;
  encode: boolean;
};

export type ResponseSignState = {
  enabled: boolean;
  field: string;
  data_path: string;
  spec?: SignSpecLike;
};

export type AuthState = { enabled: boolean; header: string; value: string };

export interface MappingFormState {
  create: { method: HttpMethod; path: string; format: BodyFormat };
  fields: {
    merchant: string;
    order_no: string;
    amount: string;
    subject: string;
    body: string;
    notify_url: string;
    return_url: string;
    client_ip: string;
    channel: string;
    timestamp: string;
    nonce: string;
  };
  amount_unit: AmountUnit;
  notify_amount_unit: AmountUnitChoice;
  query_amount_unit: AmountUnitChoice;
  timestamp_format: TimestampFormat;
  constants: KvRow[];
  /** JSON 请求里按数字发送的厂商字段名 */
  numeric_fields: string[];
  sign: SignState;
  notify_sign: SignState;
  query_sign: SignState;
  auth: AuthState;
  query_auth: AuthState;
  query_timestamp_format: TimestampFormat;
  query_constants: KvRow[];
  query_numeric_fields: string[];
  response: {
    ok: WhenInput;
    pay_url: string;
    message: string;
    trade_no: string;
    expires_at: string;
    sign: ResponseSignState;
  };
  query_response_sign: ResponseSignState;
  notify: {
    method: HttpMethod;
    format: BodyFormat;
    order_no_mode: "follow" | "custom";
    order_no: string;
    amount_mode: CallbackFieldMode;
    amount: string;
    trade_no: string;
    paid_when: WhenInput;
    /** **不要 trim**：必须与厂商要求逐字一致 */
    reply: string;
  };
  query: {
    enabled: boolean;
    method: HttpMethod;
    format: BodyFormat;
    path: string;
    fields: KvRow[];
    ok: WhenInput;
    paid_when: WhenInput;
    terminal_when: WhenInput;
    amount: string;
    trade_no: string;
    message: string;
  };
  /** 表单不认识、但原配置里有的键：原样带回，服务端会报错让人处理 */
  unknown: Record<string, unknown>;
}

export interface FromMappingResult {
  state: MappingFormState;
  issues: string[];
}

// ─────────────────────────────────────────────────────────────
// 空状态 / 读值
// ─────────────────────────────────────────────────────────────

const FIELD_KEYS = [
  "merchant",
  "order_no",
  "amount",
  "subject",
  "body",
  "notify_url",
  "return_url",
  "client_ip",
  "channel",
  "timestamp",
  "nonce",
] as const;

function emptyWhen(): WhenInput {
  return { path: "", values: [] };
}

export function emptyState(methods: string[]): MappingFormState {
  return {
    create: { method: "POST", path: "", format: "form" },
    fields: {
      merchant: "",
      order_no: "",
      amount: "",
      subject: "",
      body: "",
      notify_url: "",
      return_url: "",
      client_ip: "",
      channel: "",
      timestamp: "",
      nonce: "",
    },
    amount_unit: "yuan",
    notify_amount_unit: "follow",
    query_amount_unit: "follow",
    timestamp_format: "s",
    constants: [],
    numeric_fields: [],
    sign: {
      enabled: true,
      field: "sign",
      algo: "md5",
      key_append: "",
      exclude: ["sign"],
      upper: false,
      encode: false,
    },
    notify_sign: {
      enabled: true,
      field: "sign",
      algo: "md5",
      key_append: "",
      exclude: ["sign"],
      upper: false,
      encode: false,
    },
    query_sign: {
      enabled: true,
      field: "sign",
      algo: "md5",
      key_append: "",
      exclude: ["sign"],
      upper: false,
      encode: false,
    },
    auth: { enabled: false, header: "Authorization", value: "Token {key}" },
    query_auth: { enabled: false, header: "Authorization", value: "Token {key}" },
    query_timestamp_format: "s",
    query_constants: [],
    query_numeric_fields: [],
    response: {
      ok: emptyWhen(),
      pay_url: "",
      message: "",
      trade_no: "",
      expires_at: "",
      sign: { enabled: false, field: "sign", data_path: "data" },
    },
    query_response_sign: { enabled: false, field: "sign", data_path: "data" },
    notify: {
      method: "POST",
      format: "json",
      order_no_mode: "follow",
      order_no: "",
      amount_mode: "follow",
      amount: "",
      trade_no: "",
      paid_when: emptyWhen(),
      reply: "",
    },
    query: {
      enabled: true,
      method: "POST",
      format: "form",
      path: "",
      fields: [],
      ok: emptyWhen(),
      paid_when: emptyWhen(),
      terminal_when: emptyWhen(),
      amount: "",
      trade_no: "",
      message: "",
    },
    unknown: {},
  };
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === "object" && !Array.isArray(v);
}

function str(v: unknown, fallback = ""): string {
  return typeof v === "string" ? v : fallback;
}

function bool(v: unknown): boolean {
  return v === true;
}

function oneOf<T extends string>(v: unknown, allowed: readonly T[], fallback: T): T {
  return typeof v === "string" && (allowed as readonly string[]).includes(v) ? (v as T) : fallback;
}

function readWhen(v: unknown): WhenInput {
  if (!isPlainObject(v)) return emptyWhen();
  const path = str(v.path);
  if (Array.isArray(v.in) && v.in.length > 0) {
    return { path, values: v.in.map((x) => String(x)) };
  }
  if (v.equals !== undefined && v.equals !== null) {
    return { path, values: [String(v.equals)] };
  }
  return { path, values: [] };
}

function readKv(v: unknown): KvRow[] {
  if (!isPlainObject(v)) return [];
  return Object.entries(v).map(([key, value]) => ({
    key,
    value: String(value),
    type: typeof value === "number" ? "number" : "text",
  }));
}

function readMethods(methods: string[], v: unknown): KvRow[] {
  const map: Record<string, unknown> = isPlainObject(v) ? v : {};
  const rows: KvRow[] = methods.map((key) => ({
    key,
    value: map[key] === undefined || map[key] === null ? "" : String(map[key]),
    type: typeof map[key] === "number" ? "number" : "text",
  }));
  for (const [key, value] of Object.entries(map)) {
    if (methods.includes(key)) continue;
    rows.push({ key, value: String(value), type: typeof value === "number" ? "number" : "text" });
  }
  return rows;
}

function readStringArray(v: unknown): string[] {
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
}

function readGroups(v: unknown): string[][] {
  return Array.isArray(v)
    ? v
        .filter((g): g is unknown[] => Array.isArray(g))
        .map((g) => g.filter((x): x is string => typeof x === "string"))
        .filter((g) => g.length > 0)
    : [];
}

// ─────────────────────────────────────────────────────────────
// 未知键提取
// ─────────────────────────────────────────────────────────────

const TOP_KEYS = new Set(["create", "notify", "query"]);
const API_KEYS = new Set(["request", "response"]);

function pickUnknown(v: unknown, allowed: Set<string>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  if (!isPlainObject(v)) return out;
  for (const [k, value] of Object.entries(v)) if (!allowed.has(k)) out[k] = value;
  return out;
}

function extractUnknown(raw: unknown): Record<string, unknown> {
  return isPlainObject(raw) ? pickUnknown(raw, TOP_KEYS) : {};
}

function unknownPaths(unknown: Record<string, unknown>, prefix = ""): string[] {
  const out: string[] = [];
  for (const [k, v] of Object.entries(unknown)) {
    const path = prefix ? `${prefix}.${k}` : k;
    if (isPlainObject(v)) out.push(...unknownPaths(v, path));
    else out.push(path);
  }
  return out;
}

function roleFields(fields: FieldSpecLike[] | undefined, role: FieldRoleLike): FieldSpecLike | undefined {
  return (fields ?? []).find((f) => f.role === role);
}

function signFrom(raw: SignSpecLike | undefined): MappingFormState["sign"] {
  return {
    enabled: !!raw,
    field: raw ? str(raw.field, "sign") || "sign" : "sign",
    algo: oneOf(raw?.algo, ["md5", "sha256"], "md5"),
    key_append: raw ? str(raw.key_append) : "",
    exclude: raw ? readStringArray(raw.exclude) : ["sign"],
    upper: bool(raw?.upper),
    encode: bool(raw?.encode),
  };
}

function responseSignFrom(raw: SignResponseSpecLike | undefined): MappingFormState["response"]["sign"] {
  return {
    enabled: !!raw,
    field: raw ? str(raw.field, "sign") || "sign" : "sign",
    data_path: raw ? str(raw.data_path, "data") : "data",
    ...(raw?.spec ? { spec: raw.spec as SignSpecLike } : {}),
  };
}

function authFrom(raw: { header: string; value: string } | undefined): MappingFormState["auth"] {
  return {
    enabled: !!raw,
    header: raw ? str(raw.header, "Authorization") || "Authorization" : "Authorization",
    value: raw ? str(raw.value, "Token {key}") || "Token {key}" : "Token {key}",
  };
}

// ─────────────────────────────────────────────────────────────
// fromMapping
// ─────────────────────────────────────────────────────────────

export function fromMapping(raw: unknown, methods: string[]): FromMappingResult {
  const state = emptyState(methods);
  const issues: string[] = [];
  if (raw === null || raw === undefined) return { state, issues };
  if (!isPlainObject(raw)) return { state, issues: ["现有接口配置不是对象，已按空白表单打开"] };
  const m = raw as unknown as GatewayMappingLike;

  const creq = m.create?.request;
  const cresp = m.create?.response;
  state.create = {
    method: oneOf(creq?.method, ["GET", "POST"], "POST"),
    path: str(creq?.path),
    format: oneOf(creq?.format, ["form", "json"], "form"),
  };
  const cfields = creq?.fields ?? [];
  for (const role of ["merchant", "order_no", "subject", "body", "notify_url", "return_url", "client_ip", "channel", "timestamp", "nonce"] as const) {
    state.fields[role] = roleFields(cfields, role)?.field ?? "";
  }
  const amount = roleFields(cfields, "amount");
  state.fields.amount = amount?.field ?? "";
  state.amount_unit = amount?.unit ?? "yuan";
  state.timestamp_format = roleFields(cfields, "timestamp")?.format ?? "s";
  state.constants = cfields
    .filter((f) => !f.role && f.value !== undefined)
    .map((f) => ({ key: f.field, value: f.value ?? "", type: "text" as const }));
  state.numeric_fields = cfields.filter((f) => f.numeric).map((f) => f.field);
  state.sign = signFrom(creq?.sign);
  state.auth = authFrom(creq?.auth);

  const responseFields = cresp?.fields ?? [];
  const payUrl = responseFields.find((f) => f.role === "pay_url")?.field ?? "";
  state.response = {
    ok: readWhen(cresp?.ok),
    pay_url: payUrl,
    message: roleFields(responseFields, "message")?.field ?? "",
    trade_no: roleFields(responseFields, "trade_no")?.field ?? "",
    expires_at: roleFields(responseFields, "expires_at")?.field ?? "",
    sign: responseSignFrom(cresp?.sign),
  };

  const nreq = m.notify?.request;
  const nresp = m.notify?.response;
  const notifyOrder = roleFields(nreq?.fields, "order_no")?.field ?? "";
  const notifyAmount = roleFields(nreq?.fields, "amount");
  state.notify = {
    method: oneOf(nreq?.method, ["GET", "POST"], "POST"),
    format: oneOf(nreq?.format, ["form", "json"], "json"),
    order_no_mode: !notifyOrder ? "follow" : notifyOrder === state.fields.order_no ? "follow" : "custom",
    order_no: notifyOrder,
    amount_mode: !notifyAmount ? "none" : notifyAmount.field === state.fields.amount ? "follow" : "custom",
    amount: notifyAmount?.field ?? "",
    trade_no: roleFields(nreq?.fields, "trade_no")?.field ?? "",
    paid_when: readWhen(nreq?.paid_when),
    reply: nresp?.reply ?? "",
  };
  state.notify_sign = signFrom(nreq?.sign);
  state.notify_amount_unit = notifyAmount?.unit ?? "follow";

  const qreq = m.query?.request;
  const qresp = m.query?.response;
  state.query = {
    enabled: !!m.query,
    method: oneOf(qreq?.method, ["GET", "POST"], "POST"),
    format: oneOf(qreq?.format, ["form", "json"], "form"),
    path: str(qreq?.path),
    fields: (qreq?.fields ?? [])
      .filter((f) => !!f.role || (f.value ?? "").startsWith("{"))
      .map((f) => ({
        key: f.field,
        value: f.value ?? "",
        type: f.numeric ? ("number" as const) : ("text" as const),
      })),
    ok: readWhen(qresp?.ok),
    paid_when: readWhen(qresp?.paid_when),
    terminal_when: readWhen(qresp?.terminal_when),
    amount: roleFields(qresp?.fields, "amount")?.field ?? "",
    trade_no: roleFields(qresp?.fields, "trade_no")?.field ?? "",
    message: roleFields(qresp?.fields, "message")?.field ?? "",
  };
  state.query_amount_unit = roleFields(qresp?.fields, "amount")?.unit ?? "follow";
  const qsign = qreq?.sign;
  state.query_sign =
    qsign && typeof qsign === "object" && "mode" in qsign
      ? { ...signFrom(undefined), enabled: false }
      : signFrom(qsign as SignSpecLike | undefined);
  state.query_response_sign = responseSignFrom(qresp?.sign);
  state.query_timestamp_format = roleFields(qreq?.fields, "timestamp")?.format ?? "s";
  state.query_auth = authFrom(qreq?.auth);
  state.query_constants = (qreq?.fields ?? [])
    .filter((f) => !f.role && f.value !== undefined && !(f.value ?? "").startsWith("{"))
    .map((f) => ({ key: f.field, value: f.value ?? "", type: "text" as const }));
  state.query_numeric_fields = (qreq?.fields ?? []).filter((f) => f.numeric).map((f) => f.field);

  state.unknown = extractUnknown(raw);
  const unknown = unknownPaths(state.unknown);
  if (unknown.length) {
    issues.push(`存在未识别的键：${unknown.join("、")}（保存会被拒绝，请删除或改用支持的字段）`);
  }
  return { state, issues };
}

// ─────────────────────────────────────────────────────────────
// toMapping
// ─────────────────────────────────────────────────────────────

function kvObject(rows: KvRow[], keepEmpty: boolean): Record<string, string | number> {
  const out: Record<string, string | number> = {};
  for (const row of rows) {
    const key = row.key.trim();
    if (!key) continue;
    if (!keepEmpty && row.value.trim() === "") continue;
    if (row.type === "number") {
      const n = Number(row.value);
      out[key] = row.value.trim() !== "" && Number.isFinite(n) ? n : row.value;
    } else {
      out[key] = row.value;
    }
  }
  return out;
}

function whenObject(when: WhenInput, required: boolean): WhenSpecLike | undefined {
  const path = when.path.trim();
  const values = when.values.map((v) => v.trim()).filter(Boolean);
  if (!path && values.length === 0) return required ? { path: "", in: [] } : undefined;
  if (values.length === 0) return { path, in: [] };
  if (values.length === 1) return { path, equals: values[0] };
  return { path, in: values };
}

function signObject(state: MappingFormState["sign"]): SignSpecLike | undefined {
  if (!state.enabled) return undefined;
  const sign: SignSpecLike = {
    algo: state.algo,
    key_append: state.key_append,
    exclude: state.exclude.filter((x) => x.trim() !== ""),
  };
  const field = state.field.trim();
  if (field && field !== "sign") sign.field = field;
  if (state.upper) sign.upper = true;
  if (state.encode) sign.encode = true;
  return sign;
}

function responseSignObject(state: MappingFormState["response"]["sign"]): SignResponseSpecLike | undefined {
  if (!state.enabled) return undefined;
  return {
    field: state.field.trim() || "sign",
    ...(state.data_path.trim() ? { data_path: state.data_path.trim() } : {}),
    ...(state.spec ? { spec: state.spec } : {}),
  };
}

function mergeUnknown(base: Record<string, unknown>, extra: Record<string, unknown>): void {
  for (const [k, v] of Object.entries(extra)) {
    if (isPlainObject(v) && isPlainObject(base[k])) mergeUnknown(base[k] as Record<string, unknown>, v);
    else if (base[k] === undefined) base[k] = v;
  }
}

function requestField(
  field: string,
  role: FieldRoleLike,
  value: string,
  extra: Partial<FieldSpecLike> = {},
): FieldSpecLike | null {
  if (!field.trim()) return null;
  return { field: field.trim(), role, value, ...extra };
}

export function toMapping(state: MappingFormState): GatewayMappingLike {
  const createFields: FieldSpecLike[] = [];
  const add = (f: FieldSpecLike | null): void => { if (f) createFields.push(f); };
  add(requestField(state.fields.merchant, "merchant", "{merchant}", state.numeric_fields.includes(state.fields.merchant.trim()) ? { numeric: true } : {}));
  add(requestField(state.fields.order_no, "order_no", "{order_no}"));
  add(requestField(state.fields.amount, "amount", "{amount}", { unit: state.amount_unit, ...(state.numeric_fields.includes(state.fields.amount.trim()) ? { numeric: true } : {}) }));
  add(requestField(state.fields.subject, "subject", "{subject}"));
  add(requestField(state.fields.body, "body", "{body}"));
  add(requestField(state.fields.notify_url, "notify_url", "{notify_url}"));
  add(requestField(state.fields.return_url, "return_url", "{return_url}"));
  add(requestField(state.fields.client_ip, "client_ip", "{client_ip}"));
  add(requestField(state.fields.channel, "channel", "{channel}"));
  add(requestField(state.fields.timestamp, "timestamp", "{timestamp}", {
    format: state.timestamp_format,
    ...(state.timestamp_format === "ymdhms" ? { timezone: "Asia/Shanghai" } : {}),
  }));
  add(requestField(state.fields.nonce, "nonce", "{nonce}", { length: 32 }));
  for (const row of state.constants) {
    if (!row.key.trim()) continue;
    createFields.push({ field: row.key.trim(), value: row.value, ...(row.type === "number" ? { numeric: true } : {}) });
  }

  const sign = signObject(state.sign) ?? { algo: "md5", exclude: ["sign"] };
  const auth = state.auth.enabled ? { header: state.auth.header, value: state.auth.value } : undefined;
  const responseFields: FieldSpecLike[] = [];
  if (state.response.pay_url.trim()) {
    responseFields.push({ field: state.response.pay_url.trim(), role: "pay_url" });
  }
  if (state.response.trade_no.trim()) responseFields.push({ field: state.response.trade_no.trim(), role: "trade_no" });
  if (state.response.expires_at.trim()) {
    responseFields.push({ field: state.response.expires_at.trim(), role: "expires_at", format: "s" });
  }
  if (state.response.message.trim()) responseFields.push({ field: state.response.message.trim(), role: "message" });

  const notifyOrder = state.notify.order_no_mode === "follow" ? state.fields.order_no.trim() : state.notify.order_no.trim();
  const notifyAmount = state.notify.amount_mode === "follow"
    ? state.fields.amount.trim()
    : state.notify.amount_mode === "custom"
      ? state.notify.amount.trim()
      : "";
  const notifyFields: FieldSpecLike[] = [];
  if (notifyOrder) notifyFields.push({ field: notifyOrder, role: "order_no" });
  if (state.notify.trade_no.trim()) notifyFields.push({ field: state.notify.trade_no.trim(), role: "trade_no" });
  if (notifyAmount) {
    notifyFields.push({
      field: notifyAmount,
      role: "amount",
      unit: state.notify_amount_unit === "follow" ? state.amount_unit : state.notify_amount_unit,
    });
  }

  const queryFields: FieldSpecLike[] = [];
  for (const row of state.query.fields) {
    const field = row.key.trim();
    if (!field) continue;
    const value = row.value;
    const extra: Partial<FieldSpecLike> = row.type === "number" ? { numeric: true } : {};
    if (value === "{amount}") {
      extra.role = "amount";
      extra.unit = state.query_amount_unit === "follow" ? state.amount_unit : state.query_amount_unit;
    }
    if (value === "{timestamp}") {
      extra.role = "timestamp";
      extra.format = state.query_timestamp_format;
      if (state.query_timestamp_format === "ymdhms") extra.timezone = "Asia/Shanghai";
    }
    if (row.type === "number" || state.query_numeric_fields.includes(field)) extra.numeric = true;
    queryFields.push({ field, value, ...extra });
  }
  for (const row of state.query_constants) {
    if (!row.key.trim()) continue;
    queryFields.push({ field: row.key.trim(), value: row.value, ...(row.type === "number" ? { numeric: true } : {}) });
  }
  const queryResponseFields: FieldSpecLike[] = [];
  if (state.query.trade_no.trim()) queryResponseFields.push({ field: state.query.trade_no.trim(), role: "trade_no" });
  if (state.query.amount.trim()) {
    queryResponseFields.push({
      field: state.query.amount.trim(),
      role: "amount",
      unit: state.query_amount_unit === "follow" ? state.amount_unit : state.query_amount_unit,
    });
  }
  if (state.query.message.trim()) queryResponseFields.push({ field: state.query.message.trim(), role: "message" });

  const querySign: QuerySignLike = state.query_sign.enabled
    ? signObject(state.query_sign) ?? sign
    : { mode: "none" };
  const queryAuth = state.query_auth.enabled ? { header: state.query_auth.header, value: state.query_auth.value } : undefined;
  const out: Record<string, unknown> = {
    create: {
      request: {
        method: state.create.method,
        path: state.create.path.trim(),
        format: state.create.format,
        fields: createFields,
        ...(auth ? { auth } : {}),
        sign,
      },
      response: {
        ok: whenObject(state.response.ok, true),
        fields: responseFields,
        ...(responseSignObject(state.response.sign) ? { sign: responseSignObject(state.response.sign) } : {}),
      },
    },
    notify: {
      request: {
        method: state.notify.method,
        ...(state.notify.method === "POST" ? { format: state.notify.format } : {}),
        fields: notifyFields,
        paid_when: whenObject(state.notify.paid_when, true),
        sign: signObject(state.notify_sign) ?? sign,
      },
      response: { reply: state.notify.reply },
    },
    query: {
      request: {
        method: state.query.method,
        path: state.query.path.trim(),
        ...(state.query.method === "POST" ? { format: state.query.format } : {}),
        fields: queryFields,
        ...(queryAuth ? { auth: queryAuth } : {}),
        sign: querySign,
      },
      response: {
        ...(whenObject(state.query.ok, false) ? { ok: whenObject(state.query.ok, false) } : {}),
        paid_when: whenObject(state.query.paid_when, true),
        ...(whenObject(state.query.terminal_when, false) ? { terminal_when: whenObject(state.query.terminal_when, false) } : {}),
        fields: queryResponseFields,
        ...(responseSignObject(state.query_response_sign)
          ? { sign: responseSignObject(state.query_response_sign) }
          : {}),
      },
    },
  };
  mergeUnknown(out, state.unknown);
  return out as unknown as GatewayMappingLike;
}

// ─────────────────────────────────────────────────────────────
// 必填检查 / 人话描述
// ─────────────────────────────────────────────────────────────

export interface CheckItem {
  key: string;
  label: string;
  ok: boolean;
}

function nonEmpty(...values: string[]): boolean {
  return values.some((v) => v.trim() !== "");
}

export function requiredChecks(state: MappingFormState): CheckItem[] {
  const notifyOrderNo =
    state.notify.order_no_mode === "follow" ? state.fields.order_no : state.notify.order_no;
  return [
    { key: "create.path", label: "下单地址", ok: nonEmpty(state.create.path) },
    { key: "fields.merchant", label: "商户号字段", ok: nonEmpty(state.fields.merchant) },
    { key: "fields.order_no", label: "订单号字段", ok: nonEmpty(state.fields.order_no) },
    { key: "fields.amount", label: "金额字段", ok: nonEmpty(state.fields.amount) },
    {
      key: "response.ok",
      label: "下单成功判定",
      ok: nonEmpty(state.response.ok.path) && state.response.ok.values.length > 0,
    },
    {
      key: "response.pay_url",
      label: "收银台字段",
      ok: nonEmpty(state.response.pay_url),
    },
    { key: "notify.order_no", label: "回调订单号字段", ok: nonEmpty(notifyOrderNo) },
    {
      key: "notify.paid_when",
      label: "回调已付判定",
      ok: nonEmpty(state.notify.paid_when.path) && state.notify.paid_when.values.length > 0,
    },
    { key: "notify.reply", label: "应答原文", ok: state.notify.reply !== "" },
    { key: "sign", label: "下单签名", ok: state.sign.enabled },
    { key: "notify.sign", label: "回调验签", ok: state.notify_sign.enabled },
    { key: "query.path", label: "查单地址", ok: nonEmpty(state.query.path) },
    { key: "query.sign", label: "查单签名", ok: state.query_sign.enabled },
    {
      key: "query.order_no",
      label: "查单订单号参数",
      ok: state.query.fields.some((row) => row.value.includes("{order_no}")),
    },
    {
      key: "query.paid_when",
      label: "查单已付判定",
      ok: nonEmpty(state.query.paid_when.path) && state.query.paid_when.values.length > 0,
    },
  ];
}

export function localIssues(state: MappingFormState): string[] {
  return requiredChecks(state)
    .filter((c) => !c.ok)
    .map((c) => `${c.label}未填写`);
}

export interface MappingDescription {
  summary: string;
  rows: { label: string; value: string }[];
  warnings: string[];
}

const FORMAT_LABEL: Record<BodyFormat, string> = { form: "表单", json: "JSON" };
const UNIT_LABEL: Record<AmountUnit, string> = { yuan: "元", cent: "分" };

function whenText(when: WhenInput): string {
  if (!when.path) return "未配置";
  const values = when.values.filter(Boolean);
  if (values.length === 0) return `${when.path}（值未填）`;
  return values.length === 1 ? `${when.path} = ${values[0]}` : `${when.path} ∈ {${values.join(" / ")}}`;
}

function notifyField(state: MappingFormState): { orderNo: string; amount: string } {
  return {
    orderNo:
      state.notify.order_no_mode === "follow" ? state.fields.order_no : state.notify.order_no.trim(),
    amount:
      state.notify.amount_mode === "follow"
        ? state.fields.amount
        : state.notify.amount_mode === "custom"
          ? state.notify.amount.trim()
          : "",
  };
}

export function describeMapping(state: MappingFormState): MappingDescription {
  const notify = notifyField(state);
  const payUrl = state.response.pay_url.trim();
  const rows: { label: string; value: string }[] = [
    {
      label: "下单",
      value: `${state.create.method} ${state.create.path.trim() || "（未填）"} · ${
        FORMAT_LABEL[state.create.format]
      }`,
    },
    { label: "金额", value: `按${UNIT_LABEL[state.amount_unit]}（本 CRM 按分记账）` },
    {
      label: "字段",
      value: `商户号=${state.fields.merchant || "（未填）"} · 订单号=${
        state.fields.order_no || "（未填）"
      } · 金额=${state.fields.amount || "（未填）"}`,
    },
    {
      label: "回调地址字段",
      value: state.fields.notify_url || "（未配置；若服务商后台已填可跳过）",
    },
    {
      label: "签名",
      value: state.sign.enabled
        ? `${state.sign.algo.toUpperCase()} · 字段 ${state.sign.field || "sign"} · 排除 ${
            state.sign.exclude.length ? state.sign.exclude.join("/") : "（无）"
          } · ${state.sign.key_append === "" ? "密钥直接拼接" : `明文末尾拼 ${state.sign.key_append} 再拼密钥`}${
            state.sign.upper ? " · 大写" : ""
          }${state.sign.encode ? " · URL 编码" : ""}`
        : "未启用（不签名）",
    },
    { label: "下单成功", value: whenText(state.response.ok) },
    { label: "收银台", value: payUrl || "（未填）" },
    {
      label: "响应验签",
      value: state.response.sign.enabled
        ? `${state.response.sign.field || "sign"} over ${state.response.sign.data_path || "整个响应"}`
        : "不验签（仅 TLS）",
    },
    {
      label: "回调",
      value: `${state.notify.method} / ${FORMAT_LABEL[state.notify.format]} · 订单号 ${
        notify.orderNo || "（未填）"
      } · 金额 ${notify.amount || "（不核对）"} · 已付 ${whenText(state.notify.paid_when)} · 应答 ${
        state.notify.reply === "" ? "（未填）" : JSON.stringify(state.notify.reply)
      }`,
    },
    {
      label: "查单",
      value: `${state.query.method} ${state.query.path || "（未填）"} · ${
        state.query_sign.enabled ? "独立签名" : "不签名"
      } · 已付 ${whenText(state.query.paid_when)}`,
    },
  ];

  const summary = `${state.create.method} ${state.create.path.trim() || "（未填路径）"}（${
    FORMAT_LABEL[state.create.format]
  }）· 金额按${UNIT_LABEL[state.amount_unit]} · 成功 ${whenText(state.response.ok)} · 回调 ${
    state.notify.method
  }/${FORMAT_LABEL[state.notify.format]}，应答 ${
    state.notify.reply === "" ? "（未填）" : JSON.stringify(state.notify.reply)
  }`;

  const warnings: string[] = [];
  if (!state.fields.notify_url.trim()) {
    warnings.push("未配置回调地址字段：若服务商后台也没配回调地址，将收不到支付通知。");
  }
  if (!notify.amount) {
    warnings.push("未配置回调金额字段：回调不会核对金额（代码会跳过这一步）。");
  }
  if (state.notify.reply === "") {
    warnings.push("未填应答原文：厂商会认为没收到，可能无限重推。");
  }
  if (!state.sign.enabled) {
    warnings.push("未启用签名：回调不会验签（不建议）。");
  }
  if (state.sign.enabled && !state.sign.exclude.length) {
    warnings.push("签名排除字段为空：确认厂商文档没要求排除其它字段。");
  }
  if (!payUrl) warnings.push("未填收银台字段：下单成功也拿不到支付地址。");
  if (!state.create.path.trim()) warnings.push("未填下单地址。");
  if (!state.query.path.trim()) warnings.push("查单地址未填。");
  if (!state.query.fields.some((row) => row.value.includes("{order_no}"))) {
    warnings.push("查单参数里没有 {order_no}：无法按订单号查单。");
  }

  return { summary, rows, warnings };
}
