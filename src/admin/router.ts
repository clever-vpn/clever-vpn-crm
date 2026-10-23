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
import { handleAdminPlans } from "./plans";
import { handleAdminSubscriptions } from "./subscriptions";

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

export async function handleAdminApi(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  const path = url.pathname.replace(/^\/api\/admin/, "") || "/";
  const method = request.method;

  if (!csrfOk(request)) return fail(403, "csrf_rejected");

  // ── 公开：是否需要初始化 ────────────────────────────────────────────
  if (method === "GET" && path === "/bootstrap") {
    const admin = await loadAdmin(env);
    return json({ needs_setup: admin === null, setup_configured: Boolean(env.SETUP_TOKEN) });
  }

  // ── 公开：首次初始化（一次性 SETUP_TOKEN） ──────────────────────────
  if (method === "POST" && path === "/setup") {
    if (!env.SETUP_TOKEN) return fail(503, "setup_disabled", "SETUP_TOKEN 未配置");
    if (await loadAdmin(env)) return fail(409, "already_initialized");
    const body = await readBody(request);
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
    return json({ email: admin.email, totp_enabled: Boolean(admin.totp_enabled) });
  }

  if (method === "POST" && path === "/logout") {
    await env.DB.prepare(`DELETE FROM admin_sessions WHERE id = ?`).bind(session.id).run();
    await audit(env, admin.email, "logout", null, null);
    return json({ ok: true }, 200, { "Set-Cookie": clearCookie(SESSION_COOKIE) });
  }

  if (method === "POST" && path === "/password") {
    const body = await readBody(request);
    const current = str(body.current);
    const next = str(body.next);
    if (!(await verifyPassword(current, admin.password_hash))) {
      return fail(401, "invalid_password");
    }
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
