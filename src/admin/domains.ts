/**
 * 管理后台：自定义域名 `/api/admin/domains*`
 *
 * 四件事：
 *   `GET    /domains`                 当前租户的域名（`?refresh=1` 回源 Cloudflare）
 *   `POST   /domains`                 绑定一个 hostname
 *   `POST   /domains/:hostname/retry` 重新走 DCV
 *   `DELETE /domains/:hostname`       解绑
 *
 * 为什么后台不直接调 Cloudflare：云凭据只在 cf-api。CRM 拿的是**租户 API token**
 * （`cf_api` 单行，服务端解密），调 cf-api 的 `/api/v2/crms/domains`；浏览器永远
 * 看不到 token。
 *
 * 自部署（`MODE=single`）不参与托管绑定：只回一段说明，写操作 409。
 */
import { PlatformError } from "../platform/client";
import { createDomain, listDomains, removeDomain, retryDomain } from "../platform/domains";

import type { DomainKind } from "../platform/domains";
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
      const data = await listDomains(env, url.searchParams.get("refresh") === "1");
      return json({ supported: true, mode, ...data });
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
      return json({ supported: true, ...data }, 201);
    } catch (e) {
      return platformFail(e);
    }
  }

  const retry = path.match(/^\/domains\/([^/]+)\/retry$/);
  if (method === "POST" && retry) {
    if (mode !== "multi") return fail(409, "not_supported", SINGLE_REASON);
    const hostname = decodeURIComponent(retry[1] ?? "");
    try {
      const data = await retryDomain(env, hostname);
      await audit(env, actor, "domain.retry", hostname);
      return json({ supported: true, ...data });
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
      await audit(env, actor, "domain.remove", hostname);
      return json({ supported: true, ...data });
    } catch (e) {
      return platformFail(e);
    }
  }

  return null;
}
