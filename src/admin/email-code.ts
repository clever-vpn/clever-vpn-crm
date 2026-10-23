/**
 * 邮箱验证码 —— 后台登录 / 后台改密 共用
 *
 * 复用 `email_codes` 表（App 端登录也在用），靠 `purpose` 区分：
 *   - `admin_login`    后台"用邮箱验证码登录"
 *   - `admin_password` 后台"用邮箱验证码改密码"
 *   - `login`          App 端登录（`src/app/router.ts`）
 *
 * 规则（与 App 端一致，且更保守）：
 *   6 位、10 分钟、最多 5 次尝试、60 秒冷却；**只存哈希**；一次性。
 *   哈希的入参包含 `purpose`，所以两类码不能混用（改密码不能拿去登录）。
 *
 * 为什么冷却期内直接返回成功而不报错：避免把"这个邮箱刚发过码"变成信息泄露。
 */

import { generateNumericCode, sha256Hex, timingSafeEqual } from "./crypto";
import { codeEmail, emailCodeAvailable, isDevEnv, sendMail } from "../mail";

import type { Env } from "../env";

export type CodePurpose = "admin_login" | "admin_password" | "login";

const CODE_TTL_MS = 10 * 60 * 1000;
const COOLDOWN_MS = 60 * 1000;
const MAX_ATTEMPTS = 5;

export interface IssueResult {
  ok: boolean;
  /** 开发环境回显（生产永远为空） */
  code?: string;
  dev?: boolean;
  /** 冷却中，没有发送新码 */
  cooled?: boolean;
  error?: string;
}

const hash = (purpose: CodePurpose, email: string, code: string): Promise<string> =>
  sha256Hex(`${purpose}:${email}:${code}`);

export async function issueCode(
  env: Env,
  email: string,
  purpose: CodePurpose,
): Promise<IssueResult> {
  if (!emailCodeAvailable(env)) return { ok: false, error: "email_unavailable" };

  const now = Date.now();
  const existing = await env.DB.prepare(`SELECT sent_at FROM email_codes WHERE email = ?`)
    .bind(email)
    .first<{ sent_at: string }>();
  if (existing && now - Date.parse(existing.sent_at) < COOLDOWN_MS) {
    return { ok: true, cooled: true };
  }

  const code = generateNumericCode();
  await env.DB.prepare(
    `INSERT INTO email_codes (email, code_hash, purpose, sent_at, expires_at, attempts)
     VALUES (?, ?, ?, ?, ?, 0)
     ON CONFLICT(email) DO UPDATE SET
       code_hash = excluded.code_hash, purpose = excluded.purpose,
       sent_at = excluded.sent_at, expires_at = excluded.expires_at, attempts = 0`,
  )
    .bind(
      email,
      await hash(purpose, email, code),
      purpose,
      new Date(now).toISOString(),
      new Date(now + CODE_TTL_MS).toISOString(),
    )
    .run();

  const verb = purpose === "admin_password" ? "修改密码" : "登录";
  const sent = await sendMail(env, {
    to: email,
    subject: `验证码: ${code}`,
    text: `您的${verb}验证码是 ${code}，10 分钟内有效。`,
    html: codeEmail(code, purpose === "admin_password" ? "password" : "login"),
  });
  if (!sent.ok) return { ok: false, error: sent.error ?? "email_send_failed" };

  return isDevEnv(env) ? { ok: true, code, dev: true } : { ok: true };
}

/** 校验并**消费**验证码。返回 false 时不会泄露"到底是哪一步错了"。 */
export async function consumeCode(
  env: Env,
  email: string,
  purpose: CodePurpose,
  code: string,
): Promise<boolean> {
  if (!/^\d{6}$/.test(code)) return false;

  const row = await env.DB.prepare(
    `SELECT code_hash, purpose, expires_at, attempts FROM email_codes WHERE email = ?`,
  )
    .bind(email)
    .first<{ code_hash: string; purpose: string; expires_at: string; attempts: number }>();
  if (!row) return false;
  if (row.purpose !== purpose) return false;
  if (Date.parse(row.expires_at) <= Date.now() || row.attempts >= MAX_ATTEMPTS) {
    await env.DB.prepare(`DELETE FROM email_codes WHERE email = ?`).bind(email).run();
    return false;
  }

  const expected = await hash(purpose, email, code);
  if (!timingSafeEqual(expected, row.code_hash)) {
    await env.DB.prepare(`UPDATE email_codes SET attempts = attempts + 1 WHERE email = ?`)
      .bind(email)
      .run();
    return false;
  }

  await env.DB.prepare(`DELETE FROM email_codes WHERE email = ?`).bind(email).run();
  return true;
}
