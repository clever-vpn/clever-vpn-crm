/**
 * 管理后台：AI 配置助手 `POST /api/admin/gateways/ai-draft`
 *
 * 只负责“协调”，业务规则在 `src/payments/ai.ts`：
 *   管理员会话 + CSRF 由 `admin/router.ts` 统一把关；
 *   这里再做输入大小、每小时限流、审计，然后把**校验过的草稿**原样返回。
 *
 * 不写库、不保存、不发布；审计不记文档正文，也不记模型原文。
 */

import { AI_LIMITS, aiConfig, buildPrompt, completeAiJson, parseAiDraft } from "../payments/ai";

import type { Env } from "../env";

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8" },
  });
}

const fail = (status: number, error: string, message?: string, details?: unknown): Response =>
  json(message ? { error, message, ...(details === undefined ? {} : { details }) } : { error }, status);

async function readBody(request: Request): Promise<Record<string, unknown>> {
  const body = await request.json().catch(() => null);
  return body && typeof body === "object" ? (body as Record<string, unknown>) : {};
}

async function auditDraft(
  env: Env,
  actor: string,
  detail: Record<string, unknown>,
): Promise<void> {
  await env.DB.prepare(
    `INSERT INTO audit_log (at, actor, action, target, detail) VALUES (?, ?, 'gateway_ai_draft', NULL, ?)`,
  )
    .bind(new Date().toISOString(), actor, JSON.stringify(detail))
    .run();
}

/** 已用次数按 audit_log 计：跨 isolate 生效，不额外建表/建内存桶。 */
async function draftsUsedLastHour(env: Env, now: Date): Promise<number> {
  const since = new Date(now.getTime() - 60 * 60 * 1000).toISOString();
  const row = await env.DB.prepare(
    `SELECT COUNT(*) AS n FROM audit_log WHERE action = 'gateway_ai_draft' AND at >= ?`,
  )
    .bind(since)
    .first<{ n: number }>();
  return Number(row?.n ?? 0);
}

export async function handleAdminGatewayAi(
  request: Request,
  env: Env,
  actor: string,
): Promise<Response | null> {
  const path = new URL(request.url).pathname.replace(/^\/api\/admin/, "");
  if (request.method !== "POST" || path !== "/gateways/ai-draft") return null;

  const config = aiConfig(env);
  if (!config) {
    return fail(
      503,
      "ai_unavailable",
      "AI 配置助手未配置：需要同时设置 AI_API_KEY（secret）、AI_MODEL 与 AI_BASE_URL",
    );
  }

  const body = await readBody(request);
  const document = typeof body.document === "string" ? body.document.trim() : "";
  const chars = [...document].length;
  if (chars < AI_LIMITS.minDocChars) {
    return fail(400, "document_too_short", `接口文档至少 ${AI_LIMITS.minDocChars} 字（当前 ${chars} 字）`);
  }
  if (new TextEncoder().encode(document).length > AI_LIMITS.maxDocBytes) {
    return fail(400, "document_too_large", `接口文档不能超过 ${AI_LIMITS.maxDocBytes / 1024} KB`);
  }

  const now = new Date();
  if ((await draftsUsedLastHour(env, now)) >= AI_LIMITS.perHour) {
    return fail(429, "ai_rate_limited", `每小时最多生成 ${AI_LIMITS.perHour} 次，请稍后再试`);
  }

  const completion = await completeAiJson(config, buildPrompt(document));
  if (!completion.ok) {
    // 失败也计数：模型已经被调用过，成本已经发生
    await auditDraft(env, actor, { ok: false, code: completion.code, model: config.model });
    return fail(502, completion.code, completion.message);
  }

  const parsed = parseAiDraft(completion.content);
  await auditDraft(env, actor, {
    ok: parsed.ok,
    model: config.model,
    ...(parsed.ok
      ? { classification: parsed.draft.classification }
      : { errors: parsed.errors.slice(0, 5) }),
  });

  if (!parsed.ok) {
    return fail(422, "invalid_draft", "AI 输出未通过校验，请重试或换一份文档", { errors: parsed.errors });
  }
  return json({ draft: parsed.draft, model: config.model });
}
