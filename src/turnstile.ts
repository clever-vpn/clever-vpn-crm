/**
 * Cloudflare Turnstile（人机校验）
 *
 * 设计原则：**没配就是没开**。
 * - `TURNSTILE_SECRET` 未设置 ⇒ `verifyTurnstile()` 直接返回 `skip`，
 *   所有调用点一律放行（本地开发、自托管不想开都不受影响）。
 * - `TURNSTILE_SITE_KEY` 通过 `/api/admin/bootstrap` 下发给前端；没下发就不渲染
 *   挂件（前端也不用依赖 `TURNSTILE_SECRET` 是否配置）。
 *
 * 只保护**公开且会花钱/能枚举**的入口：初始化、登录、发验证码。
 * 已登录后的接口不校验（有会话 + 同源 CSRF 头，再加一层没意义）。
 */
import type { Env } from "./env";

const SITEVERIFY = "https://challenges.cloudflare.com/turnstile/v0/siteverify";
const TIMEOUT_MS = 5000;

export function turnstileEnabled(env: Env): boolean {
  return Boolean(env.TURNSTILE_SECRET);
}

export type TurnstileResult =
  | { ok: true; skipped: boolean }
  | { ok: false; codes: string[] };

/**
 * 校验前端拿到的 Turnstile token。
 *
 * `remoteip` 传真实客户端 IP 会略微降低误判，但 Workers 里只有
 * `CF-Connecting-IP` 可信，且本地开发没有，所以做成可选的。
 */
export async function verifyTurnstile(
  env: Env,
  token: string,
  remoteip?: string,
): Promise<TurnstileResult> {
  if (!env.TURNSTILE_SECRET) return { ok: true, skipped: true };
  if (!token) return { ok: false, codes: ["missing-input-response"] };

  const form = new FormData();
  form.append("secret", env.TURNSTILE_SECRET);
  form.append("response", token);
  if (remoteip) form.append("remoteip", remoteip);

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(SITEVERIFY, {
      method: "POST",
      body: form,
      signal: controller.signal,
    });
    if (!res.ok) return { ok: false, codes: [`http_${res.status}`] };
    const data = (await res.json().catch(() => null)) as
      | { success?: boolean; "error-codes"?: string[] }
      | null;
    if (data?.success) return { ok: true, skipped: false };
    return { ok: false, codes: data?.["error-codes"] ?? ["unknown"] };
  } catch {
    // 超时/网络问题：宁可让用户重试，也不静默放行
    return { ok: false, codes: ["verify_failed"] };
  } finally {
    clearTimeout(timer);
  }
}

/** 从请求里取客户端 IP（仅 Cloudflare 边缘提供，本地开发没有） */
export function clientIp(request: Request): string | undefined {
  return request.headers.get("CF-Connecting-IP") ?? undefined;
}
