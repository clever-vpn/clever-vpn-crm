/**
 * Clever VPN CRM — Worker 入口
 *
 * 只做两件事，同一个 Worker + 同一个 D1：
 *   /admin/*         → 管理后台 SPA（assets）
 *   /api/admin/*     → 管理后台 API（Cookie 会话）
 *   /api/app/v1/*    → App / 静态站共用的接口（Bearer 或 Cookie）
 *
 * **官网不在这个 Worker 里**。静态站（首页 / 定价 / 我的 …）完全独立部署，
 * 可以是任何域名，通过 `Authorization: Bearer <session_token>` 调 `/api/app/v1/*`。
 * 样例见 `site-template/`。这样做的好处：官网和后台不同源，租户（或 AI）改官网
 * 的脚本伤不到后台；CRM 也不必关心第三方 Cookie 政策。
 */

import { ensureSchema } from "./db";
import type { Env } from "./env";
import { handleAppApi } from "./app/router";
import { handleAdminApi } from "./admin/router";
import { handlePayRoutes } from "./payments/routes";
import { retryProvisioning } from "./platform/provision";
import { runSettlement } from "./subscriptions/store";
import { runExpiringGifts } from "./promotions/gift";

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

    // 支付回调（服务商过来）与 mock 演示页（浏览器直接打开）——不走 App CORS/会话
    if (url.pathname.startsWith("/api/pay/") || url.pathname.startsWith("/pay/")) {
      await ensureSchema(env.DB);
      const payResponse = await handlePayRoutes(request, env);
      if (payResponse) return payResponse;
    }

    if (url.pathname.startsWith("/api/")) {
      await ensureSchema(env.DB);
      if (url.pathname.startsWith("/api/admin")) {
        return handleAdminApi(request, env);
      }
      if (url.pathname.startsWith("/api/app/v1")) {
        return handleAppApi(request, env);
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

    if (url.pathname === "/" || url.pathname === "/index.html") {
      // 官网独立部署：配了 SITE_URL 就跳过去；没配就给一句可读的提示。
      const site = (env.SITE_URL ?? "").trim();
      if (site) return Response.redirect(site, 302);
      return new Response(
        `<!doctype html><meta charset="utf-8"><title>CRM 已部署</title>
<div style="font:16px/1.7 system-ui;max-width:560px;margin:15vh auto;padding:0 20px">
  <h1 style="font-size:20px">CRM 已部署</h1>
  <p>管理后台：<a href="/admin/">/admin/</a></p>
  <p style="color:#666">官网是独立部署的静态站。部署好后在 <code>wrangler.jsonc</code>
  里配置 <code>SITE_URL</code>，这里就会自动跳转；样例见仓库的
  <code>site-template/</code>。</p>
</div>`,
        { status: 200, headers: { "Content-Type": "text/html; charset=utf-8" } },
      );
    }

    const asset = await env.ASSETS.fetch(request);
    if (asset.status !== 404) return asset;
    if (url.pathname.startsWith("/admin")) {
      return env.ASSETS.fetch(new Request(new URL(ADMIN_INDEX, url).toString(), request));
    }
    return asset;
  },

  /**
   * 定时任务：周期套餐的额度重置（每小时跑一次，幂等）。
   *
   * 为什么不用平台的 `customers.quota`：平台的月度边界是"记账自然月"，
   * 10 号买的用户拿不到完整 30 天额度；只有按**用户自己的锚点**重置才对得上销售话术。
   * 结算失败时 `last_settled_at` 不动，下一小时自动重试。
   */
  async scheduled(_controller: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> {
    await ensureSchema(env.DB);
    ctx.waitUntil(
      // 先补落账：付款成功但 cf-api 没通时，订单停在 provisioning，用户拿不到码
      retryProvisioning(env)
        .then((report) => {
          if (report.retried || report.failed) {
            console.log(`[provision] retried=${report.retried} failed=${report.failed}`);
          }
        })
        .catch((e: unknown) => console.error("[provision] 重试失败", e)),
    );
    ctx.waitUntil(
      runSettlement(env)
        .then((report) => {
          if (report.settled || report.failed) {
            console.log(
              `[settle] scanned=${report.scanned} settled=${report.settled} failed=${report.failed}`,
            );
          }
          if (report.failed) console.warn(`[settle] errors: ${report.errors.join(" | ")}`);
        })
        .catch((e: unknown) => console.error("[settle] 失败", e)),
    );
    // 到期前挽回：把 `audience='expiring'` 的礼包发给快到期的人（幂等，重复跑不会双发）
    ctx.waitUntil(
      runExpiringGifts(env)
        .then((report) => {
          if (report.granted || report.skipped) {
            console.log(`[gift] expiring granted=${report.granted} skipped=${report.skipped}`);
          }
        })
        .catch((e: unknown) => console.error("[gift] 到期礼包失败", e)),
    );
  },
} satisfies ExportedHandler<Env>;
