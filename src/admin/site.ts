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
import { latestRelease, publishSite, siteState, switchPointer } from "../site/publish";
import { readSiteSettings, saveSiteSettings } from "../site/settings";

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

  // ── 品牌设置：发布时烘焙进产物，改完要重新发布才生效 ──
  if (method === "GET" && path === "/site/settings") {
    return json({ settings: await readSiteSettings(env) });
  }

  if (method === "PUT" && path === "/site/settings") {
    const body = (await readBody(request)) as {
      if_rev?: unknown;
      values?: unknown;
      /** `{ downloads: [...] }`；**不传就不动**（老客户端只改设置时别清空集合） */
      collections?: unknown;
    };
    const result = await saveSiteSettings(env, {
      ifRev: typeof body.if_rev === "number" ? body.if_rev : undefined,
      values: body.values,
      collections: body.collections,
    });
    if (result.ok) {
      return json({ ok: true, ...result.settings });
    }
    // 乐观锁冲突是 409，其余是 400：前端据此决定"提示重试"还是"指出哪个字段"
    return json(
      { error: result.code, message: result.message },
      result.code === "rev_conflict" ? 409 : 400,
    );
  }

  // ── 域名绑定：**只有 multi（SaaS）才有这一步** ──
  //
  // 自部署时，站点域名是租户在自己的 Cloudflare 里给 site-serve 加 Custom Domain，
  // CRM 根本插不上手；SaaS 下域名动作一律走 cf-api（它才持有云凭据，
  // cf-api-hosting.md §1）。所以这里**按模式分流**，并且如实报告"平台侧还没做"。
  if (method === "GET" && path === "/site/domain") {
    const mode = (env.MODE ?? "single").toLowerCase();
    if (mode !== "multi") {
      return json({
        supported: false,
        mode,
        reason:
          "自部署模式下域名由你自己管理：在 Cloudflare 里给 site-serve 加 Custom Domain 即可，CRM 不参与。",
      });
    }
    return json({
      supported: true,
      mode,
      available: false,
      reason:
        "托管模式下域名由平台代为绑定，但 cf-api 的三个端点（申请 / 查询状态 / 解绑）尚未实现。",
    });
  }

  if (method === "POST" && path === "/site/publish") {
    const body = await readBody(request);
    /**
     * **默认发"最近一次发布的那份源包"**（租户在 studio 里发过就用它，从没发过就用
     * 部署自带的种子）。
     *
     * 这条默认值的意义：后台只改了设置（套餐价格、下载入口）时，点一次「发布」就该
     * 用租户自己的页面重渲染，而不是退回种子把租户的改动抹掉。
     */
    const latest = await latestRelease(env, tenantId);
    const result = await publishSite(env, tenantId, {
      // 站点调 CRM 的地址：默认就是管理后台自己的 origin
      apiBase: (env.SITE_API_BASE ?? "").trim() || new URL(request.url).origin,
      sourceSha: latest?.sourceSha,
      trigger: "crm",
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
      `SELECT seq FROM site_releases WHERE tenant_id = ? AND seq = ?`,
    )
      .bind(tenantId, n)
      .first<{ seq: number }>();
    if (!row) return fail(404, "unknown_version", `没有 ${n} 这一版`);

    // 回滚**不产生新版本**，所以"线上变过"这件事只能靠审计表记下来（契约 §0.1.3）
    await switchPointer(env, tenantId, n, "rollback", actor);
    return json({ ok: true, active: n });
  }

  return null;
}
