/**
 * 支付网关映射解释器（`driver = generic_json_v1`）
 *
 * ## 它解决什么
 *
 * 聚合支付的协议几乎都是同一种形状：**下单 + 查单 + 回调**，只是字段名、路径、
 * 金额单位、状态码不同。为每家写一个 driver，等于把同一段逻辑抄二十遍；而写一个
 * 「配置表 + 解释器」，租户贴一份文档就能接上（AI 生成草稿也只产出这份配置）。
 *
 * ## 它**不**解决什么（有意为之）
 *
 * Stripe / PayPal 那种「OAuth 换 token」「必须二次 capture」「回调要调官方 API 验签」
 * 不属于这一类。硬加进来会让这份配置变成半门 DSL，得不偿失 —— 它们是独立薄 driver。
 * 判据：**签名能在本地一次算完 → 映射；否则 → driver**。
 *
 * ## 边界清单（`docs/payments.md` §6.1 有对外的说明）
 *
 * - 只做：取值（点号路径）、比对、拼参数、算签名、发请求。
 * - 不做：表达式、脚本、正则替换、状态机跳转。
 *
 * 因此**没有** `if`：所有「什么时候算成功 / 算失败」都是 `{path, equals|in}` 三件套。
 */

import { SIGN_ALGOS, signParams, verifyParams, type SignAlgo, type SignSpec } from "./sign";

export const DRIVERS = ["epay_v1", "generic_json_v1", "stripe", "paypal", "manual"] as const;
export type Driver = (typeof DRIVERS)[number];

export const AMOUNT_UNITS = ["yuan", "cent"] as const;
export type AmountUnit = (typeof AMOUNT_UNITS)[number];

export type BodyFormat = "form" | "json";
export type HttpMethod = "GET" | "POST";

/** 判定条件：读 `path` 拿值，然后 `equals` 相等 / `in` 命中其一 */
export interface WhenSpec {
  /** 点号路径，如 `data.state`；顶层字段直接写名字 */
  path: string;
  equals?: string | number;
  in?: (string | number)[];
}

/** 请求参数名映射（左边是我们的语义，右边是厂商的字段名） */
export interface FieldMap {
  merchant: string;
  order_no: string;
  amount: string;
  subject?: string;
  body?: string;
  notify_url?: string;
  return_url?: string;
  client_ip?: string;
  /** 支付方式字段名（值来自 `channel_codes`）；**值为空时整个参数不发** */
  channel?: string;
  /** 时间戳字段名（格式由 `timestamp_format` 决定） */
  timestamp?: string;
  /** 随机串字段名（每次请求重新生成 32 位 hex，虎皮椒的 `nonce_str`） */
  nonce?: string;
}

/** 认证头：`{key}` 会被替换成密钥 */
export interface AuthSpec {
  header: string;
  value: string;
}

/** 查单配置。**整个 `query` 都可以不写** —— 有的网关没有查单接口（虎皮椒） */
export interface QuerySpec {
  method?: HttpMethod;
  format?: BodyFormat;
  path: string;
  /** 请求参数，值支持 `{merchant}` `{secret}` `{order_no}` `{amount}` `{channel}` `{timestamp}` `{nonce}` */
  fields: Record<string, string>;
  /** 是否与下单用同一套签名；易支付的查单接口自带 key、不签名 ⇒ `"none"` */
  sign?: "same" | "none";
  ok?: WhenSpec;
  paid_when: WhenSpec;
  /** 明确失败/过期/撤销：命中即收尾，不再重试 */
  terminal_when?: WhenSpec;
  amount?: string;
  trade_no?: string;
  message?: string;
}

export interface GatewayMapping {
  create: { method?: HttpMethod; path: string; format?: BodyFormat };
  fields: FieldMap;
  /** **下单**金额单位。必填 —— 写错就是 100 倍事故 */
  amount_unit: AmountUnit;
  /** 回调金额单位，缺省跟随 `amount_unit`（有网关下单按元、回调按分） */
  notify_amount_unit?: AmountUnit;
  /** 查单金额单位，缺省跟随 `amount_unit` */
  query_amount_unit?: AmountUnit;
  /**
   * 时间戳格式：
   *   - `s` 秒级（10 位）
   *   - `ms` 毫秒级（13 位）
   *   - `ymdhms` `YYYYMMDDHHmmss`，**北京时间（UTC+8）** —— 国内渠道通用写法
   */
  timestamp_format?: "s" | "ms" | "ymdhms";
  constants?: Record<string, string | number>;
  /** 我方支付方式 → 厂商渠道码，如 `{alipay:"alipay", wechat:"wxpay"}` */
  channel_codes?: Record<string, string | number>;
  sign?: SignSpec;
  auth?: AuthSpec;
  response: {
    ok: WhenSpec;
    message?: string;
    /** 单个收银台地址字段；多个候选用 `pay_url_from` */
    pay_url?: string;
    /** 依次取第一个非空（青蛙文档：payurl / qrcode / urlscheme 三选一） */
    pay_url_from?: string[];
    /** 有些网关文档给的是 http，实际必须 https */
    pay_url_force_https?: boolean;
    /** 服务商流水号 */
    trade_no?: string;
    /** 收银台过期时间（原文保存，各家格式不同） */
    expires_at?: string;
  };
  notify: {
    method?: HttpMethod;
    format?: BodyFormat;
    /** 回调里"我方单号"的字段名（**不是**路径，是扁平字段名） */
    order_no: string;
    trade_no?: string;
    amount?: string;
    paid_when: WhenSpec;
    /** 应答原文，必须与厂商要求**逐字**一致，否则会被无限重发 */
    reply: string;
  };
  /** 可选：不写就是"没有查单接口"，cron 兜底会自动跳过这个网关并告警 */
  query?: QuerySpec;
}

// ─────────────────────────────────────────────────────────────
// 读值 / 比对 / 金额
// ─────────────────────────────────────────────────────────────

/** 点号路径取值：`data.state`、`status`；任一段不存在返回 undefined */
export function readPath(payload: unknown, path: string): unknown {
  let cur: unknown = payload;
  for (const seg of path.split(".")) {
    if (cur === null || typeof cur !== "object") return undefined;
    cur = (cur as Record<string, unknown>)[seg];
  }
  return cur;
}

/**
 * 判定条件是否成立。
 *
 * 值统一转字符串比较 —— 各家 `code`/`status` 有时是数字有时是 `"1"`，
 * 写 `equals: 1` 必须能匹配 `"1"`（否则就是一个永远不成立的配置，最难排查）。
 */
export function matchesWhen(spec: WhenSpec | undefined, payload: unknown): boolean {
  if (!spec) return false;
  const actual = readPath(payload, spec.path);
  if (actual === undefined || actual === null) return false;
  const a = String(actual);
  if (spec.in && spec.in.length > 0) return spec.in.some((v) => String(v) === a);
  if (spec.equals !== undefined) return String(spec.equals) === a;
  return false;
}

/** 我方最小单位 → 厂商格式。`yuan` 输出两位小数字符串（`12.34`） */
export function formatAmount(minor: number, unit: AmountUnit): string | number {
  return unit === "cent" ? Math.round(minor) : (minor / 100).toFixed(2);
}

/** 厂商格式 → 我方最小单位；解析不出来返回 `null`（调用方必须当"金额不符"处理） */
export function parseAmount(raw: unknown, unit: AmountUnit): number | null {
  if (raw === undefined || raw === null || raw === "") return null;
  const n = Number(String(raw).trim());
  if (!Number.isFinite(n)) return null;
  return unit === "cent" ? Math.round(n) : Math.round(n * 100);
}

function formatTimestamp(now: Date, format: "s" | "ms" | "ymdhms" = "s"): string {
  if (format === "ms") return String(now.getTime());
  if (format === "s") return String(Math.floor(now.getTime() / 1000));
  // ymdhms：北京时间。国内网关几乎都用这个，而不是时间戳
  const d = new Date(now.getTime() + 8 * 3600_000);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getUTCFullYear()}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}${p(
    d.getUTCHours(),
  )}${p(d.getUTCMinutes())}${p(d.getUTCSeconds())}`;
}

// ─────────────────────────────────────────────────────────────
// 校验（错误文案给租户看，中文、指出具体哪个键）
// ─────────────────────────────────────────────────────────────

export type MappingValidation = { ok: true; mapping: GatewayMapping } | { ok: false; errors: string[] };

const isNonEmptyStr = (v: unknown): v is string => typeof v === "string" && v.trim() !== "";

function whenError(prefix: string, spec: unknown): string | null {
  if (!spec || typeof spec !== "object") return `${prefix} 必填`;
  const s = spec as WhenSpec;
  if (!isNonEmptyStr(s.path)) return `${prefix}.path 必填`;
  if (s.equals === undefined && (!s.in || s.in.length === 0)) {
    return `${prefix} 需要 equals 或 in（不写判定条件等于永远不成立）`;
  }
  return null;
}

/**
 * 校验并补默认值。**不猜**：拿不准就报错，让租户改配置，
 * 而不是"看起来能跑、上线才发现金额单位错 100 倍"。
 */
export function validateMapping(input: unknown): MappingValidation {
  const errors: string[] = [];
  const m = (input && typeof input === "object" ? input : {}) as Partial<GatewayMapping>;

  if (!isNonEmptyStr(m.create?.path)) errors.push("create.path 必填（下单接口路径）");
  if (m.create?.format && !["form", "json"].includes(m.create.format)) {
    errors.push("create.format 只能是 form / json");
  }
  if (m.create?.method && !["GET", "POST"].includes(m.create.method)) {
    errors.push("create.method 只能是 GET / POST");
  }

  const f = (m.fields ?? {}) as Partial<FieldMap>;
  for (const [k, label] of [
    ["merchant", "商户号"],
    ["order_no", "订单号"],
    ["amount", "金额"],
  ] as const) {
    if (!isNonEmptyStr(f[k])) errors.push(`fields.${k} 必填（${label}字段名）`);
  }

  if (!m.amount_unit || !AMOUNT_UNITS.includes(m.amount_unit)) {
    errors.push("amount_unit 必填，且只能是 yuan（元）/ cent（分）");
  }
  for (const [key, label] of [
    ["notify_amount_unit", "notify_amount_unit"],
    ["query_amount_unit", "query_amount_unit"],
  ] as const) {
    const v = m[key];
    if (v !== undefined && !AMOUNT_UNITS.includes(v)) {
      errors.push(`${label} 只能是 yuan / cent（不写则跟随 amount_unit）`);
    }
  }
  if (m.timestamp_format && !["s", "ms", "ymdhms"].includes(m.timestamp_format)) {
    errors.push("timestamp_format 只能是 s / ms / ymdhms");
  }

  const sign = m.sign;
  if (sign) {
    if (sign.algo && !SIGN_ALGOS.includes(sign.algo as SignAlgo)) {
      errors.push(`sign.algo 只能是 ${SIGN_ALGOS.join(" / ")}`);
    }
    if (sign.exclude_variants && sign.exclude_variants.length > 3) {
      errors.push("sign.exclude_variants 最多 3 组");
    }
  }

  if (m.auth && (!isNonEmptyStr(m.auth.header) || !isNonEmptyStr(m.auth.value))) {
    errors.push("auth.header / auth.value 必须同时填写");
  }

  const r = m.response;
  const okErr = whenError("response.ok", r?.ok);
  if (okErr) errors.push(`${okErr}（怎么判断下单成功）`);
  if (!isNonEmptyStr(r?.pay_url) && !(r?.pay_url_from && r.pay_url_from.length > 0)) {
    errors.push("response 需要 pay_url 或 pay_url_from（收银台地址在哪）");
  }

  const n = m.notify;
  if (!isNonEmptyStr(n?.order_no)) errors.push("notify.order_no 必填（回调里哪个字段是我方单号）");
  const paidErr = whenError("notify.paid_when", n?.paid_when);
  if (paidErr) errors.push(`${paidErr}（怎么判断回调说已付款）`);
  if (!isNonEmptyStr(n?.reply)) errors.push("notify.reply 必填（应答原文，写错会被无限重发）");
  if (n?.format && !["form", "json"].includes(n.format)) errors.push("notify.format 只能是 form / json");

  // `query` 整体可选：网关没有查单接口时（官方"开发中"）就不写
  const q = m.query;
  if (q) {
    if (!isNonEmptyStr(q.path)) errors.push("query.path 必填（查单接口路径）");
    const qPaid = whenError("query.paid_when", q.paid_when);
    if (qPaid) errors.push(`${qPaid}（怎么判断查单结果已付款）`);
    const qTerm = q.terminal_when ? whenError("query.terminal_when", q.terminal_when) : null;
    if (qTerm) errors.push(qTerm);
    if (q.sign && !["same", "none"].includes(q.sign)) errors.push('query.sign 只能是 "same" / "none"');
  }

  if (errors.length) return { ok: false, errors };
  return { ok: true, mapping: m as GatewayMapping };
}

// ─────────────────────────────────────────────────────────────
// 下单
// ─────────────────────────────────────────────────────────────

export interface ChargeContext {
  /** 商户号 / app_id */
  merchant: string;
  /** 密钥明文（只在内存中；不落日志、不进响应） */
  secret: string;
  /** 我方订单号（下发后不可改） */
  orderNo: string;
  amountMinor: number;
  currency: string;
  subject: string;
  /** 我方支付方式：alipay / wechat / … */
  method: string;
  notifyUrl: string;
  returnUrl?: string;
  clientIp?: string;
  /** 网关根地址，如 `https://pay.example.com` */
  endpoint: string;
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

function baseHeaders(mapping: GatewayMapping, secret: string): Record<string, string> {
  const headers: Record<string, string> = {};
  if (mapping.auth) {
    headers[mapping.auth.header] = mapping.auth.value.replace(/\{key\}/g, secret);
  }
  return headers;
}

/** 随机串（hex）——用于 `nonce_str` 这类防重放字段 */
function randomHex(bytes = 16): string {
  const buf = new Uint8Array(bytes);
  crypto.getRandomValues(buf);
  return [...buf].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** 组装下单请求（参数 + 签名 + body） */
export function buildCreateRequest(mapping: GatewayMapping, ctx: ChargeContext): BuiltRequest {
  const params: Record<string, string | number> = {};
  for (const [k, v] of Object.entries(mapping.constants ?? {})) params[k] = v;

  const f = mapping.fields;
  params[f.merchant] = ctx.merchant;
  params[f.order_no] = ctx.orderNo;
  params[f.amount] = formatAmount(ctx.amountMinor, mapping.amount_unit);
  if (f.subject) params[f.subject] = ctx.subject;
  if (f.notify_url) params[f.notify_url] = ctx.notifyUrl;
  if (f.return_url && ctx.returnUrl) params[f.return_url] = ctx.returnUrl;
  if (f.client_ip && ctx.clientIp) params[f.client_ip] = ctx.clientIp;
  if (f.channel) {
    // 渠道码为空 = "这个渠道不传该参数"（虎皮椒：支付宝不传 type）。
    // 不能发 `type=` 空串 —— 会被算进签名、或被当成非法渠道。
    const code = mapping.channel_codes?.[ctx.method] ?? ctx.method;
    if (String(code) !== "") params[f.channel] = code;
  }
  if (f.timestamp) params[f.timestamp] = formatTimestamp(ctx.now, mapping.timestamp_format);
  if (f.nonce) params[f.nonce] = randomHex();

  const signed: Record<string, unknown> = { ...params };
  if (mapping.sign) {
    signed[mapping.sign.field ?? "sign"] = signParams(signed, ctx.secret, mapping.sign);
  }

  const headers = baseHeaders(mapping, ctx.secret);
  const method = mapping.create.method ?? "POST";
  const format = mapping.create.format ?? "form";
  const url = joinUrl(ctx.endpoint, mapping.create.path);

  if (method === "GET") {
    const qs = new URLSearchParams();
    for (const [k, v] of Object.entries(signed)) qs.set(k, String(v));
    return { url: `${url}?${qs.toString()}`, method, headers, body: null };
  }
  if (format === "json") {
    headers["Content-Type"] = "application/json";
    return { url, method, headers, body: JSON.stringify(signed) };
  }
  headers["Content-Type"] = "application/x-www-form-urlencoded";
  const form = new URLSearchParams();
  for (const [k, v] of Object.entries(signed)) form.set(k, String(v));
  return { url, method, headers, body: form.toString() };
}

export interface CreateResult {
  ok: boolean;
  message?: string;
  payUrl?: string;
  tradeNo?: string;
  expiresAt?: string;
}

/** 解析下单响应：成功判定 + 收银台地址 + 服务商流水号 */
export function parseCreateResponse(mapping: GatewayMapping, payload: unknown): CreateResult {
  const r = mapping.response;
  const ok = matchesWhen(r.ok, payload);
  const message = r.message ? String(readPath(payload, r.message) ?? "") : undefined;
  if (!ok) return { ok: false, message: message || "网关返回失败" };

  const candidates = r.pay_url_from ?? (r.pay_url ? [r.pay_url] : []);
  let payUrl: string | undefined;
  for (const p of candidates) {
    const v = readPath(payload, p);
    if (typeof v === "string" && v.trim()) {
      payUrl = v.trim();
      break;
    }
  }
  if (payUrl && r.pay_url_force_https) payUrl = payUrl.replace(/^http:\/\//i, "https://");

  const tradeNoRaw = r.trade_no ? readPath(payload, r.trade_no) : undefined;
  const expiresRaw = r.expires_at ? readPath(payload, r.expires_at) : undefined;

  return {
    ok: true,
    payUrl,
    tradeNo: tradeNoRaw === undefined || tradeNoRaw === null ? undefined : String(tradeNoRaw),
    expiresAt: expiresRaw === undefined || expiresRaw === null ? undefined : String(expiresRaw),
  };
}

// ─────────────────────────────────────────────────────────────
// 回调
// ─────────────────────────────────────────────────────────────

/** 按映射读取回调参数（GET 查询串 / POST form / POST JSON） */
export async function readNotifyParams(
  mapping: GatewayMapping,
  request: Request,
): Promise<Record<string, unknown>> {
  const method = mapping.notify.method ?? "POST";
  if (method === "GET") {
    return Object.fromEntries(new URL(request.url).searchParams);
  }
  const text = await request.text();
  if ((mapping.notify.format ?? "json") === "json") {
    try {
      const parsed = JSON.parse(text) as unknown;
      return parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : {};
    } catch {
      return {};
    }
  }
  return Object.fromEntries(new URLSearchParams(text));
}

export interface NotifyResult {
  signOk: boolean;
  paid: boolean;
  orderNo: string | null;
  tradeNo: string | null;
  amountMinor: number | null;
  /** 原样保存进 `orders.raw_notify` */
  raw: string;
}

/**
 * 解析回调。**注意：这里只给出"通知说了什么"，不判定订单已付** ——
 * 已付必须由 `queryCharge` 复核（见 `docs/payments.md` §3.1）。
 */
export function parseNotify(
  mapping: GatewayMapping,
  params: Record<string, unknown>,
  secret: string,
): NotifyResult {
  const n = mapping.notify;
  const signOk = mapping.sign ? verifyParams(params, secret, mapping.sign) : true;

  const orderNoRaw = params[n.order_no];
  const tradeRaw = n.trade_no ? params[n.trade_no] : undefined;

  return {
    signOk,
    paid: matchesWhen(n.paid_when, params),
    orderNo: orderNoRaw === undefined || orderNoRaw === null ? null : String(orderNoRaw),
    tradeNo: tradeRaw === undefined || tradeRaw === null ? null : String(tradeRaw),
    amountMinor: n.amount
      ? parseAmount(params[n.amount], mapping.notify_amount_unit ?? mapping.amount_unit)
      : null,
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
  now: Date;
}

/** 这个网关能不能查单（`query` 没配 = 只能靠回调） */
export function hasQuery(mapping: GatewayMapping): boolean {
  return !!mapping.query && typeof mapping.query.path === "string" && mapping.query.path !== "";
}

/**
 * 组装查单请求（`fields` 的值支持模板占位）。
 * @throws 网关没有查单接口时 —— 调用方应先用 `hasQuery()` 判断
 */
export function buildQueryRequest(mapping: GatewayMapping, ctx: QueryContext): BuiltRequest {
  const q = mapping.query;
  if (!q) throw new Error("该网关没有配置查单接口（只能靠回调）");

  const vars: Record<string, string> = {
    merchant: ctx.merchant,
    secret: ctx.secret,
    order_no: ctx.orderNo,
    amount: String(formatAmount(ctx.amountMinor, mapping.amount_unit)),
    subject: ctx.subject,
    channel: String(mapping.channel_codes?.[ctx.method] ?? ctx.method),
    timestamp: formatTimestamp(ctx.now, mapping.timestamp_format),
    nonce: randomHex(),
  };
  const params: Record<string, unknown> = {};
  for (const [k, template] of Object.entries(q.fields)) {
    const value = template.replace(/\{(\w+)\}/g, (_, name: string) => vars[name] ?? "");
    // 模板里引用的变量为空 ⇒ 整个参数不发（同渠道码的处理）
    if (value !== "") params[k] = value;
  }
  if ((q.sign ?? "same") === "same" && mapping.sign) {
    params[mapping.sign.field ?? "sign"] = signParams(params, ctx.secret, mapping.sign);
  }

  const headers = baseHeaders(mapping, ctx.secret);
  const method = q.method ?? "POST";
  const format = q.format ?? "form";
  const url = joinUrl(ctx.endpoint, q.path);

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

export interface QueryResult {
  /** 网关层是否成功（`query.ok`） */
  ok: boolean;
  paid: boolean;
  /** 明确终态（失败/过期/撤销）：不再重试，直接收尾 */
  terminal: boolean;
  amountMinor: number | null;
  tradeNo: string | null;
  message?: string;
}

/** 解析查单响应 —— **这是"钱到了没有"的唯一权威来源** */
export function parseQueryResponse(mapping: GatewayMapping, payload: unknown): QueryResult {
  const q = mapping.query;
  if (!q) {
    return { ok: false, paid: false, terminal: false, amountMinor: null, tradeNo: null, message: "该网关不支持查单" };
  }
  const unit = mapping.query_amount_unit ?? mapping.amount_unit;
  const ok = q.ok ? matchesWhen(q.ok, payload) : true;
  const tradeRaw = q.trade_no ? readPath(payload, q.trade_no) : undefined;
  return {
    ok,
    paid: matchesWhen(q.paid_when, payload),
    terminal: matchesWhen(q.terminal_when, payload),
    amountMinor: q.amount ? parseAmount(readPath(payload, q.amount), unit) : null,
    tradeNo: tradeRaw === undefined || tradeRaw === null ? null : String(tradeRaw),
    message: q.message ? String(readPath(payload, q.message) ?? "") || undefined : undefined,
  };
}
