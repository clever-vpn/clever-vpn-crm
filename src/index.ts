/**
 * Clever VPN CRM — Worker 入口
 *
 * 三个面，同一个 Worker + 同一个 D1：
 *   /                → 静态资源（管理后台 SPA）
 *   /api/admin/*     → 管理后台 API（Cookie 会话）
 *   /api/app/v1/*    → App 接口（待实现，契约见 app-crm.md）
 */

import { ensureSchema } from "./db";
import type { Env } from "./env";
import { handleAdminApi } from "./admin/router";

export type { Env };

/** 管理后台是 SPA：文件不存在时回落到 /admin/index.html */
const ADMIN_INDEX = "/admin/index.html";

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8" },
  });
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === "/health") {
      return json({ status: "ok" });
    }

    if (url.pathname === "/__version") {
      return json({
        code: env.CRM_CODE_VERSION ?? "dev",
        contract: env.CRM_CONTRACT_VERSION ?? "1",
        tenant: env.CRM_TENANT_ID ?? null,
      });
    }

    if (url.pathname.startsWith("/api/")) {
      await ensureSchema(env.DB);
      if (url.pathname.startsWith("/api/admin")) {
        return handleAdminApi(request, env);
      }
      return json(
        {
          error: "not_implemented",
          path: url.pathname,
          hint: "App 接口按 docs/contract.md 实现（登录/套餐/下单/取码）",
        },
        501,
      );
    }

    if (url.pathname === "/") {
      // 官网占位页。assets 的 html_handling 设了 none，所以这里显式取 index.html。
      return env.ASSETS.fetch(
        new Request(new URL("/index.html", url).toString(), request),
      );
    }

    const asset = await env.ASSETS.fetch(request);
    if (asset.status !== 404) return asset;
    if (url.pathname.startsWith("/admin")) {
      return env.ASSETS.fetch(new Request(new URL(ADMIN_INDEX, url).toString(), request));
    }
    return asset;
  },
} satisfies ExportedHandler<Env>;
