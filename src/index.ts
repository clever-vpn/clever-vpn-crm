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
import { siteSourceOf } from "./site/template-source";
import { deliverSite, type DeliveryInput } from "./site/deliver";
import { SAMPLE_PLANS_RAW, sampleDataOf } from "./site/sample";
import { ALLOWED_EXT, latestRelease, publishSite } from "./site/publish";
import {
  TPL_LIMITS,
  checkSourcePath,
  contentTypeOfPath,
  storeSource,
} from "./site/source";
import { checkUploadId, stagingKey, stagingPrefix } from "./site/deliver";
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
        const tpl = await siteSourceOf(env, scoped.tenantId);
        if (!tpl) return json({ error: "site_source_missing", message: "源包读取失败" }, 404);
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
       * 预览宿主用的**接口同形样例**（契约 `site-crm.md` §3.1 `contract: 6`）。
       *
       * studio 预览跑的是**真 SDK**（`/_crm/sdk.js` 与线上同一份），所以它需要
       * `/api/app/v1/plans` 的**原始**返回，而不是 `sample-data` 那份视图模型 ——
       * SDK 会自己再映射一遍。预览把这里当上游，于是"预览看到的价格卡"就是"线上
       * 拿到同样数据渲染的价格卡"，中间没有第二套实现。
       */
      if (url.pathname.startsWith("/api/site/sample-api/")) {
        if (request.method !== "GET") return json({ error: "method_not_allowed" }, 405);
        const access = await verifySiteAccess(request, env, scoped.tenantId);
        if (!access) return json({ error: "site_access_invalid" }, 401);
        const kind = url.pathname.slice("/api/site/sample-api/".length);
        const sample = sampleDataOf();
        if (kind === "plans") return json(SAMPLE_PLANS_RAW);
        if (kind === "me") return json(sample.me);
        if (kind === "orders") return json({ items: sample.orders });
        return json({ error: "unknown_sample", message: "样例只有 plans / me / orders" }, 404);
      }

      /**
       * 交付已经并入发布（Contract 14，契约 §0.1.5）：这里是显式的墓碑，
       * 让还在调老端点的脚本立刻看到原因，而不是静默 404。
       */
      if (url.pathname === "/api/site/deliveries") {
        return json(
          {
            error: "site_deliveries_gone",
            message: "交付已并入 POST /api/site/publish：把源文件直接交给它，一次完成",
          },
          410,
        );
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
        let body: Record<string, unknown> = {};
        try {
          body = (await request.json()) as Record<string, unknown>;
        } catch {
          body = {};
        }

        const apiBase = url.origin;
        const trigger = body.trigger === "crm" ? "crm" : "studio";
        const files = Array.isArray(body.files) ? body.files : null;

        /**
         * 两条路：
         *  - 带了 `files` = studio 交源文件（**唯一一次跨服务写**，先入库再发布）；
         *  - 没带 = 只改数据后重发（用最近一次发布的那份源包，或种子）。
         */
        let sourceSha = typeof body.source_sha === "string" ? body.source_sha : undefined;
        if (files) {
          const manifest = (body.manifest ?? {}) as Record<string, unknown>;
          const ingested = await deliverSite(env, scoped.tenantId, {
            uploadId: typeof body.upload === "string" ? body.upload : undefined,
            manifest: {
              ...manifest,
              // 源文件直接交上来时，manifest 只剩"引擎 / 契约 / 签收 / 预览指纹"四件事
              package: 1,
            } as DeliveryInput["manifest"],
            files: files as DeliveryInput["files"],
          });
          if (!ingested.ok) {
            return json(
              { error: ingested.code, message: ingested.message, ...(ingested.issues ? { issues: ingested.issues } : {}) },
              ingested.status,
            );
          }
          sourceSha = ingested.sha;
        } else if (!sourceSha) {
          const latest = await latestRelease(env, scoped.tenantId);
          sourceSha = latest?.sourceSha;
        }

        const published = await publishSite(env, scoped.tenantId, {
          sourceSha,
          trigger,
          actor: trigger === "crm" ? "crm" : "studio",
          idemKey: typeof body.idem_key === "string" ? body.idem_key : undefined,
          apiBase,
        });
        if (!published.ok) {
          const status =
            published.code === "version_conflict"
              ? 409
              : published.code === "source_missing"
                ? 404
                : 422;
          return json(
            { error: published.code, message: published.message, ...(published.issues ? { issues: published.issues } : {}) },
            status,
          );
        }
        // 暂存区用完就清：一批字节只服务一次发布，留着只是让桶变脏。
        // 失败（比如发布被 422 拒）不清 —— 租户改完再发一次还能复用，生命周期规则兜底。
        const upload = typeof body.upload === "string" ? body.upload : "";
        if (upload && !checkUploadId(upload) && env.SITES) {
          const prefix = stagingPrefix(scoped.tenantId, upload);
          const staged = await env.SITES.list({ prefix, limit: 1000 });
          await Promise.all(staged.objects.map((o) => env.SITES!.delete(o.key)));
        }
        return json({
          seq: published.version,
          /**
           * **站点对外地址**（契约 §6.4）：studio 拿它给租户一个「点开看线上」的链接。
           *
           * 来源只能是 `SITE_URL`（部署配置：自部署时就是给 site-serve 绑的那个域名）。
           * 没配就回 `null` —— **绝不拿 CRM 自己的 origin 冒充**：那个地址打开的是后台，
           * 不是租户的网站，做成链接就是把租户导到错的地方。
           */
          public_url: (env.SITE_URL ?? "").trim().replace(/\/+$/, "") || null,
          source_sha: published.sourceSha,
          artifact_sha: published.artifactSha,
          seed_sha: published.seedSha,
          files: published.files,
          bytes: published.bytes,
          idempotent: published.idempotent,
        });
      }

      /**
       * 发布暂存区：`PUT /api/site/staging?upload=<批次>&path=<路径>`，body 就是字节。
       *
       * 图片是**流**，不是 base64 字符串。逐张 PUT 上来，`POST /api/site/publish`
       * 里只用 `{ path, staged: true }` 指一下 —— 一个 32 MB 的站点包不必整个塞进
       * 一个 JSON 里，失败也只重传那一张。
       *
       * 2026-11-13 之前这里是一整套"素材实体"（`/api/site/assets`，带 id、软删除、
       * 配额张数、指针存活校验）。那套东西带来的全是边角问题：悬空指针、在用不许删、
       * 重置要还原。现在图片就是文件：路径 + 字节，跟 `site.css` 一样。
       */
      if (url.pathname === "/api/site/staging") {
        if (request.method !== "PUT" && request.method !== "DELETE") {
          return json({ error: "method_not_allowed" }, 405);
        }
        const access = await verifySiteAccess(request, env, scoped.tenantId);
        if (!access) return json({ error: "site_access_invalid" }, 401);

        const uploadId = url.searchParams.get("upload") ?? "";
        const badUpload = checkUploadId(uploadId);
        if (badUpload) return json({ error: "site_upload_invalid", message: badUpload }, 400);

        const path = url.searchParams.get("path") ?? "";
        const badPath = checkSourcePath(path);
        if (badPath) return json({ error: "site_path_rejected", message: badPath }, 400);
        const ext = path.slice(path.lastIndexOf(".") + 1).toLowerCase();
        if (!ALLOWED_EXT.has(ext)) {
          return json({ error: "site_path_rejected", message: `不允许的文件类型：${path}` }, 400);
        }

        const key = stagingKey(scoped.tenantId, uploadId, path);
        if (request.method === "DELETE") {
          await env.SITES?.delete(key);
          return json({ ok: true });
        }

        const declared = Number(request.headers.get("content-length") ?? 0);
        if (declared > TPL_LIMITS.fileBytes) {
          return json(
            { error: "site_bundle_too_large", message: `${path} 超过单文件上限 ${TPL_LIMITS.fileBytes} 字节` },
            413,
          );
        }
        if (!request.body) return json({ error: "site_staged_empty" }, 400);
        const obj = await env.SITES?.put(key, request.body, {
          httpMetadata: { contentType: contentTypeOfPath(path) },
        });
        if (!obj) return json({ error: "r2_not_configured" }, 503);
        return json({ ok: true, path, bytes: obj.size }, 201);
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
