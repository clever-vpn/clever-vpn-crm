/**
 * 管理后台：运行期设置 `/api/admin/settings*`
 *
 * 目前只有**发信配额**。放在后台而不是写死常量，是因为 Cloudflare Email Service 的
 * 日配额按账号不同（示例 5000/天），换账号/升级后不该重新发版。
 *
 * 一个必须显示的语义：我们配的是**自愿遵守的软上限**（`quota × ratio`，
 * 默认 90%），最终上限由 Cloudflare 账号决定 —— 留出来的 10% 是给**验证码**的。
 * App 是无密码登录，验证码是硬依赖；礼包邮件把配额吃干净 = 登录挂掉。
 */
import { noticeSettings, saveNoticeSettings, sentToday, DEFAULT_MAIL_DAILY_QUOTA, DEFAULT_MAIL_SOFT_RATIO } from "../notices/store";
import { mailReady } from "../mail";

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

async function view(env: Env): Promise<Record<string, unknown>> {
  const cfg = await noticeSettings(env);
  const used = await sentToday(env);
  return {
    mail: {
      /** 账号每天能发多少（我们自己声明，缺省 5000） */
      daily_quota: cfg.dailyQuota,
      /** 软上限比例（缺省 0.9）：剩下的留给验证码 */
      soft_ratio: cfg.softRatio,
      /** 今天实际发出去多少 */
      sent_today: used,
      /** 软上限还剩下多少 */
      quota_left: Math.max(0, cfg.softLimit - used),
      /** 发信能力是否就绪（未就绪时 pump 一条都不发，保持 pending 等配好） */
      ready: mailReady(env),
      defaults: {
        daily_quota: DEFAULT_MAIL_DAILY_QUOTA,
        soft_ratio: DEFAULT_MAIL_SOFT_RATIO,
      },
    },
  };
}

/**
 * @returns 命中时返回 Response；未命中返回 `null`（交给 router 继续匹配）
 */
export async function handleAdminSettings(
  request: Request,
  env: Env,
): Promise<Response | null> {
  const url = new URL(request.url);
  const path = url.pathname.replace(/^\/api\/admin/, "");
  const method = request.method;

  if (method === "GET" && path === "/settings") {
    return json(await view(env));
  }

  if ((method === "PUT" || method === "PATCH") && path === "/settings/mail") {
    const body = await readBody(request);
    const num = (v: unknown): number | undefined =>
      typeof v === "number" && Number.isFinite(v) ? v : undefined;

    const dailyQuota = num(body.daily_quota);
    const softRatio = num(body.soft_ratio);

    if (dailyQuota !== undefined && (dailyQuota < 1 || dailyQuota > 1_000_000)) {
      return fail(400, "invalid_settings", "每日配额必须在 1–1,000,000 之间");
    }
    if (softRatio !== undefined && (softRatio < 0.1 || softRatio > 1)) {
      return fail(400, "invalid_settings", "软上限比例必须在 0.1–1 之间");
    }
    if (dailyQuota === undefined && softRatio === undefined) {
      return fail(400, "invalid_settings", "daily_quota / soft_ratio 至少填一个");
    }

    await saveNoticeSettings(env, { dailyQuota, softRatio });
    return json(await view(env));
  }

  return null;
}
