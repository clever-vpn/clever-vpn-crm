/**
 * 管理后台 API：`/api/admin/*`
 *
 * 定位：**单个管理员账号**的 CRM 后台。认证 = 邮箱 + 密码（可选 TOTP 2FA）。
 * 会话用 HttpOnly Cookie（与 App 的 Bearer token 完全分离）。
 *
 * 账号丢失的恢复路径刻意不做成接口：拿到 Cloudflare 账号就能用 D1 改回来
 * （见 docs/admin.md），少一个可被攻击的入口。
 */
import type { Env } from "../env";
import {
  DEFAULT_ITERATIONS,
  generateTotpSecret,
  hashPassword,
  randomToken,
  sha256Hex,
  timingSafeEqual,
  verifyPassword,
  verifyTotp,
} from "./crypto";
import { consumeCode, issueCode } from "./email-code";
import { handleAdminPlans } from "./plans";
import { handleAdminSubscriptions } from "./subscriptions";
import { emailCodeAvailable, mailReady, sendMail } from "../mail";
import { clientIp, turnstileEnabled, verifyTurnstile } from "../turnstile";

const SESSION_COOKIE = "crm_admin";
const PENDING_COOKIE = "crm_admin_pending";
const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const PENDING_TTL_MS = 5 * 60 * 1000;
const MAX_FAILED = 5;
const LOCK_MS = 15 * 60 * 1000;

interface AdminRow {
  id: number;
  email: string;
  password_hash: string;
  totp_secret: string | null;
  totp_enabled: number;
  failed_attempts: number;
  locked_until: string | null;
}

interface SessionRow {
  id: string;
  user_id: number;
  pending: number;
  created_at: string;
  last_used_at: string;
}

function json(body: unknown, status = 200, headers?: HeadersInit): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8", ...headers },
  });
}

const fail = (status: number, error: string, message?: string) =>
  json(message ? { error, message } : { error }, status);

function cookie(request: Request, name: string): string | null {
  const header = request.headers.get("Cookie");
  if (!header) return null;
  for (const part of header.split(";")) {
    const [key, ...rest] = part.trim().split("=");
    if (key === name) return rest.join("=");
  }
  return null;
}

function setCookie(name: string, value: string, maxAgeSeconds: number): string {
  return `${name}=${value}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${maxAgeSeconds}`;
}

function clearCookie(name: string): string {
  return `${name}=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0`;
}

async function readBody(request: Request): Promise<Record<string, unknown>> {
  const body = await request.json().catch(() => null);
  return body && typeof body === "object" ? (body as Record<string, unknown>) : {};
}

const str = (value: unknown): string =>
  typeof value === "string" ? value.trim() : "";

async function audit(
  env: Env,
  actor: string,
  action: string,
  target?: string | null,
  detail?: unknown,
): Promise<void> {
  await env.DB.prepare(
    `INSERT INTO audit_log (at, actor, action, target, detail) VALUES (?, ?, ?, ?, ?)`,
  )
    .bind(
      new Date().toISOString(),
      actor,
      action,
      target ?? null,
      detail === undefined ? null : JSON.stringify(detail),
    )
    .run();
}

async function loadAdmin(env: Env): Promise<AdminRow | null> {
  return env.DB.prepare(`SELECT * FROM admin_users ORDER BY id LIMIT 1`).first<AdminRow>();
}

async function createSession(
  env: Env,
  request: Request,
  userId: number,
  pending: boolean,
): Promise<string> {
  const token = randomToken();
  const now = new Date();
  await env.DB.prepare(
    `INSERT INTO admin_sessions (id, user_id, pending, created_at, last_used_at, ip, user_agent)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  )
    .bind(
      await sha256Hex(token),
      userId,
      pending ? 1 : 0,
      now.toISOString(),
      now.toISOString(),
      request.headers.get("CF-Connecting-IP"),
      request.headers.get("User-Agent")?.slice(0, 200) ?? null,
    )
    .run();
  return token;
}

async function sessionFrom(
  env: Env,
  request: Request,
  name: string,
): Promise<(SessionRow & { token: string }) | null> {
  const token = cookie(request, name);
  if (!token) return null;
  const id = await sha256Hex(token);
  const row = await env.DB.prepare(`SELECT * FROM admin_sessions WHERE id = ?`)
    .bind(id)
    .first<SessionRow>();
  if (!row) return null;
  const ttl = row.pending ? PENDING_TTL_MS : SESSION_TTL_MS;
  const age = Date.now() - Date.parse(row.last_used_at);
  if (!Number.isFinite(age) || age > ttl) {
    await env.DB.prepare(`DELETE FROM admin_sessions WHERE id = ?`).bind(id).run();
    return null;
  }
  return { ...row, token };
}

/** 所有写操作的 CSRF 防线：必须是同源 fetch（自定义头无法跨源静默发送） */
function csrfOk(request: Request): boolean {
  if (request.method === "GET") return true;
  return request.headers.get("x-crm-request") === "1";
}

/**
 * 公开入口的人机校验。返回 null = 通过（包含"没配 secret 所以跳过"）。
 * 只用在 setup / login / 发验证码这种**能花钱或能枚举**的地方。
 */
async function turnstileGuard(
  request: Request,
  env: Env,
  body: Record<string, unknown>,
): Promise<Response | null> {
  if (!turnstileEnabled(env)) return null;
  const result = await verifyTurnstile(env, str(body.turnstile_token), clientIp(request));
  if (result.ok) return null;
  await audit(env, "anon", "turnstile_failed", null, { codes: result.codes });
  return fail(400, "turnstile_failed", "人机校验未通过，请刷新页面后重试");
}

export async function handleAdminApi(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  const path = url.pathname.replace(/^\/api\/admin/, "") || "/";
  const method = request.method;

  if (!csrfOk(request)) return fail(403, "csrf_rejected");

  // ── 公开：是否需要初始化 ────────────────────────────────────────────
  if (method === "GET" && path === "/bootstrap") {
    const admin = await loadAdmin(env);
    return json({
      needs_setup: admin === null,
      setup_configured: Boolean(env.SETUP_TOKEN),
      // 前端据此决定显示哪些登录方式：**没有的能力不显示**，而不是显示了再报错
      methods: emailCodeAvailable(env) ? ["password", "email"] : ["password"],
      mail_ready: mailReady(env),
      dev_email_echo: emailCodeAvailable(env) && !mailReady(env),
      // 没配 secret ⇒ 不下发 site key ⇒ 前端不渲染挂件（服务端也不校验）
      turnstile_site_key: turnstileEnabled(env) ? (env.TURNSTILE_SITE_KEY ?? null) : null,
    });
  }

  // ── 公开：首次初始化（一次性 SETUP_TOKEN） ──────────────────────────
  if (method === "POST" && path === "/setup") {
    if (!env.SETUP_TOKEN) return fail(503, "setup_disabled", "SETUP_TOKEN 未配置");
    if (await loadAdmin(env)) return fail(409, "already_initialized");
    const body = await readBody(request);
    const guarded = await turnstileGuard(request, env, body);
    if (guarded) return guarded;
    const token = str(body.token);
    const email = str(body.email).toLowerCase();
    const password = str(body.password);
    if (!timingSafeEqual(token, env.SETUP_TOKEN)) {
      await audit(env, "anon", "setup_failed", null, { reason: "bad_token" });
      return fail(401, "invalid_setup_token");
    }
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return fail(400, "invalid_email");
    if (password.length < 12) return fail(400, "weak_password");

    const iterations = Number(env.ADMIN_PBKDF2_ITERATIONS ?? DEFAULT_ITERATIONS);
    const now = new Date().toISOString();
    await env.DB.prepare(
      `INSERT INTO admin_users (email, password_hash, created_at, updated_at)
       VALUES (?, ?, ?, ?)`,
    )
      .bind(email, await hashPassword(password, iterations), now, now)
      .run();
    const admin = await loadAdmin(env);
    const session = await createSession(env, request, admin!.id, false);
    await audit(env, email, "setup", null, null);
    return json(
      { ok: true, email },
      200,
      { "Set-Cookie": setCookie(SESSION_COOKIE, session, SESSION_TTL_MS / 1000) },
    );
  }

  // ── 公开：登录 ─────────────────────────────────────────────────────
  if (method === "POST" && path === "/login") {
    const admin = await loadAdmin(env);
    if (!admin) return fail(409, "needs_setup");
    const body = await readBody(request);
    const guarded = await turnstileGuard(request, env, body);
    if (guarded) return guarded;
    const email = str(body.email).toLowerCase();
    const password = str(body.password);

    if (admin.locked_until && Date.parse(admin.locked_until) > Date.now()) {
      return fail(429, "locked", "尝试次数过多，请稍后再试");
    }

    const okPassword =
      email === admin.email.toLowerCase() && (await verifyPassword(password, admin.password_hash));
    if (!okPassword) {
      const failed = admin.failed_attempts + 1;
      const lockedUntil =
        failed >= MAX_FAILED ? new Date(Date.now() + LOCK_MS).toISOString() : null;
      await env.DB.prepare(
        `UPDATE admin_users SET failed_attempts = ?, locked_until = ?, updated_at = ? WHERE id = ?`,
      )
        .bind(failed, lockedUntil, new Date().toISOString(), admin.id)
        .run();
      await audit(env, email || "anon", "login_failed", null, { failed });
      return fail(401, "invalid_credentials");
    }

    await env.DB.prepare(
      `UPDATE admin_users SET failed_attempts = 0, locked_until = NULL, updated_at = ? WHERE id = ?`,
    )
      .bind(new Date().toISOString(), admin.id)
      .run();

    if (admin.totp_enabled) {
      const pending = await createSession(env, request, admin.id, true);
      return json(
        { totp_required: true },
        200,
        { "Set-Cookie": setCookie(PENDING_COOKIE, pending, PENDING_TTL_MS / 1000) },
      );
    }

    const session = await createSession(env, request, admin.id, false);
    await audit(env, admin.email, "login", null, null);
    return json(
      { ok: true },
      200,
      { "Set-Cookie": setCookie(SESSION_COOKIE, session, SESSION_TTL_MS / 1000) },
    );
  }

  // ── 公开：邮箱验证码登录（第一步：发码）────────────────────────────
  // 恒定响应：不泄露"这个邮箱是不是管理员"；只有匹配才真的发信。
  if (method === "POST" && path === "/login/email/start") {
    const admin = await loadAdmin(env);
    if (!admin) return fail(409, "needs_setup");
    if (!emailCodeAvailable(env)) {
      return fail(503, "email_unavailable", "未配置邮件发送，请使用密码登录");
    }
    const body = await readBody(request);
    const guarded = await turnstileGuard(request, env, body);
    if (guarded) return guarded;
    const email = str(body.email).toLowerCase();
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return fail(400, "invalid_email");

    if (email !== admin.email.toLowerCase()) return json({ ok: true, cooldown: 60 });

    const issued = await issueCode(env, email, "admin_login");
    if (!issued.ok) return fail(502, "email_send_failed", "验证码发送失败，请改用密码登录");
    return json({ ok: true, cooldown: 60, ...(issued.code ? { code: issued.code, dev: true } : {}) });
  }

  // ── 公开：邮箱验证码登录（第二步：换会话）────────────────────────
  if (method === "POST" && path === "/login/email/verify") {
    const admin = await loadAdmin(env);
    if (!admin) return fail(409, "needs_setup");
    const body = await readBody(request);
    const email = str(body.email).toLowerCase();
    const code = str(body.code);

    if (admin.locked_until && Date.parse(admin.locked_until) > Date.now()) {
      return fail(429, "locked", "尝试次数过多，请稍后再试");
    }

    const ok =
      email === admin.email.toLowerCase() && (await consumeCode(env, email, "admin_login", code));
    if (!ok) {
      // 与密码登录共用同一套锁定计数，避免邮箱入口成为爆破入口
      const failed = admin.failed_attempts + 1;
      const lockedUntil = failed >= MAX_FAILED ? new Date(Date.now() + LOCK_MS).toISOString() : null;
      await env.DB.prepare(
        `UPDATE admin_users SET failed_attempts = ?, locked_until = ?, updated_at = ? WHERE id = ?`,
      )
        .bind(failed, lockedUntil, new Date().toISOString(), admin.id)
        .run();
      await audit(env, email || "anon", "login_email_failed", null, { failed });
      return fail(401, "invalid_code", "验证码不正确或已过期");
    }

    await env.DB.prepare(
      `UPDATE admin_users SET failed_attempts = 0, locked_until = NULL, updated_at = ? WHERE id = ?`,
    )
      .bind(new Date().toISOString(), admin.id)
      .run();

    // 开了 TOTP 就必须还要第二步 —— 否则邮箱认证会成为绕过 2FA 的后门
    if (admin.totp_enabled) {
      const pending = await createSession(env, request, admin.id, true);
      return json(
        { totp_required: true },
        200,
        { "Set-Cookie": setCookie(PENDING_COOKIE, pending, PENDING_TTL_MS / 1000) },
      );
    }

    const session = await createSession(env, request, admin.id, false);
    await audit(env, admin.email, "login", null, { via: "email" });
    return json(
      { ok: true },
      200,
      { "Set-Cookie": setCookie(SESSION_COOKIE, session, SESSION_TTL_MS / 1000) },
    );
  }

  // ── 公开：2FA 第二步 ───────────────────────────────────────────────
  if (method === "POST" && path === "/login/totp") {
    const admin = await loadAdmin(env);
    if (!admin?.totp_secret) return fail(409, "totp_not_enabled");
    const pending = await sessionFrom(env, request, PENDING_COOKIE);
    if (!pending?.pending) return fail(401, "pending_expired");

    const body = await readBody(request);
    if (!(await verifyTotp(admin.totp_secret, str(body.code)))) {
      await audit(env, admin.email, "login_totp_failed", null, null);
      return fail(401, "invalid_code");
    }

    await env.DB.prepare(`DELETE FROM admin_sessions WHERE id = ?`).bind(pending.id).run();
    const session = await createSession(env, request, admin.id, false);
    await audit(env, admin.email, "login", null, { totp: true });
    return new Response(JSON.stringify({ ok: true }), {
      status: 200,
      headers: {
        "Content-Type": "application/json; charset=utf-8",
        "Set-Cookie": setCookie(SESSION_COOKIE, session, SESSION_TTL_MS / 1000),
      },
    });
  }

  // ── 以下全部需要登录 ───────────────────────────────────────────────
  const admin = await loadAdmin(env);
  const session = await sessionFrom(env, request, SESSION_COOKIE);
  if (!admin || !session || session.pending) return fail(401, "unauthorized");

  await env.DB.prepare(`UPDATE admin_sessions SET last_used_at = ? WHERE id = ?`)
    .bind(new Date().toISOString(), session.id)
    .run();

  // ── 套餐设计器（销售策略的唯一写入口）──────────────────────────────
  const plansResponse = await handleAdminPlans(request, env, admin.email);
  if (plansResponse) return plansResponse;

  // ── 订阅与结算（手工开通 / 跑结算）──────────────────────────────────
  const subsResponse = await handleAdminSubscriptions(request, env, admin.email);
  if (subsResponse) return subsResponse;

  if (method === "GET" && path === "/me") {
    return json({
      email: admin.email,
      totp_enabled: Boolean(admin.totp_enabled),
      mail_ready: mailReady(env),
    });
  }

  // ── 发一封测试邮件：验证"配了"≠"能发" ─────────────────────────
  if (method === "POST" && path === "/mail/test") {
    if (!mailReady(env)) {
      return fail(503, "email_unavailable", "未配置 EMAIL/RESEND_API_KEY 或 EMAIL_FROM");
    }
    const result = await sendMail(env, {
      to: admin.email,
      subject: "[CRM] 测试邮件",
      text: `这封邮件来自 Clever VPN CRM。看到它说明发信配置可用（${new Date().toISOString()}）。`,
    });
    await audit(env, admin.email, "mail_test", null, { ok: result.ok, error: result.error ?? null });
    if (!result.ok) return fail(502, "email_send_failed", result.error ?? "发送失败");
    return json({ ok: true, dev: Boolean(result.dev) });
  }

  if (method === "POST" && path === "/logout") {
    await env.DB.prepare(`DELETE FROM admin_sessions WHERE id = ?`).bind(session.id).run();
    await audit(env, admin.email, "logout", null, null);
    return json({ ok: true }, 200, { "Set-Cookie": clearCookie(SESSION_COOKIE) });
  }

  // 改密的第二种再认证：给当前绑定邮箱发码（必须有会话才能调）
  if (method === "POST" && path === "/password/send-code") {
    if (!emailCodeAvailable(env)) {
      return fail(503, "email_unavailable", "未配置邮件发送，请使用当前密码修改");
    }
    const issued = await issueCode(env, admin.email.toLowerCase(), "admin_password");
    if (!issued.ok) return fail(502, "email_send_failed", "验证码发送失败");
    return json({ ok: true, cooldown: 60, ...(issued.code ? { code: issued.code, dev: true } : {}) });
  }

  if (method === "POST" && path === "/password") {
    const body = await readBody(request);
    const current = str(body.current);
    const code = str(body.code);
    const next = str(body.next);

    // 再认证：当前密码 **或** 邮箱验证码（两者都证明"是你"，但不能都没有）
    let verified = false;
    if (current) verified = await verifyPassword(current, admin.password_hash);
    else if (code) {
      verified = await consumeCode(env, admin.email.toLowerCase(), "admin_password", code);
    }
    if (!verified) return fail(401, "invalid_credential", "当前密码或验证码不正确");
    if (next.length < 12) return fail(400, "weak_password");
    const iterations = Number(env.ADMIN_PBKDF2_ITERATIONS ?? DEFAULT_ITERATIONS);
    await env.DB.prepare(`UPDATE admin_users SET password_hash = ?, updated_at = ? WHERE id = ?`)
      .bind(await hashPassword(next, iterations), new Date().toISOString(), admin.id)
      .run();
    // 改密后踢掉其它设备，保留当前会话
    await env.DB.prepare(`DELETE FROM admin_sessions WHERE user_id = ? AND id <> ?`)
      .bind(admin.id, session.id)
      .run();
    await audit(env, admin.email, "password_changed", null, null);
    return json({ ok: true });
  }

  if (method === "GET" && path === "/sessions") {
    const rows = await env.DB.prepare(
      `SELECT id, created_at, last_used_at, ip, user_agent FROM admin_sessions
       WHERE user_id = ? ORDER BY last_used_at DESC`,
    )
      .bind(admin.id)
      .all<{
        id: string;
        created_at: string;
        last_used_at: string;
        ip: string | null;
        user_agent: string | null;
      }>();
    return json({
      sessions: (rows.results ?? []).map((row) => ({
        sid: row.id.slice(0, 8),
        created_at: row.created_at,
        last_used_at: row.last_used_at,
        ip: row.ip,
        user_agent: row.user_agent,
        current: row.id === session.id,
      })),
    });
  }

  const revoke = path.match(/^\/sessions\/([a-f0-9]{8})$/);
  if (method === "DELETE" && revoke) {
    const result = await env.DB.prepare(
      `DELETE FROM admin_sessions WHERE user_id = ? AND substr(id, 1, 8) = ?`,
    )
      .bind(admin.id, revoke[1])
      .run();
    await audit(env, admin.email, "session_revoked", revoke[1], {
      deleted: result.meta.changes,
    });
    return json({ ok: true });
  }

  if (method === "POST" && path === "/2fa/enroll") {
    if (admin.totp_enabled) return fail(409, "totp_already_enabled");
    const secret = generateTotpSecret();
    await env.DB.prepare(`UPDATE admin_users SET totp_secret = ?, updated_at = ? WHERE id = ?`)
      .bind(secret, new Date().toISOString(), admin.id)
      .run();
    const label = encodeURIComponent(`CleverVPN CRM:${admin.email}`);
    const uri =
      `otpauth://totp/${label}?secret=${secret}&issuer=CleverVPN-CRM&algorithm=SHA1&digits=6&period=30`;
    return json({ secret, uri });
  }

  if (method === "POST" && path === "/2fa/activate") {
    if (!admin.totp_secret) return fail(409, "totp_not_enrolled");
    const body = await readBody(request);
    if (!(await verifyTotp(admin.totp_secret, str(body.code)))) {
      return fail(400, "invalid_code");
    }
    await env.DB.prepare(`UPDATE admin_users SET totp_enabled = 1, updated_at = ? WHERE id = ?`)
      .bind(new Date().toISOString(), admin.id)
      .run();
    await audit(env, admin.email, "totp_enabled", null, null);
    return json({ ok: true });
  }

  if (method === "POST" && path === "/2fa/disable") {
    const body = await readBody(request);
    if (!(await verifyPassword(str(body.password), admin.password_hash))) {
      return fail(401, "invalid_password");
    }
    await env.DB.prepare(
      `UPDATE admin_users SET totp_enabled = 0, totp_secret = NULL, updated_at = ? WHERE id = ?`,
    )
      .bind(new Date().toISOString(), admin.id)
      .run();
    await audit(env, admin.email, "totp_disabled", null, null);
    return json({ ok: true });
  }

  if (method === "GET" && path === "/audit") {
    const limit = Math.min(200, Math.max(1, Number(url.searchParams.get("limit") ?? 50) || 50));
    const rows = await env.DB.prepare(
      `SELECT at, actor, action, target, detail FROM audit_log ORDER BY id DESC LIMIT ?`,
    )
      .bind(limit)
      .all<{ at: string; actor: string; action: string; target: string | null; detail: string | null }>();
    return json({ entries: rows.results ?? [] });
  }

  return fail(404, "not_found", `unknown admin api: ${method} ${path}`);
}
