/**
 * 邮件发送 —— CRM 的**硬依赖**
 *
 * App 端是无密码登录（只有邮箱验证码），所以"能发邮件"不是可选功能：
 * **CRM 要能被用户使用，就必须配好发信。** 管理后台只是多了一条简历：
 * 邮件没配好时，后台仍可用密码登录（那是运维兜底，见 `docs/admin.md`）。
 *
 * 支持两种传输，二选一，配置即生效（不需要开关）：
 *   - Cloudflare Email Service：`EMAIL` 绑定（`wrangler.jsonc` 的 `send_email`）
 *   - Resend：`RESEND_API_KEY`（HTTP，走 fetch，免费版 Worker 也能用）
 *
 * 两者都需要 `EMAIL_FROM`（必须是已验证的发信域名）。缺任何一项 ⇒ `mailReady()` 为 false，
 * 能力接口如实上报，前端据此隐藏入口并给出明确说明——**绝不假装可用**。
 *
 * 开发环境（`ENVIRONMENT !== "production"`）**不发信**：只打日志，并由调用方把验证码
 * 直接回显给前端（与 cf-api / cf-dashboard 一致），本地联调不需要任何邮件配置。
 */

export interface MailEnv {
  ENVIRONMENT?: string;
  /** Cloudflare Email Service 绑定 */
  EMAIL?: { send(options: Record<string, unknown>): Promise<unknown> };
  /** Resend API key */
  RESEND_API_KEY?: string;
  /** 发信人地址（域名需已验证） */
  EMAIL_FROM?: string;
}

export interface MailMessage {
  to: string;
  subject: string;
  text: string;
  html?: string;
}

export interface MailResult {
  ok: boolean;
  /** 开发环境未真正发送 */
  dev?: boolean;
  error?: string;
}

export function isDevEnv(env: MailEnv): boolean {
  return (env.ENVIRONMENT ?? "development") !== "production";
}

/** 传输层是否具备（不判断域名是否验证过） */
function hasTransport(env: MailEnv): boolean {
  return Boolean(env.EMAIL) || Boolean(env.RESEND_API_KEY);
}

/**
 * 是否"配好了发信"。**只看配置，不探测可用性** —— 真正能不能送到只有发出去才知道，
 * 所以后台设置页提供"发送测试邮件"。
 */
export function mailReady(env: MailEnv): boolean {
  return hasTransport(env) && Boolean(env.EMAIL_FROM);
}

/**
 * 邮箱验证码能力是否可用：开发环境永远可用（回显），生产要求 `mailReady()`。
 * 这是**唯一的判定入口**，后台登录页、App `/meta`、部署摘要都读它。
 */
export function emailCodeAvailable(env: MailEnv): boolean {
  return isDevEnv(env) || mailReady(env);
}

export async function sendMail(env: MailEnv, message: MailMessage): Promise<MailResult> {
  if (isDevEnv(env)) {
    console.log(`[mail] dev 不发信 → ${message.to} | ${message.subject}`);
    return { ok: true, dev: true };
  }
  if (!mailReady(env)) return { ok: false, error: "email_unavailable" };

  const from = env.EMAIL_FROM!;
  try {
    if (env.EMAIL) {
      await env.EMAIL.send({
        to: message.to,
        from: { email: from, name: "Clever VPN" },
        subject: message.subject,
        text: message.text,
        html: message.html ?? `<p>${message.text}</p>`,
      });
      return { ok: true };
    }
    const res = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${env.RESEND_API_KEY!}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        from,
        to: [message.to],
        subject: message.subject,
        text: message.text,
        html: message.html ?? `<p>${message.text}</p>`,
      }),
    });
    if (!res.ok) {
      const detail = await res.text().catch(() => "");
      console.error(`[mail] resend ${res.status}: ${detail.slice(0, 200)}`);
      return { ok: false, error: `resend_${res.status}` };
    }
    return { ok: true };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error("[mail] 发送失败:", msg);
    return { ok: false, error: msg };
  }
}

/** 验证码邮件正文（后台与 App 共用同一个模板） */
export function codeEmail(code: string, purpose: "login" | "password"): MailMessage["html"] {
  const title =
    purpose === "login" ? "登录验证码" : "修改密码验证码";
  return `
    <div style="font-family:-apple-system,Segoe UI,sans-serif;max-width:480px;margin:0 auto">
      <h2 style="color:#16191d">${title}</h2>
      <div style="background:#f5f5f7;padding:20px;text-align:center;margin:16px 0;border-radius:8px">
        <span style="font-size:30px;font-weight:700;letter-spacing:8px;color:#2563eb">${code}</span>
      </div>
      <p style="color:#6b7480;font-size:13px">10 分钟内有效。如非本人操作，请忽略此邮件。</p>
    </div>`;
}
