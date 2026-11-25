/**
 * 管理后台：AI 配置助手 `POST /api/admin/gateways/ai-draft`
 *
 * 只负责“协调”，业务规则在 `src/payments/ai.ts`：
 *   管理员会话 + CSRF 由 `admin/router.ts` 统一把关；
 *   这里再做输入大小、每小时限流、审计，然后把**校验过的草稿**原样返回。
 *
 * 模型调用在 `src/payments/ai.ts`：AI binding → AI Gateway（默认 `studio`），厂商 key 在网关
 * BYOK；请求带 `metadata.tenant`（cf-api 计费键）与 `metadata.product=crm`。
 *
 * 不写库、不保存、不发布；审计不记文档正文，也不记模型原文。
 */

import { AI_LIMITS, aiRuntime, generateAiDraft } from "../payments/ai";
import { evaluateAiDraft } from "../payments/ai-gate";

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
  tenantId: string,
): Promise<Response | null> {
  const path = new URL(request.url).pathname.replace(/^\/api\/admin/, "");
  if (request.method !== "POST" || path !== "/gateways/ai-draft") return null;

  const runtime = aiRuntime(env, tenantId);
  if (!runtime) {
    return fail(
      503,
      "ai_unavailable",
      "AI 配置助手未启用：需要 AI binding、CLOUDFLARE_GATEWAY_ID（AI Gateway），且 CRM_TENANT_ID 是数字租户 ID",
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

  // 调用 → 校验 → 失败把 errors 回灌重写（最多 AI_LIMITS.maxAttempts 次）
  const generation = await generateAiDraft(runtime, document);
  if (!generation.ok) {
    await auditDraft(env, actor, {
      ok: false,
      model: runtime.model,
      attempts: generation.attempts,
      code: generation.code,
      errors: generation.errors.slice(0, 5),
    });
    // 模型已被调用过，成本已经发生；失败也计数（限流按请求，不按 attempt）
    if (generation.code === "invalid_draft") {
      return fail(422, "invalid_draft", "AI 输出未通过校验，请重试或换一份文档", {
        errors: generation.errors,
        attempts: generation.attempts,
      });
    }
    return fail(502, generation.code, generation.message);
  }

  // 规则闸门：AI 只给 evidence/uncertainty，是否「有依据」由这里裁决
  const gate = evaluateAiDraft(document, generation.draft);
  await auditDraft(env, actor, {
    ok: true,
    model: runtime.model,
    attempts: generation.attempts,
    classification: generation.draft.classification,
    gate: gate.status,
    warnings: gate.warnings.length,
  });
  return json({
    draft: generation.draft,
    model: runtime.model,
    attempts: generation.attempts,
    gate,
  });
}
