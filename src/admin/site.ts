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
import { latestRelease, publishSite, reprintSite, rollbackSite, siteState } from "../site/publish";
import { buildScope, readSiteSettings, saveSiteSettings } from "../site/settings";

import type { Env } from "../env";

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8" },
  });
}

const fail = (status: number, error: string, message?: string) =>
  json(message ? { error, message } : { error }, status);

/**
 * 站点调 CRM 的地址：`SITE_API_BASE` 配了就用它，否则就是这次请求的 origin。
 *
 * 它会被写进 `/_crm/config.js`（产物的一部分），所以必须是**租户站点能访问到**的
 * 地址，不能拿 studio 的 origin 冒充。
 */
function apiBaseOf(env: Env, request: Request): string {
  return (env.SITE_API_BASE ?? "").trim() || new URL(request.url).origin;
}

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
    const settings = await readSiteSettings(env);
    // `scope` = 现在**真正生效**的值（颜色留空时它是跟随主题的那一套）。表单用它
    // 回填"没存过但看得见"的项，见 `web/src/site-fields.ts` 的 effectiveInitialValues。
    return json({ settings, scope: buildScope(settings, "我的站点") });
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
      /**
       * **保存设置 = 自动重烘焙**（契约 §0.1 / D3）：设计版本不变，只换线上产物。
       * 失败也要如实回："设置存了，但线上没换" —— 悄悄成功比失败更糟。
       */
      const baked = await reprintSite(env, tenantId, {
        apiBase: apiBaseOf(env, request),
      });
      return json({
        ok: true,
        ...result.settings,
        // 从没发布过 ⇒ 没有线上设计可烘：不报错，也没有 live
        live:
          baked.ok && baked.baked
            ? { artifactSha: baked.artifactSha, bakedAt: baked.bakedAt, settingsRev: baked.settingsRev }
            : null,
        ...(baked.ok
          ? { unused_settings: baked.unusedSettings }
          : { bake_error: { code: baked.code, message: baked.message, issues: baked.issues ?? [] } }),
      });
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

    /**
     * 回滚 = **设计回滚、身份不回滚**：把 `template_seq` 指回第 n 版，然后用
     * **当前设置**重新烘焙一次 —— 所以线上品牌名/配色仍是现在这套，只有页面
     * 结构退回旧版。**不产生新版本**（`site_releases` 不增行），只写指针审计。
     */
    const result = await rollbackSite(env, tenantId, n, {
      apiBase: apiBaseOf(env, request),
      actor,
    });
    if (!result.ok) {
      const status = result.code === "unknown_version" ? 404 : 422;
      return json({ error: result.code, message: result.message, ...(result.issues ? { issues: result.issues } : {}) }, status);
    }
    return json({ ok: true, active: n, live: result.artifactSha, bakedAt: result.bakedAt });
  }

  return null;
}
