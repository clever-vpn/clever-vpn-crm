/**
 * 管理后台：自定义域名 `/api/admin/domains*`
 *
 * 四件事：
 *   `GET    /domains`                 当前租户的域名 + CRM 本地检查状态
 *   `POST   /domains`                 绑定一个 hostname
 *   `POST   /domains/:hostname/check` 状态检查（DNS/HEAD 全在 CRM）
 *   `DELETE /domains/:hostname`       解绑
 *
 * 为什么后台不直接调 Cloudflare：云凭据只在 cf-api。CRM 拿的是**租户 API token**
 * （`cf_api` 单行，服务端解密），调 cf-api 的 `/api/v2/crms/domains`；浏览器永远
 * 看不到 token。
 *
 * 自部署（`MODE=single`）不参与托管绑定：只回一段说明，写操作 409。
 */
import { runDomainCheck } from "../domains/check";
import { PlatformError } from "../platform/client";
import { createDomain, getDomain, listDomains, removeDomain } from "../platform/domains";

import type { DomainCheck, DomainStatus, PublicDomainView } from "../domains/check";
import type { DomainKind, DomainView as RawDomainView } from "../platform/domains";
import type { Env } from "../env";

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8" },
  });
}

const fail = (status: number, error: string, message?: string) =>
  json(message ? { error, message } : { error }, status);

const SINGLE_REASON =
  "自部署模式下域名由你自己管理：给 site-serve 加 Custom Domain，并写 KV[host:<域名>]；后台域名给 CRM Worker 加 Custom Domain 即可。CRM 不参与托管绑定。";

async function readBody(request: Request): Promise<Record<string, unknown>> {
  try {
    const parsed = (await request.json()) as unknown;
    return parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

async function audit(
  env: Env,
  actor: string,
  action: string,
  target: string,
  detail?: unknown,
): Promise<void> {
  await env.DB.prepare(
    `INSERT INTO audit_log (at, actor, action, target, detail) VALUES (?, ?, ?, ?, ?)`,
  )
    .bind(
      new Date().toISOString(),
      actor,
      action,
      target,
      detail === undefined ? null : JSON.stringify(detail),
    )
    .run();
}

/** cf-api 的 `PlatformError` → 后台 HTTP。保留状态码，文案直接给租户看。 */
function platformFail(e: unknown): Response {
  if (e instanceof PlatformError) {
    if (e.status === 0) {
      return fail(503, "platform_unreachable", e.message);
    }
    if (e.status === 401 || e.status === 403) {
      return fail(
        502,
        "platform_auth_failed",
        `cf-api 拒绝了平台 token，请到「设置 → cf-api 对接」检查：${e.message}`,
      );
    }
    if (e.status === 400) return fail(400, "invalid_domain", e.message);
    if (e.status === 404) return fail(404, "not_found", e.message);
    if (e.status === 409) return fail(409, "conflict", e.message);
    if (e.status === 429) return fail(429, "rate_limited", e.message);
    return fail(502, "platform_error", e.message);
  }
  return fail(502, "platform_error", e instanceof Error ? e.message : String(e));
}

function parseKind(raw: unknown): DomainKind | null {
  return raw === "site" || raw === "crm" ? raw : null;
}

function toPublicDomain(
  raw: RawDomainView,
  status: DomainStatus = "pending_check",
  checkedAt: string | null = null,
): PublicDomainView {
  return {
    hostname: raw.hostname,
    kind: raw.kind === "crm" ? "crm" : "site",
    status,
    last_checked_at: checkedAt,
  };
}

interface CheckRow {
  hostname: string;
  status: DomainStatus;
  checked_at: string;
}

async function checksOf(env: Env): Promise<Map<string, CheckRow>> {
  const { results } = await env.DB.prepare(
    "SELECT hostname, status, checked_at FROM domain_checks",
  ).all<CheckRow>();
  return new Map((results ?? []).map((r) => [r.hostname, r]));
}

const lastChecks = new Map<string, number>();

export async function handleAdminDomains(
  request: Request,
  env: Env,
  actor: string,
): Promise<Response | null> {
  const url = new URL(request.url);
  const path = url.pathname.slice("/api/admin".length);
  const method = request.method;
  const mode = (env.MODE ?? "single").toLowerCase();

  if (method === "GET" && path === "/domains") {
    if (mode !== "multi") {
      return json({ supported: false, mode, reason: SINGLE_REASON });
    }
    try {
      const data = await listDomains(env);
      const checks = await checksOf(env);
      const domains = (data.domains ?? []).map((d) => {
        const check = checks.get(d.hostname);
        return toPublicDomain(d, check?.status ?? "pending_check", check?.checked_at ?? null);
      });
      return json({ supported: true, mode, ...data, domains });
    } catch (e) {
      return platformFail(e);
    }
  }

  if (method === "POST" && path === "/domains") {
    if (mode !== "multi") return fail(409, "not_supported", SINGLE_REASON);
    const body = await readBody(request);
    const hostname = typeof body.hostname === "string" ? body.hostname.trim() : "";
    const kind = parseKind(body.kind);
    if (!hostname) return fail(400, "invalid_hostname", "请填写域名");
    if (!kind) return fail(400, "invalid_kind", "kind 只能是 site 或 crm");
    try {
      const data = await createDomain(env, { hostname, kind });
      await audit(env, actor, "domain.add", hostname, { kind });
      return json({ supported: true, domain: toPublicDomain(data.domain) }, 201);
    } catch (e) {
      return platformFail(e);
    }
  }

  const check = path.match(/^\/domains\/([^/]+)\/check$/);
  if (method === "POST" && check) {
    if (mode !== "multi") return fail(409, "not_supported", SINGLE_REASON);
    const hostname = decodeURIComponent(check[1] ?? "");
    const now = Date.now();
    const key = `${actor}:${hostname}`;
    if (now - (lastChecks.get(key) ?? 0) < 5000) {
      return fail(429, "rate_limited", "状态检查太频繁，请 5 秒后再试");
    }
    lastChecks.set(key, now);
    try {
      const data = await getDomain(env, hostname, true);
      const result: DomainCheck = await runDomainCheck(data.domain, { fetch });
      await env.DB.prepare(
        `INSERT INTO domain_checks (hostname, status, checked_at)
         VALUES (?, ?, ?)
         ON CONFLICT(hostname) DO UPDATE SET status = excluded.status, checked_at = excluded.checked_at`,
      )
        .bind(hostname, result.status, result.checked_at)
        .run()
        .catch(() => undefined);
      return json({
        supported: true,
        domain: toPublicDomain(data.domain, result.status, result.checked_at),
        check: result,
      });
    } catch (e) {
      return platformFail(e);
    }
  }

  const one = path.match(/^\/domains\/([^/]+)$/);
  if (method === "DELETE" && one) {
    if (mode !== "multi") return fail(409, "not_supported", SINGLE_REASON);
    const hostname = decodeURIComponent(one[1] ?? "");
    try {
      const data = await removeDomain(env, hostname);
      await env.DB.prepare("DELETE FROM domain_checks WHERE hostname = ?")
        .bind(hostname)
        .run()
        .catch(() => undefined);
      await audit(env, actor, "domain.remove", hostname);
      return json({ supported: true, ...data });
    } catch (e) {
      return platformFail(e);
    }
  }

  return null;
}
