/**
 * Clever VPN CRM — Worker 入口
 *
 * 只做两件事，同一个 Worker + 同一个 D1：
 *   /*               → 管理后台 SPA（assets）。CRM 是独立域名，**入口就是 `/`**，
 *                      不该让人记 `/admin`（`/admin/*` 只留 302 兼容书签）。
 *   /api/admin/*     → 管理后台 API（Cookie 会话）
 *   /api/app/v1/*    → App / 静态站共用的接口（Bearer 或 Cookie）
 *
 * **官网不在这个 Worker 里**。静态站（首页 / 定价 / 我的 …）完全独立部署，
 * 可以是任何域名，通过 `Authorization: Bearer <session_token>` 调 `/api/app/v1/*`。
 * 样例见 `site-template/`。这样做的好处：官网和后台不同源，租户（或 AI）改官网
 * 的脚本伤不到后台；CRM 也不必关心第三方 Cookie 政策。
 */

import { ensureSchema } from "./db";
import { isSpaDeepLink, panelRoute } from "./panel-route";
import type { Env } from "./env";
import { handleAppApi } from "./app/router";
import { handleAdminApi, readAdminSession } from "./admin/router";
import { handlePayRoutes } from "./payments/routes";
import { verifySiteAccess } from "./site/access";
import { siteMeta } from "./site/meta";
import { buildScope, readSiteSettings, saveSiteSettings } from "./site/settings";
import { siteTemplateOf } from "./site/template-source";
import { deliverSite, type DeliveryInput } from "./site/deliver";
import { sampleDataOf } from "./site/sample";
import { publishSite } from "./site/publish";
import { readTemplateVersion } from "./site/templates";
import { handleStudioTicket } from "./site/studio-ticket";
import { retryProvisioning } from "./platform/provision";
import { runSettlement } from "./subscriptions/store";
import { handleUnsubscribe } from "./notices/unsubscribe";
import { sendPendingNotices } from "./notices/store";
import { pollPendingOrders } from "./payments/poll";
import { getNumberSetting, setSetting } from "./settings";
import { TenantResolveError, ensureConfig, modeOf, scopeToTenant } from "./tenant/scope";
import type { Scoped } from "./tenant/scope";

/** 每小时重活的门：距上次执行 ≥55 分钟就允许跑（漏了下一 tick 自动补，不用等整点） */
const HOURLY_EVERY_MS = 55 * 60 * 1000;
const LAST_HOURLY_RUN = "last_hourly_run";

async function dueForHourly(env: Env, now: Date): Promise<boolean> {
  const last = await getNumberSetting(env, LAST_HOURLY_RUN);
  // 首次部署没有这一行 ⇒ 立刻跑一次（否则要空等 55 分钟）
  if (last === null) return true;
  return now.getTime() - last >= HOURLY_EVERY_MS;
}

async function markHourlyRun(env: Env, now: Date): Promise<void> {
  await setSetting(env, LAST_HOURLY_RUN, String(now.getTime()), now);
}

export type { Env };

/** 管理后台是 SPA：构建产物落在 `admin/` 前缀下，**入口是 `/`** */
const ADMIN_INDEX = "/admin/index.html";


function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8" },
  });
}

export default {
  async fetch(request: Request, rawEnv: Env): Promise<Response> {
    // 每个 isolate 首次请求做一次配置自检：绑定漏了要在这里喊，不要等到某个租户
    // 第一次请求才暴露成"离奇的 500"。结果同时挂在 /__version 上供部署后核对。
    const config = ensureConfig(rawEnv as unknown as Record<string, unknown>);

    const url = new URL(request.url);
    if (url.pathname === "/health") {
      return json({ status: "ok" });
    }

    /**
     * 取库：single（默认）原样用 `env.DB`；multi 走 `host → KV → slot`。
     * 业务代码只看到 `env.DB`，不判别模式（见 src/tenant/scope.ts）。
     * 解析失败**绝不回落默认租户** —— 未知域名就是 404。
     */
    let scoped: Scoped;
    try {
      scoped = await scopeToTenant(request, rawEnv as never);
    } catch (error) {
      if (error instanceof TenantResolveError) {
        if (error.code === "suspended") {
          // 410 而不是 404：域名解析得到、只是这个租户被停用，说清楚好排障
          return new Response("站点已暂停", { status: 410 });
        }
        return json(
          { error: error.code, message: error.message },
          error.code === "unknown_host" ? 404 : 500,
        );
      }
      throw error;
    }
    const env = scoped.env as unknown as Env;

    if (url.pathname === "/__version") {
      return json({
        code: env.CRM_CODE_VERSION ?? "dev",
        contract: env.CRM_CONTRACT_VERSION ?? "1",
        mode: modeOf(rawEnv),
        tenant: scoped.tenantId || null,
        config: { ok: config.ok, problems: config.problems, dbs: config.dbs },
      });
    }

    // 退订（邮件里点过来的链接）——不走 App CORS/会话，也不需要登录
    if (url.pathname === "/unsubscribe") {
      await ensureSchema(env.DB);
      return handleUnsubscribe(request, env);
    }

    // 支付回调（服务商过来）与 mock 演示页（浏览器直接打开）——不走 App CORS/会话
    if (url.pathname.startsWith("/api/pay/") || url.pathname.startsWith("/pay/")) {
      await ensureSchema(env.DB);
      const payResponse = await handlePayRoutes(request, env);
      if (payResponse) return payResponse;
    }

    /**
     * 平台的数据契约：字段清单 + 契约版本 + 渲染引擎版本。
     *
     * 放在 `/api/` 那一串前面，是因为它**不读库也不要鉴权** —— 它是平台能力的广告，
     * 不含任何租户数据（`src/site/meta.ts` 头部解释了为什么不含套餐/订单）。
     */
    if (url.pathname === "/api/site/meta") {
      if (request.method !== "GET") return json({ error: "method_not_allowed" }, 405);
      return json(siteMeta());
    }

    if (url.pathname.startsWith("/api/")) {
      await ensureSchema(env.DB);
      // studio 身份：管理员 Cookie 鉴权 → 一次性票据 → `#t=` 跳转
      // （契约 `contracts/studio-identity.md`；site / app 两个 studio 共用这一个端点）
      if (url.pathname === "/api/studio/ticket") {
        if (request.method !== "POST") return json({ error: "method_not_allowed" }, 405);
        return handleStudioTicket(
          request,
          env,
          scoped.tenantId,
          await readAdminSession(env, request),
          request.headers.get("x-crm-request") === "1",
        );
      }
      /**
       * studio 用：读**这个租户的**站点设置 + 渲染作用域（预览直接用它）。
       *
       * 凭据是入场时 CRM 签的 `sacc_…`（只做 `/api/site/*`，14 天，见
       * `site/access.ts`）—— 不是租户的全权 API token。
       */
      if (url.pathname === "/api/site/settings") {
        const access = await verifySiteAccess(request, env, scoped.tenantId);
        if (!access) return json({ error: "site_access_invalid" }, 401);

        if (request.method === "GET") {
          const settings = await readSiteSettings(env);
          return json(
            {
              rev: settings.rev,
              values: settings.values,
              collections: settings.collections,
              // 与发布时**同一套** buildScope：预览与线上不会因为"两处拼数据"而漂移
              scope: buildScope(settings, "我的站点"),
            },
            );
        }

        /**
         * 设计器里改设置（契约 §4.6）：**真源在这里**，studio 只是一张表单。
         *
         * `if_rev` 必带：设计器与后台同时改时，那正是最容易丢改动的地方；冲突回
         * 409，让前端去说"CRM 里刚改过"，而不是让后写的人静默覆盖先写的人。
         */
        if (request.method === "PUT") {
          let body: { if_rev?: unknown; values?: unknown; collections?: unknown } = {};
          try {
            body = (await request.json()) as typeof body;
          } catch {
            return json({ error: "invalid_body", message: "body 必须是 JSON" }, 400);
          }
          if (typeof body.if_rev !== "number") {
            return json(
              { error: "rev_required", message: "必须带 if_rev（乐观锁），否则并写时谁也不知道被谁覆盖了" },
              400,
            );
          }
          const result = await saveSiteSettings(env, {
            ifRev: body.if_rev,
            values: body.values,
            collections: body.collections,
          });
          if (!result.ok) {
            // 冲突是 409（前端据此提示刷新），其余是 400（指出哪个字段不对）
            return json(
              { error: result.code, message: result.message },
              result.code === "rev_conflict" ? 409 : 400,
            );
          }
          const saved = result.settings;
          return json({
            ok: true,
            rev: saved.rev,
            values: saved.values,
            collections: saved.collections,
            scope: buildScope(saved, "我的站点"),
          });
        }

        return json({ error: "method_not_allowed" }, 405);
      }

      /**
       * studio 用：拉当前模板（租户有则租户的，否则公共模板）。
       *
       * 与设置同一条凭据；`sha` 用交付时**同一个算法**算 —— 对齐只看 sha
       * （契约 §7.3），版本号不是内容。
       */
      if (url.pathname === "/api/site/template") {
        if (request.method !== "GET") return json({ error: "method_not_allowed" }, 405);
        const access = await verifySiteAccess(request, env, scoped.tenantId);
        if (!access) return json({ error: "site_access_invalid" }, 401);
        const tpl = await siteTemplateOf(env, scoped.tenantId);
        if (!tpl) return json({ error: "site_template_missing" }, 404);
        return json(tpl);
      }

      /**
       * 运行期数据的**预览样例**（契约 §4.4）：形状与 `sdk.ts` 的 `planView()` 一致，
       * 恒带 `sample: true`。模板开发时靠它看到"有数据时长什么样"，而不是把假价格
       * 写进 HTML（写进去就没人拦得住了）。
       */
      if (url.pathname === "/api/site/sample-data") {
        if (request.method !== "GET") return json({ error: "method_not_allowed" }, 405);
        const access = await verifySiteAccess(request, env, scoped.tenantId);
        if (!access) return json({ error: "site_access_invalid" }, 401);
        return json(sampleDataOf());
      }

      /**
       * 交付一版模板（契约 §5）：**校验 → 存成不可变的租户模板版本**。
       *
       * 六道门（形状 / 引擎 / 契约 / 摘要 / 渲染 / 预览 sha）都在 `deliver.ts` 里；
       * 这里只做鉴权与路由。交付 ≠ 上线，上线要再调 `/publish`。
       */
      if (url.pathname === "/api/site/deliveries") {
        if (request.method !== "POST") return json({ error: "method_not_allowed" }, 405);
        const access = await verifySiteAccess(request, env, scoped.tenantId);
        if (!access) return json({ error: "site_access_invalid" }, 401);
        let body: unknown;
        try {
          body = await request.json();
        } catch {
          return json({ error: "site_manifest_invalid", message: "请求体不是 JSON" }, 400);
        }
        const result = await deliverSite(env, scoped.tenantId, body as DeliveryInput);
        if (!result.ok) {
          return json(
            { error: result.code, message: result.message, ...(result.issues ? { issues: result.issues } : {}) },
            result.status,
          );
        }
        return json({
          template_version: result.template_version,
          sha: result.sha,
          engine: result.engine,
          idempotent: result.idempotent,
        });
      }

      /**
       * 发布（契约 §6.4）：**只有这一份实现**。studio 只能"发起"，渲染、写产物、切指针
       * 全在这里；它没有云凭据，也不该有。
       *
       * `apiBase` 用**本请求的 origin**：站点与 CRM 不同域，发上去之后没人能改它。
       */
      if (url.pathname === "/api/site/publish") {
        if (request.method !== "POST") return json({ error: "method_not_allowed" }, 405);
        const access = await verifySiteAccess(request, env, scoped.tenantId);
        if (!access) return json({ error: "site_access_invalid" }, 401);
        let body: { template_version?: unknown } = {};
        try {
          body = (await request.json()) as { template_version?: unknown };
        } catch {
          body = {};
        }
        const wanted = String(body.template_version ?? "").trim();
        const version = await readTemplateVersion(env, scoped.tenantId, wanted || undefined);
        if (!version) return json({ error: "site_template_missing", message: "还没有交付过模板" }, 404);
        const published = await publishSite(env, scoped.tenantId, {
          templateSha: version.sha,
          template: "tenant",
          templateVersion: version.version,
          actor: "studio",
          apiBase: url.origin,
        });
        if (!published.ok) {
          return json(
            { error: published.code, message: published.message, ...(published.issues ? { issues: published.issues } : {}) },
            published.code === "version_conflict" ? 409 : 422,
          );
        }
        return json({
          version_id: published.version,
          template_version: version.version,
          template_sha: version.sha,
          files: published.files,
          bytes: published.bytes,
        });
      }

      if (url.pathname.startsWith("/api/admin")) {
        return handleAdminApi(request, env, scoped.tenantId);
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

    /**
     * 面板入口 = `/`：CRM 部署在自己的域名/面板域名上，没有理由让人记一层
     * `/admin`。构建产物仍落在 `admin/` 前缀下（`ADMIN_INDEX`），这只影响
     * 静态文件地址，不影响入口。
     *
     * 例外：自托管把官网配到别处（`SITE_URL`）时根路径归官网跳转，面板继续
     * 留在 `/admin/` —— 否则两边的入口会互相抢 `/`。
     */
    const route = panelRoute(url.pathname, env.SITE_URL);
    if (route.kind === "site") return Response.redirect(route.to, 302);
    if (route.kind === "redirect") {
      // 302 而不是 301：这条规则以后还可能再变，不该被浏览器永久记住。
      return Response.redirect(
        new URL(route.to + url.search, url).toString(),
        302,
      );
    }
    if (route.kind === "spa") {
      return env.ASSETS.fetch(
        new Request(new URL(ADMIN_INDEX, url).toString(), request),
      );
    }

    const asset = await env.ASSETS.fetch(request);
    if (asset.status !== 404) return asset;
    // SPA 深链接（`/plans`、`/settings`…）：非文件请求一律给 index.html，前端按
    // pathname 选页。`/api/*` 与 `/pay/*` 在上面已经分流，到不了这里。
    if (isSpaDeepLink(url.pathname)) {
      return env.ASSETS.fetch(
        new Request(new URL(ADMIN_INDEX, url).toString(), request),
      );
    }
    return asset;
  },

  /**
   * 定时任务：**一个时钟，三道门**（`wrangler.jsonc` 里只配了一个 cron）
   *
   * 每 2 分钟一次的 tick 是**泵的心跳**，不是"所有活每 2 分钟干一遍"：
   *
   *   门 B（每小时）—— `last_hourly_run` 距今 ≥55 分钟才跑，**并且独占这一 tick**。
   *       跑的是一次性重活：补落账（provisioning 重试）、周期结算、到期礼包探测。
   *       独占是为了不让它被 25 秒预算切成半截（结算可能扫上千行）。
   *   门 A（其余 tick）—— 有界的小片：
   *       ① 查单：只查"到点该查"的 pending 单（退避曲线，`payments/poll.ts`）；
   *       ② 通知泵：按日配额发 `notices`（用尽自动顺延次日）。
   *
   * 为什么不用"分钟数匹配"判断整点：部署/异常漏掉一次 tick 就要再等一小时；
   * 用**上次执行时间**做门是自愈的（漏了就下一 tick 补）。
   */
  async scheduled(_controller: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> {
    /**
     * 多租户模式下**没有"当前租户"**：cron 打进来时不知道要为哪个库干活。
     * 定时任务在 SaaS 下由 cf-api（或按 slot 逐个调度）负责，这里直接跳过，
     * 绝不对着一片里"某一个随便的库"跑结算（那会写错租户的数据）。
     * 自部署（single）行为完全不变。
     */
    if (modeOf(env as unknown as { MODE?: string }) === "multi") {
      console.warn("[scheduled] MODE=multi 时不在 Worker 内跑定时任务（由平台侧调度）");
      return;
    }
    await ensureSchema(env.DB);
    const now = new Date();

    // ── 门 B：每小时重活（独占这一 tick）──
    if (await dueForHourly(env, now)) {
      await markHourlyRun(env, now);
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
      // 注意：**没有"到期礼包"这一步**了 —— 礼包是拉取模型，
      // `audience='expiring'` 只是"谁能在货架上看到它"的条件，
      // 由 `listGiftShelf` 在用户来取时现算，不需要提前发出去。
      return;
    }

    // ── 门 A：查单（钱的事优先级最高）──
    ctx.waitUntil(
      pollPendingOrders(env)
        .then((report) => {
          if (report.paid || report.expired || report.failed) {
            console.log(
              `[poll] scanned=${report.scanned} paid=${report.paid} expired=${report.expired} failed=${report.failed}`,
            );
          }
          if (report.errors.length) console.warn(`[poll] ${report.errors.join(" | ")}`);
        })
        .catch((e: unknown) => console.error("[poll] 查单失败", e)),
    );

    // 没有"批量发放"这一步：拉取模型下没有任何要提前发出去的行。
    // 通知泵只负责**收据**（用户自己领了之后才可能写行）。

    // ── 门 A：通知泵（按日配额；用尽自动顺延次日）──
    ctx.waitUntil(
      sendPendingNotices(env)
        .then((report) => {
          if (report.sent || report.failed || report.deferred) {
            console.log(
              `[notice] sent=${report.sent} suppressed=${report.suppressed} failed=${report.failed} deferred=${report.deferred} quota_left=${report.quotaLeft}`,
            );
          }
          if (report.errors.length) console.warn(`[notice] errors: ${report.errors.join(" | ")}`);
        })
        .catch((e: unknown) => console.error("[notice] 发送失败", e)),
    );
  },
} satisfies ExportedHandler<Env>;
