/**
 * studio 身份：CRM 是**出示方**（不再是签发方）。
 *
 * 契约：`clever-vpn-docs/docs/contracts/studio-identity.md`（`Contract: 2`，`kind: shared`）。
 *
 * 为什么不再自己签票：CRM 可能是我们托管的 SaaS，也可能是租户自部署的副本 ——
 * 后者的 `APP_SECRET` 我们拿不到，也不该拿。把"这个 CRM 代表哪个租户"交给
 * **cf-api** 判（它签发的租户 `cv_api_…` 是唯一两边都有的凭据），票据由 studio
 * 用**它自己的**密钥签。于是：
 *
 *   CRM 侧：**零新增 secret、零 studio 密钥**，唯一凭据是本来就在 D1 里的
 *           `cf_api.token_enc`（AES-GCM，主密钥 `APP_SECRET`）。
 *   studio 侧：自己的随机签名密钥 + 一把服务间凭据（调 cf-api 用）。
 *
 * 本文件只做三件事：
 *   1. 取租户自己的 `cv_api_…` 明文（`platformCreds`，只在内存里过一遍）；
 *   2. 向 studio 的 `POST /api/studio/session` 出示它，换回一个跳转 URL；
 *   3. `POST /api/studio/ticket`（后台点「打开设计器」时调）把结果原样返回。
 *
 * ⚠️ 票据只以 **URL fragment**（`#t=`）形式出现，由 studio 生成；CRM 不碰 token 本体。
 */

import { issueSiteAccess } from "./access";
import { platformCreds } from "../platform/creds";

import type { Env } from "../env";

/** 允许的受众。加产品 = 加一行 + 配一个 `STUDIO_<X>_URL`。 */
export const STUDIO_AUDIENCES = ["site-studio", "app-studio"] as const;
export type StudioAud = (typeof STUDIO_AUDIENCES)[number];

/** 一次往返最多等多久；超时按"studio 不可达"处理（不透给浏览器技术细节）。 */
export const STUDIO_TIMEOUT_MS = 10_000;

const isAud = (value: unknown): value is StudioAud =>
  typeof value === "string" && (STUDIO_AUDIENCES as readonly string[]).includes(value);

/** 每侧 studio 的对外地址（`STUDIO_SITE_URL` / `STUDIO_APP_URL`），去尾斜杠。 */
export function studioOriginOf(env: Env, aud: StudioAud): string {
  const name = aud === "site-studio" ? "STUDIO_SITE_URL" : "STUDIO_APP_URL";
  return String((env as unknown as Record<string, unknown>)[name] ?? "")
    .trim()
    .replace(/\/+$/, "");
}

export type EntryResult =
  | { ok: true; url: string; expiresAt: string | null; tenant: string | null }
  | { ok: false; status: number; code: string; message: string };

/**
 * 向 studio 换一个跳转 URL。
 *
 * `origin` 只来自**服务端配置**，不接受调用方传入 —— 否则就是开放重定向。
 * `tenantToken` 只在这一跳出现：不落库、不打日志、不回显。
 */
export async function requestStudioEntry(
  env: Env,
  input: {
    aud: StudioAud;
    /** 本次请求的 origin —— 会话里要用它回电 CRM 的 `/api/site/*` */
    crm: string;
    tenantToken: string;
    /**
     * studio 回来调 `/api/site/*` 用的凭据（`site-access`）。
     *
     * 只给 `site-studio`：app-studio 没有站点，给它一枚也用不上 —— 少发一枚就少
     * 一处可能被记进日志的东西。
     */
    siteToken?: string;
    fetchImpl?: typeof fetch;
  },
): Promise<EntryResult> {
  const origin = studioOriginOf(env, input.aud);
  if (!origin) {
    return {
      ok: false,
      status: 500,
      code: "studio_not_configured",
      message: `缺少 ${input.aud === "site-studio" ? "STUDIO_SITE_URL" : "STUDIO_APP_URL"}，不知道往哪跳`,
    };
  }
  const token = String(input.tenantToken ?? "").trim();
  if (!token) {
    return {
      ok: false,
      status: 409,
      code: "studio_tenant_token_missing",
      message: "本租户还没有 cf-api 凭据，请先在 cf-api 签发一把 API token",
    };
  }

  const doFetch = input.fetchImpl ?? fetch;
  let response: Response;
  try {
    response = await doFetch(`${origin}/api/studio/session`, {
      method: "POST",
      headers: {
        // 租户自己的 API token：studio 拿它去 cf-api 换租户身份
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
        accept: "application/json",
      },
      body: JSON.stringify({
        aud: input.aud,
        crm: input.crm.replace(/\/+$/, ""),
        ...(input.siteToken ? { site_token: input.siteToken } : {}),
      }),
      signal: AbortSignal.timeout(STUDIO_TIMEOUT_MS),
    });
  } catch {
    return {
      ok: false,
      status: 502,
      code: "studio_unreachable",
      message: "studio 不可达（网络/超时），请稍后重试",
    };
  }

  let body: { url?: unknown; expires_at?: unknown; tenant?: unknown; error?: unknown };
  try {
    body = (await response.json()) as typeof body;
  } catch {
    return {
      ok: false,
      status: 502,
      code: "studio_unreachable",
      message: "studio 返回了无法解析的响应",
    };
  }

  if (!response.ok) {
    const code = String(body?.error ?? "studio_unreachable");
    return {
      ok: false,
      // studio 的状态码是给运维看的；对浏览器只分成"凭据不行 / 未开通 / 暂时不可用"三类
      status: response.status === 403 ? 403 : response.status === 401 ? 409 : 502,
      code,
      message:
        code === "studio_tenant_denied"
          ? "本租户未开通该设计器"
          : code === "studio_tenant_token_invalid"
            ? "cf-api 不认这把租户 API token（可能已被删除），请先在 cf-api 重新签发"
            : "studio 暂时不可用，请稍后重试",
    };
  }

  const url = String(body?.url ?? "");
  if (!url.startsWith(`${origin}/#t=tkt_`)) {
    return {
      ok: false,
      status: 502,
      code: "studio_unreachable",
      message: "studio 返回的跳转地址不合法",
    };
  }

  return {
    ok: true,
    url,
    expiresAt: body?.expires_at ? String(body.expires_at) : null,
    tenant: body?.tenant ? String(body.tenant) : null,
  };
}

/**
 * `POST /api/studio/ticket` —— CRM 后台「网站 / 应用」页点开设计器时调用。
 *
 * 鉴权沿用后台那套：管理员 Cookie 会话 + `x-crm-request: 1`（同源 fetch 才会带的
 * 自定义头）。唯一入参是 `aud`；`tenant` 来自本次请求解析出的租户，**不接受客户端传入**。
 */
export async function handleStudioTicket(
  request: Request,
  env: Env,
  tenantId: string,
  session: { user_id: number } | null,
  csrfOk: boolean,
): Promise<Response> {
  const json = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), {
      status,
      headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
    });

  if (!csrfOk) return json({ error: "csrf_rejected" }, 403);
  if (!session) return json({ error: "unauthorized" }, 401);

  let aud: unknown;
  try {
    aud = ((await request.json()) as { aud?: unknown })?.aud;
  } catch {
    return json(
      { error: "studio_aud_unknown", message: 'body 必须是 JSON：{"aud":"site-studio"}' },
      400,
    );
  }
  if (!isAud(aud)) return json({ error: "studio_aud_unknown" }, 400);

  // 租户自己的 cf-api 凭据：本流程**唯一**的凭据，只在内存里过一遍
  const creds = await platformCreds(env);
  if (!creds.token) {
    return json(
      {
        error: "studio_tenant_token_missing",
        message:
          creds.problem === "undecryptable"
            ? "cf-api 凭据解不开（APP_SECRET 可能已轮换），请到「平台」页重新保存"
            : "本租户还没有 cf-api 凭据，请先在 cf-api 签发一把 API token",
      },
      409,
    );
  }

  // 站点侧还要一枚"只能做 /api/site/*"的凭据：studio 拿它读设置、交模板、点发布，
  // 而不必持有租户的全权 API token（见 `site/access.ts`）
  const siteToken = aud === "site-studio" ? await issueSiteAccess(env, tenantId) : null;

  const result = await requestStudioEntry(env, {
    aud,
    crm: new URL(request.url).origin,
    tenantToken: creds.token,
    ...(siteToken ? { siteToken } : {}),
  });
  if (!result.ok) return json({ error: result.code, message: result.message }, result.status);

  // 只把 URL 交给前端；`tenant` 以本次请求解析出的为准（studio 那边是同一个值，
  // 回显是为了让前端能断言"没串租户"）。
  return json({ url: result.url, expires_at: result.expiresAt, aud, tenant: tenantId });
}
