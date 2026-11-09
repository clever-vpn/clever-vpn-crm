/**
 * 管理后台：cf-api 对接 `/api/admin/platform*`
 *
 * 四件事：
 *   `GET  /platform`             当前配置（**不含明文 token**）+ 最后成功/失败时间
 *   `PUT  /platform`             改基址 / 换 token（token 加密落库）
 *   `POST /platform/test`        真发一次只读请求，区分"没配好 / token 不对 / 网络不通"
 *   `POST /platform/provision`   重试卡在 `provisioning` 的订单（不再等每小时 cron）
 *
 * 为什么 `test` 要单独一个按钮：租户看到的报错一律是"支付成功但没开通"，
 * 真正原因却可能是三种完全不同的事。把判断做成一次点击，比让它猜强。
 */
import { PlatformError } from "../platform/client";
import { markPlatformError, markPlatformOk, readPlatformCreds, savePlatformCreds } from "../platform/creds";
import { platformAuth } from "../platform/client";
import { retryProvisioning } from "../platform/provision";

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
    return parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

/** 一次只读探针：`GET /api/v1/customers?pagination[limit]=1`（最小代价验证令牌） */
async function probe(env: Env): Promise<{ ok: boolean; status?: number; message?: string }> {
  try {
    const { base, token } = await platformAuth(env);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 10_000);
    try {
      const res = await fetch(
        `${base}/api/v1/customers?pagination[limit]=1`,
        { headers: { authorization: `Bearer ${token}` }, signal: controller.signal },
      );
      if (res.ok) return { ok: true, status: res.status };
      const text = await res.text();
      let message = text;
      try {
        message = (JSON.parse(text) as { error?: string }).error ?? text;
      } catch {
        /* 网关错误页不是 JSON */
      }
      return { ok: false, status: res.status, message: (message || `HTTP ${res.status}`).slice(0, 300) };
    } finally {
      clearTimeout(timer);
    }
  } catch (e) {
    if (e instanceof PlatformError) {
      return { ok: false, status: e.status || undefined, message: e.message };
    }
    return { ok: false, message: e instanceof Error ? e.message : String(e) };
  }
}

export async function handleAdminPlatform(
  request: Request,
  env: Env,
  actor: string,
): Promise<Response | null> {
  const url = new URL(request.url);
  const path = url.pathname.slice("/api/admin".length);
  const method = request.method;

  if (method === "GET" && path === "/platform") {
    return json(await readPlatformCreds(env));
  }

  if (method === "PUT" && path === "/platform") {
    const body = await readBody(request);
    const result = await savePlatformCreds(env, {
      base_url: body.base_url,
      // 不传 = 不改；传 null = 清空
      token: "token" in body ? body.token : undefined,
    });
    if (!result.ok) return fail(400, result.code ?? "invalid", result.message);
    void actor;
    return json({ ok: true, ...result.view });
  }

  if (method === "POST" && path === "/platform/test") {
    const result = await probe(env);
    if (result.ok) {
      await markPlatformOk(env);
      return json({ ok: true, status: result.status ?? 200 });
    }
    const message = result.message ?? "未知错误";
    await markPlatformError(env, message);
    // 401/403 是 token 问题，其余按网络/平台问题报；前端据此给不同建议
    const status = result.status === 401 || result.status === 403 ? 400 : 502;
    return json({ ok: false, status: result.status ?? 0, message }, status);
  }

  if (method === "POST" && path === "/platform/provision") {
    const result = await retryProvisioning(env, { limit: 50 });
    return json({ ok: true, ...result });
  }

  return null;
}
