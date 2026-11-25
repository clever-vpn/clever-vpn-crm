/**
 * `POST /api/admin/gateways/ai-fetch-doc`：用户给公开文档 URL，服务端抓同源相关页。
 *
 * 管理员会话/CSRF 由 admin router 负责；这里做：
 *   - 每小时 10 次限流（audit_log，跨 isolate）
 *   - AI 选页（可用时）+ 关键词兜底（在 doc-fetch 内）
 *   - 把 DocFetchError 映射成可照做的 HTTP 错误
 * 审计只记 host/页数/是否用 AI/warnings 数，不记正文。
 */

import { AI_LIMITS, aiRuntime } from "../payments/ai";
import { DocFetchError, fetchDocFromUrl } from "../payments/doc-fetch";
import { selectDocPages } from "../payments/doc-select";

import type { Env } from "../env";

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8" },
  });
}

const fail = (status: number, error: string, message: string): Response =>
  json({ error, message }, status);

async function readBody(request: Request): Promise<Record<string, unknown>> {
  const body = await request.json().catch(() => null);
  return body && typeof body === "object" ? (body as Record<string, unknown>) : {};
}

async function auditFetch(
  env: Env,
  actor: string,
  detail: Record<string, unknown>,
): Promise<void> {
  await env.DB.prepare(
    `INSERT INTO audit_log (at, actor, action, target, detail) VALUES (?, ?, 'gateway_ai_fetch', NULL, ?)`,
  )
    .bind(new Date().toISOString(), actor, JSON.stringify(detail))
    .run();
}

async function fetchUsedLastHour(env: Env, now: Date): Promise<number> {
  const since = new Date(now.getTime() - 60 * 60 * 1000).toISOString();
  const row = await env.DB.prepare(
    `SELECT COUNT(*) AS n FROM audit_log WHERE action = 'gateway_ai_fetch' AND at >= ?`,
  )
    .bind(since)
    .first<{ n: number }>();
  return Number(row?.n ?? 0);
}

function hostOf(url: string): string {
  try {
    return new URL(url).hostname;
  } catch {
    return "";
  }
}

export async function handleAdminGatewayDocFetch(
  request: Request,
  env: Env,
  actor: string,
  tenantId: string,
): Promise<Response | null> {
  const path = new URL(request.url).pathname.replace(/^\/api\/admin/, "");
  if (request.method !== "POST" || path !== "/gateways/ai-fetch-doc") return null;

  const body = await readBody(request);
  const url = typeof body.url === "string" ? body.url.trim() : "";
  if (!url) return fail(400, "invalid_url", "请填文档入口 URL");
  if (url.length > 2048) return fail(400, "invalid_url", "URL 过长");

  const now = new Date();
  if ((await fetchUsedLastHour(env, now)) >= AI_LIMITS.fetchPerHour) {
    return fail(429, "ai_fetch_rate_limited", `每小时最多抓取 ${AI_LIMITS.fetchPerHour} 次，请稍后再试`);
  }

  // AI 不可用（未配置/租户 ID 非数字）时仍可抓：走关键词选页
  const runtime = aiRuntime(env, tenantId);
  const selectPages = runtime ? (links: Parameters<typeof selectDocPages>[1]) => selectDocPages(runtime, links) : undefined;

  try {
    const result = await fetchDocFromUrl(url, { selectPages });
    await auditFetch(env, actor, {
      ok: true,
      host: hostOf(url),
      pages: result.pages.length,
      aiUsed: result.aiUsed,
      warnings: result.warnings.length,
    });
    return json({
      entry: result.entry,
      pages: result.pages,
      document: result.document,
      warnings: result.warnings,
      ai_used: result.aiUsed,
    });
  } catch (error) {
    if (error instanceof DocFetchError) {
      await auditFetch(env, actor, { ok: false, host: hostOf(url), code: error.code });
      return fail(error.status, error.code, error.message);
    }
    await auditFetch(env, actor, { ok: false, host: hostOf(url), code: "doc_fetch_failed" });
    return fail(502, "doc_fetch_failed", "抓取文档失败，请稍后重试或改用粘贴/文件导入");
  }
}
