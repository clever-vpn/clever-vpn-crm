/**
 * 管理后台：站点 `/api/admin/site*`
 *
 * 三件事，各自独立：
 *   `GET  /site`          当前线上版本 + 最近版本 + 模板是否就绪（后台首屏就靠它）
 *   `POST /site/publish`  发布一版（模板实例化 → 写 R2 → 切指针）
 *   `POST /site/rollback` 把指针指回某个已有的 n（不重建、不经过 studio、不计费）
 *
 * **不在这里做的事**：域名绑定（cf-api）、站点编辑（site-studio）、
 * 模板上传（构建期由 `npm run site:template:upload` 做）。
 */
import { publishSite, siteState, activeKey } from "../site/publish";

import type { Env } from "../env";

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8" },
  });
}

const fail = (status: number, error: string, message?: string) =>
  json(message ? { error, message } : { error }, status);

async function readBody(request: Request): Promise<Record<string, unknown>> {
  try {
    const parsed = (await request.json()) as unknown;
    return parsed && typeof parsed === "object"
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

export async function handleAdminSite(
  request: Request,
  env: Env,
  tenantId: string,
  actor: string,
): Promise<Response | null> {
  const url = new URL(request.url);
  const path = url.pathname.slice("/api/admin".length);
  const method = request.method;

  if (method === "GET" && path === "/site") {
    return json(await siteState(env, tenantId));
  }

  if (method === "POST" && path === "/site/publish") {
    const body = await readBody(request);
    const result = await publishSite(env, tenantId, {
      template: typeof body.template === "string" ? body.template : undefined,
      templateVersion:
        typeof body.template_version === "string"
          ? body.template_version
          : undefined,
      actor,
    });
    if (!result.ok) {
      // L0 失败是"内容有问题"，不是服务器错误：400 + 逐条 issues
      const status = result.code === "l0_failed" ? 400 : 409;
      return json(result, status);
    }
    return json(result);
  }

  if (method === "POST" && path === "/site/rollback") {
    const body = await readBody(request);
    const n = Number(body.version ?? 0) || 0;
    if (n <= 0) return fail(400, "bad_version", "需要 version（正整数）");
    if (!env.HOSTS) return fail(500, "kv_not_configured", "没有绑定 HOSTS（KV）");

    // 只能回滚到**真实存在过**的版本，不能凭空指一个 n
    const row = await env.DB.prepare(
      `SELECT seq FROM site_versions WHERE seq = ?`,
    )
      .bind(n)
      .first<{ seq: number }>();
    if (!row) return fail(404, "unknown_version", `没有 ${n} 这一版`);

    await env.HOSTS.put(activeKey(tenantId), JSON.stringify({ n }));
    return json({ ok: true, active: n });
  }

  return null;
}
