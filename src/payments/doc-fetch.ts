/**
 * 文档网址导入：抓入口页 → 抽同源链接 → 选相关页 → 串行抓取 → 合并正文。
 *
 * 安全边界：
 *   - 只允许公开 http/https，拒绝环回/私网/metadata；用 DoH 解析后再抓；
 *   - 重定向逐跳校验；不带 Cookie/Authorization；
 *   - 页数/单页大小/总正文/超时都有上限，避免变成通用代理或爬虫。
 *
 * 这里只做**静态 HTML/文本**。JS 渲染的 SPA 只能拿到空壳，会返回 no_document。
 */

const DNS_ENDPOINT = "https://cloudflare-dns.com/dns-query";
const MAX_PAGES = 8;
const MAX_LINKS = 80;
const PAGE_TIMEOUT_MS = 12_000;
const TOTAL_TIMEOUT_MS = 45_000;
const MAX_PAGE_BYTES = 2 * 1024 * 1024;
const MAX_PAGE_TEXT = 20 * 1024;
const MAX_DOC_BYTES = 100 * 1024;

export class DocFetchError extends Error {
  readonly code: string;
  readonly status: number;
  constructor(code: string, status: number, message: string) {
    super(message);
    this.code = code;
    this.status = status;
  }
}

export interface DocLink {
  /** 1-based，给 AI 选页用 */
  index: number;
  url: string;
  text: string;
  score: number;
}

export interface DocPage {
  url: string;
  title: string;
  text: string;
  chars: number;
  selected: boolean;
  reason: "entry" | "ai" | "keyword";
}

export interface DocFetchResult {
  entry: string;
  pages: DocPage[];
  document: string;
  warnings: string[];
  aiUsed: boolean;
}

export interface DocFetchOptions {
  fetchImpl?: typeof fetch;
  /** 由路由注入：AI 选页；返回 null/空 = 关键词兜底 */
  selectPages?: (links: DocLink[]) => Promise<number[] | null>;
  maxPages?: number;
}

interface FetchedPage {
  url: string;
  title: string;
  text: string;
  links: DocLink[];
  truncated: boolean;
}

function normalize(text: string): string {
  return text.replace(/\u00a0/g, " ").replace(/\s+/g, " ").trim();
}

function decodeEntities(text: string): string {
  return text
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#0*39;/gi, "'")
    .replace(/&nbsp;/gi, " ");
}

function isPrivateIpv4(ip: string): boolean {
  const parts = ip.split(".").map((x) => Number(x));
  if (parts.length !== 4 || parts.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return false;
  const [a, b] = parts as [number, number, number, number];
  if (a === 0 || a === 10 || a === 127) return true;
  if (a === 169 && b === 254) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 168) return true;
  if (a === 100 && b >= 64 && b <= 127) return true;
  if (a === 192 && b === 0 && parts[2] === 0) return true;
  if (a === 198 && (b === 18 || b === 19)) return true;
  if (a >= 224) return true;
  return false;
}

function isPrivateIpv6(ip: string): boolean {
  const s = ip.toLowerCase();
  if (s === "::" || s === "::1") return true;
  if (s.startsWith("fc") || s.startsWith("fd")) return true;
  if (/^fe[89ab]/.test(s)) return true;
  if (s.startsWith("::ffff:")) return isPrivateIpv4(s.slice(7));
  return false;
}

function isIpLiteral(host: string): boolean {
  return /^\d{1,3}(\.\d{1,3}){3}$/.test(host) || host.includes(":");
}

function isBlockedHostname(host: string): boolean {
  const h = host.toLowerCase();
  if (h === "localhost" || h.endsWith(".localhost")) return true;
  if (h.endsWith(".local") || h.endsWith(".internal")) return true;
  if (h === "metadata.google.internal" || h === "metadata") return true;
  if (isIpLiteral(h)) return isPrivateIpv6(h) || isPrivateIpv4(h);
  return false;
}

/** 解析并校验入口 URL；不通过直接抛 DocFetchError。 */
export function assertAllowedDocUrl(input: string): URL {
  let url: URL;
  try {
    url = new URL(input);
  } catch {
    throw new DocFetchError("invalid_url", 400, "URL 格式不对，请填完整地址（含 http:// 或 https://）");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new DocFetchError("invalid_url", 400, "只支持 http/https 文档地址");
  }
  if (url.username || url.password) {
    throw new DocFetchError("invalid_url", 400, "URL 不能带用户名/密码");
  }
  if (url.port && url.port !== "80" && url.port !== "443") {
    throw new DocFetchError("invalid_url", 400, "只支持 80/443 端口");
  }
  const host = url.hostname.replace(/^\[|\]$/g, "").toLowerCase();
  if (isBlockedHostname(host)) {
    throw new DocFetchError("blocked_host", 403, "这个地址指向本机/私网/metadata，不能抓取");
  }
  return url;
}

async function dohAnswers(host: string, type: "A" | "AAAA", fetchImpl: typeof fetch): Promise<string[]> {
  const res = await fetchImpl(`${DNS_ENDPOINT}?name=${encodeURIComponent(host)}&type=${type}`, {
    headers: { accept: "application/dns-json" },
  });
  if (!res.ok) throw new DocFetchError("blocked_host", 403, "无法解析文档域名，已停止抓取");
  const body = (await res.json().catch(() => null)) as { Answer?: { data?: unknown }[] } | null;
  return (body?.Answer ?? [])
    .map((a) => (typeof a.data === "string" ? a.data : ""))
    .filter(Boolean);
}

/** DoH 解析并拒绝任何私网结果；DoH 失败也 fail closed。 */
export async function assertPublicResolution(host: string, fetchImpl: typeof fetch = fetch): Promise<void> {
  if (isIpLiteral(host)) {
    if (isBlockedHostname(host)) throw new DocFetchError("blocked_host", 403, "这个地址指向本机/私网，不能抓取");
    return;
  }
  let answers: string[];
  try {
    answers = [...(await dohAnswers(host, "A", fetchImpl)), ...(await dohAnswers(host, "AAAA", fetchImpl))];
  } catch (error) {
    if (error instanceof DocFetchError) throw error;
    throw new DocFetchError("blocked_host", 403, "无法解析文档域名，已停止抓取");
  }
  if (answers.length === 0) {
    throw new DocFetchError("blocked_host", 403, "域名没有可用的 A/AAAA 记录，已停止抓取");
  }
  for (const ip of answers) {
    if (isPrivateIpv4(ip) || isPrivateIpv6(ip)) {
      throw new DocFetchError("blocked_host", 403, "域名解析到本机/私网地址，不能抓取");
    }
  }
}

function withTimeout<T>(work: (signal: AbortSignal) => Promise<T>, timeoutMs: number): Promise<T> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  return work(controller.signal).finally(() => clearTimeout(timer));
}

async function safeFetch(start: URL, fetchImpl: typeof fetch, timeoutMs: number): Promise<Response> {
  let current = start;
  for (let i = 0; i < 4; i += 1) {
    assertAllowedDocUrl(current.toString());
    await assertPublicResolution(current.hostname.replace(/^\[|\]$/g, ""), fetchImpl);
    let res: Response;
    try {
      res = await withTimeout(
        (signal) =>
          fetchImpl(current.toString(), {
            redirect: "manual",
            headers: {
              accept: "text/html,application/xhtml+xml,text/plain,application/json;q=0.9,*/*;q=0.1",
              "user-agent": "CleverVPN-CRM-DocFetcher/1.0",
            },
            signal,
          }),
        timeoutMs,
      );
    } catch {
      throw new DocFetchError("doc_fetch_failed", 502, "抓取文档超时或网络失败");
    }
    if (![301, 302, 303, 307, 308].includes(res.status)) return res;
    const location = res.headers.get("location");
    if (!location) throw new DocFetchError("doc_fetch_failed", 502, "文档返回了空重定向");
    const next = new URL(location, current);
    const sameHost =
      next.hostname === current.hostname ||
      next.hostname === `www.${current.hostname}` ||
      current.hostname === `www.${next.hostname}`;
    if (!sameHost) throw new DocFetchError("blocked_host", 403, "文档重定向到了其他域名，已停止");
    current = next;
  }
  throw new DocFetchError("doc_fetch_failed", 502, "重定向次数过多");
}

async function readCapped(res: Response, maxBytes: number): Promise<string> {
  const length = Number(res.headers.get("content-length") ?? 0);
  if (Number.isFinite(length) && length > maxBytes) {
    throw new DocFetchError("document_too_large", 413, "单页文档超过 2MB");
  }
  if (!res.body) return "";
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (value) {
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel().catch(() => undefined);
        throw new DocFetchError("document_too_large", 413, "单页文档超过 2MB");
      }
      chunks.push(value);
    }
  }
  const merged = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    merged.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(merged);
}

function truncateUtf8(text: string, maxBytes: number): { text: string; truncated: boolean } {
  const encoder = new TextEncoder();
  let bytes = 0;
  let out = "";
  for (const ch of text) {
    const n = encoder.encode(ch).byteLength;
    if (bytes + n > maxBytes) return { text: out, truncated: true };
    out += ch;
    bytes += n;
  }
  return { text: out, truncated: false };
}

/** 抽同源链接：保留 query（chapter=1），去 hash，跳过 javascript/mailto/跨源。 */
export function extractDocLinks(html: string, baseUrl: string): DocLink[] {
  const base = new URL(baseUrl);
  const links: DocLink[] = [];
  const seen = new Set<string>();
  const re = /<a\b[^>]*\bhref\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))[^>]*>([\s\S]*?)<\/a>/gi;
  let match: RegExpExecArray | null;
  while ((match = re.exec(html)) && links.length < MAX_LINKS) {
    const href = decodeEntities(match[1] ?? match[2] ?? match[3] ?? "").trim();
    if (!href || href.startsWith("#") || /^(javascript|mailto|tel|data):/i.test(href)) continue;
    let url: URL;
    try {
      url = new URL(href, base);
    } catch {
      continue;
    }
    if (url.protocol !== "http:" && url.protocol !== "https:") continue;
    if (url.origin !== base.origin) continue;
    url.hash = "";
    const key = url.toString();
    if (key === base.toString() || seen.has(key)) continue;
    seen.add(key);
    const text = normalize(decodeEntities((match[4] ?? "").replace(/<[^>]+>/g, " ")));
    links.push({ index: links.length + 1, url: key, text, score: scoreDocLink(text, key) });
  }
  return links;
}

/** 关键词兜底评分；yimapay 的「创建订单/查询订单/支付通知/签名规则」会高分。 */
export function scoreDocLink(text: string, url: string): number {
  const hay = `${text} ${url}`.toLowerCase();
  let score = 0;
  if (/(下单|创建订单|支付下单|发起支付|order\/create|checkout)/i.test(hay)) score += 8;
  if (/(回调|通知|notify|callback)/i.test(hay)) score += 8;
  if (/(查单|查询订单|订单查询|query|order\/status)/i.test(hay)) score += 8;
  if (/(签名|验签|sign)/i.test(hay)) score += 6;
  if (/(概述|规则|协议|api\s*总览|接口说明|overview)/i.test(hay)) score += 3;
  if (/(退款|refund|关闭|close|登录|注册|博客|价格|关于|about)/i.test(hay)) score -= 6;
  return score;
}

async function htmlToText(html: string): Promise<{ title: string; text: string }> {
  let title = "";
  let body = "";
  const rewriter = new HTMLRewriter()
    .on("title", { text(chunk) { title += chunk.text; } })
    .on("body", { text(chunk) { body += chunk.text; if (chunk.lastInTextNode) body += " "; } });
  for (const selector of ["script", "style", "noscript", "svg", "canvas", "nav", "header", "footer", "aside"]) {
    rewriter.on(selector, { element(el) { el.remove(); } });
  }
  const response = rewriter.transform(new Response(html, { headers: { "content-type": "text/html" } }));
  await response.text();
  return { title: normalize(title), text: normalize(body) };
}

async function fetchPage(input: string, fetchImpl: typeof fetch, timeoutMs: number): Promise<FetchedPage> {
  const url = assertAllowedDocUrl(input);
  const res = await safeFetch(url, fetchImpl, timeoutMs);
  if (!res.ok) throw new DocFetchError("doc_fetch_failed", 502, `文档返回 HTTP ${res.status}`);
  const contentType = (res.headers.get("content-type") ?? "text/html").toLowerCase();
  const allowed =
    contentType.includes("text/html") ||
    contentType.includes("application/xhtml+xml") ||
    contentType.startsWith("text/plain") ||
    contentType.includes("application/json");
  if (!allowed) throw new DocFetchError("unsupported_content", 422, `文档类型不支持：${contentType.split(";")[0]}`);

  const raw = await readCapped(res, MAX_PAGE_BYTES);
  let title = url.pathname.split("/").filter(Boolean).pop() ?? url.hostname;
  let text: string;
  if (contentType.includes("text/html") || contentType.includes("application/xhtml+xml")) {
    const parsed = await htmlToText(raw);
    title = parsed.title || title;
    text = parsed.text;
  } else {
    text = normalize(raw);
  }
  const clipped = truncateUtf8(text, MAX_PAGE_TEXT);
  return {
    url: res.url || url.toString(),
    title: title || url.toString(),
    text: clipped.text,
    links: contentType.includes("text/html") ? extractDocLinks(raw, res.url || url.toString()) : [],
    truncated: clipped.truncated,
  };
}

/** 合并页面；总正文超 100KB 时截断并返回 warning。 */
export function combineDocPages(pages: DocPage[]): { document: string; truncated: boolean } {
  const sections = pages.map((p, i) => `===== 页面 ${i + 1}/${pages.length}: ${p.title} — ${p.url} =====\n${p.text}`);
  const joined = sections.join("\n\n").trim();
  const clipped = truncateUtf8(joined, MAX_DOC_BYTES);
  return { document: clipped.text, truncated: clipped.truncated };
}

/**
 * 抓取 URL 并返回页面清单 + 合并正文。
 * `selectPages` 只拿到链接元数据，拿不到正文；返回 null/空时走关键词。
 */
export async function fetchDocFromUrl(input: string, options: DocFetchOptions = {}): Promise<DocFetchResult> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const maxPages = Math.max(1, Math.min(options.maxPages ?? MAX_PAGES, MAX_PAGES));
  const deadline = Date.now() + TOTAL_TIMEOUT_MS;
  const remaining = (): number => Math.max(1000, Math.min(PAGE_TIMEOUT_MS, deadline - Date.now()));
  const warnings: string[] = [];

  const entryUrl = assertAllowedDocUrl(input);
  await assertPublicResolution(entryUrl.hostname.replace(/^\[|\]$/g, ""), fetchImpl);
  const entry = await fetchPage(entryUrl.toString(), fetchImpl, remaining());
  if (entry.truncated) warnings.push(`入口页正文超过 ${MAX_PAGE_TEXT / 1024}KB，已截断`);

  let aiUsed = false;
  let selectedLinks: DocLink[] = [];
  const links = entry.links;
  if (links.length > 0 && options.selectPages) {
    try {
      const picked = await options.selectPages(links);
      if (Array.isArray(picked) && picked.length > 0) {
        const byIndex = new Map(links.map((l) => [l.index, l]));
        selectedLinks = [...new Set(picked)]
          .map((i) => byIndex.get(i))
          .filter((l): l is DocLink => Boolean(l))
          .slice(0, maxPages - 1);
        aiUsed = selectedLinks.length > 0;
      }
    } catch {
      warnings.push("AI 选页失败，已按关键词选择页面");
    }
  }
  if (selectedLinks.length === 0) {
    selectedLinks = links
      .filter((l) => l.score > 0)
      .sort((a, b) => b.score - a.score || a.index - b.index)
      .slice(0, maxPages - 1);
  }
  if (selectedLinks.length === 0) {
    warnings.push("没有发现明显的下单/回调/查单页面；建议直接粘贴或上传完整文档");
  }

  const pages: DocPage[] = [{
    url: entry.url,
    title: entry.title,
    text: entry.text,
    chars: [...entry.text].length,
    selected: true,
    reason: "entry",
  }];
  for (const link of selectedLinks) {
    if (Date.now() >= deadline) {
      warnings.push("抓取总时间超过 45 秒，后续页面已跳过");
      break;
    }
    try {
      const page = await fetchPage(link.url, fetchImpl, remaining());
      if (page.truncated) warnings.push(`${link.url} 正文超过 ${MAX_PAGE_TEXT / 1024}KB，已截断`);
      pages.push({
        url: page.url,
        title: page.title,
        text: page.text,
        chars: [...page.text].length,
        selected: true,
        reason: aiUsed ? "ai" : "keyword",
      });
    } catch (error) {
      const message = error instanceof DocFetchError ? error.message : "抓取失败";
      warnings.push(`${link.url}：${message}`);
    }
  }

  const combined = combineDocPages(pages);
  if (combined.truncated) warnings.push(`合并正文超过 ${MAX_DOC_BYTES / 1024}KB，已截断`);
  if (!pages.some((p) => p.text.trim())) {
    throw new DocFetchError("no_document", 422, "没有抓到可用正文；页面可能是 JS 渲染或需要登录");
  }
  return { entry: entry.url, pages, document: combined.document, warnings, aiUsed };
}
