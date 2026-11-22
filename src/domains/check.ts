/**
 * 自定义域名的「状态检查」——全部在 CRM 侧完成。
 *
 * cf-api 只负责 CF custom hostname 和 registry；这里负责：
 *   - 自动判断 DNS 服务商（查 NS，不需要用户选）
 *   - 查租户实际 DNS 记录（Cloudflare + Google DoH）
 *   - HEAD 网站，确认流量真的通
 *   - 把「期望 / 检测到 / 怎么改」算出来
 *
 * 不直连权威 NS：Workers 出站 TCP 禁止连 Cloudflare IP 段，CF 托管域名的 NS
 * 正好在 Cloudflare IP 段，TCP/53 不可行。DoH 双解析器 + CF 状态 + HEAD 足够
 * 定位“缺哪条、哪条错”，最终是否生效仍以 CF 的 hostname/cert 状态为准。
 */
import type { DomainDnsRecord, DomainView as RawDomainView } from "../platform/domains";

export type DomainStatus =
  | "pending_check"
  | "needs_action"
  | "wait"
  | "ready"
  | "manual"
  | "failed"
  | "unknown";

export type StepStatus = "done" | "todo" | "wait" | "unknown" | "manual";
export type StepProblem =
  | "missing"
  | "wrong_type"
  | "wrong_target"
  | "proxy"
  | "propagation"
  | "unknown"
  | null;

export type DnsProvider = "cloudflare" | "other" | "unknown";

export interface DnsRecord {
  type: "CNAME" | "A" | "AAAA" | "TXT";
  name: string;
  value: string;
}

export interface DomainCheckStep {
  id: "traffic" | "dcv" | "ownership";
  status: StepStatus;
  expected: DnsRecord | null;
  actual: DnsRecord[];
  problem: StepProblem;
  fix: string | null;
}

export interface DomainCheck {
  status: DomainStatus;
  provider: DnsProvider;
  steps: DomainCheckStep[];
  cert_expires_at: string | null;
  checked_at: string;
}

export interface CheckDeps {
  fetch: typeof fetch;
  now?: () => Date;
}

export interface PublicDomainView {
  hostname: string;
  kind: "site" | "crm";
  status: DomainStatus;
  last_checked_at: string | null;
}

const DNS_TYPES = {
  A: 1,
  NS: 2,
  CNAME: 5,
  TXT: 16,
  AAAA: 28,
} as const;
type DnsTypeName = keyof typeof DNS_TYPES;

interface DohAnswer {
  name: string;
  type: number;
  data: string;
}

interface DohResult {
  ok: boolean;
  answers: DohAnswer[];
  authority: DohAnswer[];
}

const DOH_ENDPOINTS = [
  "https://cloudflare-dns.com/dns-query",
  "https://dns.google/resolve",
];

const UNREACHABLE = new Set([522, 523, 524, 526, 530]);

const lower = (s: string): string => s.trim().toLowerCase().replace(/\.$/, "");

function txtValue(data: string): string {
  return data
    .trim()
    .replace(/^"+|"+$/g, "")
    .replace(/\\"/g, '"')
    .trim();
}

function recordValue(type: DnsRecord["type"], data: string): string {
  return type === "TXT" ? txtValue(data) : lower(data);
}

function dedupeAnswers(answers: DohAnswer[]): DohAnswer[] {
  const seen = new Set<string>();
  return answers.filter((a) => {
    const key = `${a.type}:${lower(a.data)}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

async function doh(
  endpoint: string,
  name: string,
  type: DnsTypeName,
  fetchImpl: typeof fetch,
): Promise<DohResult> {
  const url = new URL(endpoint);
  url.searchParams.set("name", name);
  url.searchParams.set("type", type);
  try {
    const res = await fetchImpl(url.toString(), {
      headers: { accept: "application/dns-json" },
      signal: AbortSignal.timeout(4000),
    });
    if (!res.ok) return { ok: false, answers: [], authority: [] };
    const body = (await res.json()) as {
      Answer?: DohAnswer[];
      Authority?: DohAnswer[];
    };
    return {
      ok: true,
      answers: Array.isArray(body.Answer) ? body.Answer : [],
      authority: Array.isArray(body.Authority) ? body.Authority : [],
    };
  } catch {
    return { ok: false, answers: [], authority: [] };
  }
}

async function lookup(
  name: string,
  type: DnsTypeName,
  fetchImpl: typeof fetch,
): Promise<DohResult> {
  const results = await Promise.all(DOH_ENDPOINTS.map((endpoint) => doh(endpoint, name, type, fetchImpl)));
  return {
    ok: results.some((r) => r.ok),
    answers: dedupeAnswers(results.flatMap((r) => r.answers)),
    authority: dedupeAnswers(results.flatMap((r) => r.authority)),
  };
}

function recordsOf(result: DohResult, name: string, type: DnsRecord["type"]): DnsRecord[] {
  return result.answers
    .filter((a) => a.type === DNS_TYPES[type])
    .map((a) => ({ type, name, value: recordValue(type, a.data) }));
}

function hasValue(records: DnsRecord[], expected: string): boolean {
  return records.some((r) => lower(r.value) === lower(expected));
}

async function detectProvider(hostname: string, fetchImpl: typeof fetch): Promise<DnsProvider> {
  const result = await lookup(hostname, "NS", fetchImpl);
  const ns = [...result.answers, ...result.authority]
    .filter((a) => a.type === DNS_TYPES.NS)
    .map((a) => lower(a.data));
  if (ns.some((n) => n === "ns.cloudflare.com" || n.endsWith(".ns.cloudflare.com"))) {
    return "cloudflare";
  }
  return ns.length > 0 ? "other" : "unknown";
}

async function trafficReachable(hostname: string, fetchImpl: typeof fetch): Promise<boolean> {
  try {
    const res = await fetchImpl(`https://${hostname}/`, {
      method: "HEAD",
      redirect: "follow",
      signal: AbortSignal.timeout(5000),
    });
    return res.status > 0 && !UNREACHABLE.has(res.status);
  } catch {
    return false;
  }
}

function providerWord(provider: DnsProvider): string {
  if (provider === "cloudflare") return "Cloudflare";
  if (provider === "other") return "其他 DNS";
  return "你的 DNS";
}

function trafficProxyHint(provider: DnsProvider): string {
  if (provider === "cloudflare") return "Cloudflare 里请把代理设为「已代理」（橙云）。";
  if (provider === "other") return "普通 CNAME，不需要代理。";
  return "如果域名在 Cloudflare，请把代理设为橙云；其他 DNS 直接用 CNAME。";
}

function dcvProxyHint(provider: DnsProvider): string {
  if (provider === "cloudflare") return "Cloudflare 里请把代理设为「仅 DNS」（灰云）。";
  if (provider === "other") return "普通 CNAME，不需要代理。";
  return "如果域名在 Cloudflare，请把代理设为灰云；其他 DNS 直接用 CNAME。";
}

/** 期望/实际/问题/怎么改 —— 每一步都在这里收口 */
async function trafficStep(
  raw: RawDomainView,
  provider: DnsProvider,
  fetchImpl: typeof fetch,
): Promise<DomainCheckStep> {
  const target = raw.dns?.target ?? "";
  const expected: DnsRecord | null = target
    ? { type: "CNAME", name: raw.hostname, value: target }
    : null;
  const [cname, a, aaaa, txt, reachable] = await Promise.all([
    lookup(raw.hostname, "CNAME", fetchImpl),
    lookup(raw.hostname, "A", fetchImpl),
    lookup(raw.hostname, "AAAA", fetchImpl),
    lookup(raw.hostname, "TXT", fetchImpl),
    trafficReachable(raw.hostname, fetchImpl),
  ]);
  const actual = [
    ...recordsOf(cname, raw.hostname, "CNAME"),
    ...recordsOf(a, raw.hostname, "A"),
    ...recordsOf(aaaa, raw.hostname, "AAAA"),
    ...recordsOf(txt, raw.hostname, "TXT"),
  ];
  const ok = cname.ok || a.ok || aaaa.ok || txt.ok;
  const cnameRecords = recordsOf(cname, raw.hostname, "CNAME");

  // 即使站点有响应，CNAME 指向别的目标也不算完成：可能打开的是另一个站点。
  if (target && cnameRecords.length > 0 && !hasValue(cnameRecords, target)) {
    return {
      id: "traffic",
      status: "todo",
      expected,
      actual,
      problem: "wrong_target",
      fix: `当前指向 ${cnameRecords[0]?.value ?? "未知"}，请改成 ${target}。`,
    };
  }

  if (reachable) {
    return { id: "traffic", status: "done", expected, actual, problem: null, fix: null };
  }
  if (!ok) {
    return {
      id: "traffic",
      status: "unknown",
      expected,
      actual,
      problem: "unknown",
      fix: "暂时无法检查 DNS，请稍后重试。",
    };
  }

  if (cnameRecords.length > 0) {
    return {
      id: "traffic",
      status: "todo",
      expected,
      actual,
      problem: "proxy",
      fix: `网站 522/不可达，但 CNAME 已指向 ${target || "平台给出的目标"}。${trafficProxyHint(provider)}`,
    };
  }

  if (actual.some((r) => r.type === "A" || r.type === "AAAA")) {
    if (provider === "cloudflare") {
      return {
        id: "traffic",
        status: "todo",
        expected,
        actual,
        problem: "proxy",
        fix: `检测到 A/AAAA（可能是 Cloudflare 代理）；请确认 CNAME 指向 ${target || "origin-site"} 且代理为橙云。`,
      };
    }
    return {
      id: "traffic",
      status: "todo",
      expected,
      actual,
      problem: "wrong_type",
      fix: `当前是 A/AAAA 记录；请改用 CNAME${target ? ` → ${target}` : ""}；根域需要 CNAME 展平/ALIAS。`,
    };
  }
  return {
    id: "traffic",
    status: "todo",
    expected,
    actual,
    problem: "missing",
    fix: `在 DNS 添加 CNAME ${raw.hostname}${target ? ` → ${target}` : ""}。${trafficProxyHint(provider)}`,
  };
}

async function dcvStep(
  raw: RawDomainView,
  provider: DnsProvider,
  fetchImpl: typeof fetch,
): Promise<DomainCheckStep> {
  const record: DomainDnsRecord | undefined = raw.dns?.dcv[0];
  if (!record) {
    return {
      id: "dcv",
      status: "manual",
      expected: null,
      actual: [],
      problem: null,
      fix: "平台没有拿到证书续期记录，请联系客服处理。",
    };
  }
  const expected: DnsRecord = { type: "CNAME", name: record.name, value: record.value };
  const [cname, txt] = await Promise.all([
    lookup(record.name, "CNAME", fetchImpl),
    lookup(record.name, "TXT", fetchImpl),
  ]);
  const actual = [
    ...recordsOf(cname, record.name, "CNAME"),
    ...recordsOf(txt, record.name, "TXT"),
  ];
  const cnameRecords = recordsOf(cname, record.name, "CNAME");
  const active = raw.hostname_status === "active" && raw.cert_status === "active";
  if (cnameRecords.length > 0 && hasValue(cnameRecords, record.value)) {
    return {
      id: "dcv",
      status: active ? "done" : "wait",
      expected,
      actual,
      problem: active ? null : "propagation",
      fix: active ? null : "已检测到续期记录，等待证书生效；稍后再检查。",
    };
  }
  if (cnameRecords.length > 0) {
    return {
      id: "dcv",
      status: "todo",
      expected,
      actual,
      problem: "wrong_target",
      fix: `当前指向 ${cnameRecords[0]?.value ?? "未知"}，请改成 ${record.value}。${dcvProxyHint(provider)}`,
    };
  }
  if (actual.some((r) => r.type === "TXT")) {
    return {
      id: "dcv",
      status: "todo",
      expected,
      actual,
      problem: "wrong_type",
      fix: `当前是 TXT 记录；请删除后改成 CNAME ${record.name} → ${record.value}；CNAME 和 TXT 不能同名共存。`,
    };
  }
  if (!cname.ok && !txt.ok) {
    return {
      id: "dcv",
      status: "unknown",
      expected,
      actual,
      problem: "unknown",
      fix: "暂时无法检查 DNS，请稍后重试。",
    };
  }
  return {
    id: "dcv",
    status: "todo",
    expected,
    actual,
    problem: "missing",
    fix: `在 DNS 添加 CNAME ${record.name} → ${record.value}。${dcvProxyHint(provider)}`,
  };
}

async function ownershipStep(
  raw: RawDomainView,
  fetchImpl: typeof fetch,
): Promise<DomainCheckStep | null> {
  if (raw.hostname_status === "active") return null;
  const record = raw.dns?.ownership;
  if (!record) {
    return {
      id: "ownership",
      status: "manual",
      expected: null,
      actual: [],
      problem: null,
      fix: "平台没有返回归属验证记录，请联系客服处理。",
    };
  }
  const expected: DnsRecord = { type: "TXT", name: record.name, value: record.value };
  const [txt, cname] = await Promise.all([
    lookup(record.name, "TXT", fetchImpl),
    lookup(record.name, "CNAME", fetchImpl),
  ]);
  const actual = [
    ...recordsOf(txt, record.name, "TXT"),
    ...recordsOf(cname, record.name, "CNAME"),
  ];
  const txtRecords = recordsOf(txt, record.name, "TXT");
  if (txtRecords.length > 0 && hasValue(txtRecords, record.value)) {
    return {
      id: "ownership",
      status: "wait",
      expected,
      actual,
      problem: "propagation",
      fix: "已检测到归属验证记录，等待 Cloudflare 生效；稍后再检查。",
    };
  }
  if (txtRecords.length > 0) {
    return {
      id: "ownership",
      status: "todo",
      expected,
      actual,
      problem: "wrong_target",
      fix: `当前 TXT 值是 ${txtRecords[0]?.value ?? "未知"}，请改成 ${record.value}。`,
    };
  }
  if (actual.some((r) => r.type === "CNAME")) {
    return {
      id: "ownership",
      status: "todo",
      expected,
      actual,
      problem: "wrong_type",
      fix: `当前是 CNAME 记录；请删除后添加 TXT ${record.name} → ${record.value}。`,
    };
  }
  if (!txt.ok && !cname.ok) {
    return {
      id: "ownership",
      status: "unknown",
      expected,
      actual,
      problem: "unknown",
      fix: "暂时无法检查 DNS，请稍后重试。",
    };
  }
  return {
    id: "ownership",
    status: "todo",
    expected,
    actual,
    problem: "missing",
    fix: `在 DNS 添加 TXT ${record.name} → ${record.value}。先等 5 分钟；如果状态仍是等待验证再加。`,
  };
}

export async function runDomainCheck(
  raw: RawDomainView,
  deps: CheckDeps,
): Promise<DomainCheck> {
  const now = deps.now ?? (() => new Date());
  const checkedAt = now().toISOString();

  if (!raw.dns) {
    return {
      status: "unknown",
      provider: "unknown",
      steps: [],
      cert_expires_at: raw.cert_expires_at ?? null,
      checked_at: checkedAt,
    };
  }

  const provider = await detectProvider(raw.hostname, deps.fetch);
  const [traffic, dcv, ownership] = await Promise.all([
    trafficStep(raw, provider, deps.fetch),
    dcvStep(raw, provider, deps.fetch),
    ownershipStep(raw, deps.fetch),
  ]);
  const steps = [traffic, dcv, ...(ownership ? [ownership] : [])];

  const manual = steps.some((s) => s.status === "manual");
  const todo = steps.some((s) => s.status === "todo");
  const unknown = steps.some((s) => s.status === "unknown");
  const waiting = steps.some((s) => s.status === "wait");
  const active = raw.hostname_status === "active" && raw.cert_status === "active";

  let status: DomainStatus;
  if (raw.state === "failed") status = "failed";
  else if (manual) status = "manual";
  else if (todo) status = "needs_action";
  else if (unknown) status = "unknown";
  else if (waiting || !active) status = "wait";
  else status = "ready";

  return {
    status,
    provider,
    steps,
    cert_expires_at: raw.cert_expires_at ?? null,
    checked_at: checkedAt,
  };
}

export function providerLabel(provider: DnsProvider): string {
  return providerWord(provider);
}
