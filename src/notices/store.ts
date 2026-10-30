/**
 * 通知的**存储与发送**（`notices` 表就是队列）
 *
 * 三层分工：
 *   1. 业务代码（礼包 / 订单）只调 `createNotice()` —— **只写行，不发信**；
 *   2. 泵 `sendPendingNotices()` 按预算取一批发掉（cron 调）；
 *   3. 配额与退订在泵里统一处理，业务侧不用关心。
 *
 * 为什么必须这样（三条都不是洁癖）：
 *   - **发信不能拖累业务**：信发不出去不能让券/权益失败；
 *   - **配额是硬的**：Cloudflare Email Service 有日配额（默认按 5000 配），
 *     一天发不完就顺延到明天 —— 行还在表里，etcd 式的内存队列做不到这点；
 *   - **幂等**：`(kind, customer_id, ref_id)` 唯一，cron 重跑不会发第二封。
 *
 * 还有一条隐形但重要的：**给验证码留余量**。App 是无密码登录，验证码是硬依赖；
 * 礼包邮件把配额吃干净 = 登录挂掉。所以软上限默认取配额的 90%。
 */
import { renderNoticeEmail } from "./model";
import { unsubscribeUrl } from "./unsubscribe";
import { mailReady, sendMail } from "../mail";

import type { Env } from "../env";
import type { NoticeDraft, NoticeKind } from "./model";

/** 每批取多少条（泵的粒度；PR 3 会按 tick 预算再细分） */
export const NOTICE_BATCH = 50;

/** 重试上限：超过就置 `failed`，不再打扰用户也不再烧配额 */
export const NOTICE_MAX_ATTEMPTS = 3;

/** 失败退避：5 分钟 × 次数 */
export const NOTICE_BACKOFF_MS = 5 * 60 * 1000;

/** 生产默认值（后台「设置 → 邮件」可改） */
export const DEFAULT_MAIL_DAILY_QUOTA = 5000;
export const DEFAULT_MAIL_SOFT_RATIO = 0.9;

export interface NoticeSettings {
  dailyQuota: number;
  softRatio: number;
  /** 软上限 = floor(quota × ratio)，永远给验证码留余量 */
  softLimit: number;
}

/** 读设置（缺失用默认值）；坏值一律回落到默认，绝不让配置把发信关死 */
export async function noticeSettings(env: Env): Promise<NoticeSettings> {
  const rows = await env.DB.prepare(
    `SELECT key, value FROM settings WHERE key IN ('mail_daily_quota', 'mail_soft_ratio')`,
  ).all<{ key: string; value: string }>();
  const map = new Map((rows.results ?? []).map((r) => [r.key, r.value]));

  const quotaRaw = Number(map.get("mail_daily_quota"));
  const dailyQuota =
    Number.isFinite(quotaRaw) && quotaRaw > 0 ? Math.round(quotaRaw) : DEFAULT_MAIL_DAILY_QUOTA;
  const ratioRaw = Number(map.get("mail_soft_ratio"));
  const softRatio =
    Number.isFinite(ratioRaw) && ratioRaw > 0 && ratioRaw <= 1 ? ratioRaw : DEFAULT_MAIL_SOFT_RATIO;

  return { dailyQuota, softRatio, softLimit: Math.floor(dailyQuota * softRatio) };
}

export async function saveNoticeSettings(
  env: Env,
  input: { dailyQuota?: number; softRatio?: number },
  now: Date = new Date(),
): Promise<NoticeSettings> {
  const nowIso = now.toISOString();
  const puts: [string, string][] = [];
  if (input.dailyQuota !== undefined) puts.push(["mail_daily_quota", String(input.dailyQuota)]);
  if (input.softRatio !== undefined) puts.push(["mail_soft_ratio", String(input.softRatio)]);
  for (const [key, value] of puts) {
    await env.DB.prepare(
      `INSERT INTO settings (key, value, updated_at) VALUES (?, ?, ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
    )
      .bind(key, value, nowIso)
      .run();
  }
  return noticeSettings(env);
}

/** 今天（UTC 日）已经发出去几封 */
export async function sentToday(env: Env, now: Date = new Date()): Promise<number> {
  const start = new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()),
  ).toISOString();
  const row = await env.DB.prepare(
    `SELECT COUNT(*) AS n FROM notices WHERE status = 'sent' AND sent_at >= ?`,
  )
    .bind(start)
    .first<{ n: number }>();
  return Number(row?.n ?? 0);
}

/**
 * 写一条通知（**幂等**：同一个 `(kind, customer_id, ref_id)` 只留一行）。
 *
 * 调用方必须在"业务已经成功"之后才调它（券已经发了 / 权益已经到账），
 * 并且**不要**把它的失败当业务失败 —— 通知丢了顶多少一封邮件，权益丢了是钱。
 */
export async function createNotice(
  env: Env,
  draft: NoticeDraft,
  now: Date = new Date(),
): Promise<{ created: boolean; id: number | null }> {
  const nowIso = now.toISOString();
  const res = await env.DB.prepare(
    `INSERT OR IGNORE INTO notices
       (customer_id, kind, ref_id, title, body, action_url, action_text,
        status, attempts, next_attempt_at, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', 0, ?, ?)`,
  )
    .bind(
      draft.customerId,
      draft.kind,
      draft.refId,
      draft.title,
      draft.body,
      draft.actionUrl ?? null,
      draft.actionText ?? null,
      nowIso,
      nowIso,
    )
    .run();
  const created = Number(res.meta.changes ?? 0) > 0;
  return { created, id: created ? Number(res.meta.last_row_id ?? 0) || null : null };
}

interface PendingRow {
  id: number;
  customer_id: number;
  kind: string;
  title: string;
  body: string;
  action_url: string | null;
  action_text: string | null;
  attempts: number;
  email: string | null;
  marketing_opt_out: number | null;
}

export interface SendReport {
  scanned: number;
  sent: number;
  suppressed: number;
  skipped: number;
  failed: number;
  /** 今日剩余软配额（0 = 已用尽，本轮不再发） */
  quotaLeft: number;
  /** 因配额用尽而顺延到明天的条数 */
  deferred: number;
  errors: string[];
}

/**
 * 发一批通知。
 *
 * 顺序上有三个判断，**顺序不能换**：
 *   1. 发信能力没配好（生产）⇒ 一条都不发，也不动它们（保持 pending，配好后自动补发）；
 *   2. 配额用尽 ⇒ 整个待发集合顺延到明天（不是只跳这一批，否则每个 tick 都要空转）；
 *   3. 用户退订 ⇒ 这一条直接 `skipped`（**不留 pending**，否则每轮都会重新扫到它）。
 */
export async function sendPendingNotices(
  env: Env,
  opts: { now?: Date; limit?: number } = {},
): Promise<SendReport> {
  const now = opts.now ?? new Date();
  const limit = opts.limit ?? NOTICE_BATCH;
  const report: SendReport = {
    scanned: 0,
    sent: 0,
    suppressed: 0,
    skipped: 0,
    failed: 0,
    quotaLeft: 0,
    deferred: 0,
    errors: [],
  };

  // 生产环境没配发信：一条都不发，也不消耗（本地 dev 会走"只打日志"的分支）
  if (!mailReady(env) && (env.ENVIRONMENT ?? "development") === "production") {
    report.quotaLeft = 0;
    return report;
  }

  const cfg = await noticeSettings(env);
  const used = await sentToday(env, now);
  const left = Math.max(0, cfg.softLimit - used);
  report.quotaLeft = left;
  if (left <= 0) {
    report.deferred = await deferToTomorrow(env, now);
    return report;
  }

  const rows = await env.DB.prepare(
    `SELECT n.id, n.customer_id, n.kind, n.title, n.body, n.action_url, n.action_text,
            n.attempts, c.email, c.marketing_opt_out
       FROM notices n LEFT JOIN customers c ON c.id = n.customer_id
      WHERE n.status = 'pending' AND n.next_attempt_at <= ?
      ORDER BY n.next_attempt_at, n.id
      LIMIT ?`,
  )
    .bind(now.toISOString(), Math.min(limit, left))
    .all<PendingRow>();

  const pending = rows.results ?? [];
  report.scanned = pending.length;

  for (const row of pending) {
    // 退订：只影响营销类（验证码等交易信不走这张表，天然不受影响）
    if (row.marketing_opt_out === 1) {
      await setStatus(env, row.id, "skipped", now, { attempts: row.attempts });
      report.skipped += 1;
      continue;
    }
    if (!row.email) {
      await setStatus(env, row.id, "skipped", now, { attempts: row.attempts });
      report.skipped += 1;
      continue;
    }

    const unsub = await unsubscribeUrl(env, row.customer_id);
    const mail = renderNoticeEmail(row, { unsubscribeUrl: unsub });
    const result = await sendMail(env, {
      to: row.email,
      subject: mail.subject,
      text: mail.text,
      html: mail.html,
      headers: {
        ...(unsub
          ? {
              "List-Unsubscribe": `<${unsub}>`,
              "List-Unsubscribe-Post": "List-Unsubscribe=One-Click",
            }
          : {}),
        // 便于在投递报表里区分"哪类通知"（Cloudflare 只放行白名单头，X- 前缀可以）
        "X-CRM-Notice": row.kind,
      },
    });

    if (result.ok) {
      await setStatus(env, row.id, "sent", now, { attempts: row.attempts, sentAt: now });
      report.sent += 1;
      continue;
    }

    const err = result.error ?? "unknown";
    // 硬退 / 被抑制：**终态**。重试只会烧配额、并且继续伤害域名信誉。
    if (/suppress|E_RECIPIENT/i.test(err)) {
      await setStatus(env, row.id, "suppressed", now, { attempts: row.attempts });
      report.suppressed += 1;
      continue;
    }

    const attempts = row.attempts + 1;
    if (attempts >= NOTICE_MAX_ATTEMPTS) {
      await setStatus(env, row.id, "failed", now, { attempts });
      report.failed += 1;
    } else {
      await env.DB.prepare(
        `UPDATE notices SET attempts = ?, next_attempt_at = ? WHERE id = ?`,
      )
        .bind(attempts, new Date(now.getTime() + NOTICE_BACKOFF_MS * attempts).toISOString(), row.id)
        .run();
    }
    report.errors.push(`${row.kind}#${row.id}: ${err}`);
  }

  return report;
}

async function setStatus(
  env: Env,
  id: number,
  status: string,
  now: Date,
  opts: { attempts: number; sentAt?: Date },
): Promise<void> {
  await env.DB.prepare(
    `UPDATE notices SET status = ?, attempts = ?, sent_at = COALESCE(?, sent_at) WHERE id = ?`,
  )
    .bind(status, opts.attempts, opts.sentAt ? opts.sentAt.toISOString() : null, id)
    .run();
}

/**
 * 配额用尽 ⇒ 把**所有**待发的推到明天 00:00 之后（加 0–30 分钟抖动）。
 *
 * 抖动是为了避免"次日零点头 30 分钟把一天的配额打光" —— 收件方看到的是突发，
 * 投递率会掉。
 */
async function deferToTomorrow(env: Env, now: Date): Promise<number> {
  const tomorrow = new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1),
  );
  const jitterMs = Math.floor(Math.random() * 30 * 60 * 1000);
  const at = new Date(tomorrow.getTime() + jitterMs).toISOString();
  const res = await env.DB.prepare(
    `UPDATE notices SET next_attempt_at = ? WHERE status = 'pending' AND next_attempt_at <= ?`,
  )
    .bind(at, now.toISOString())
    .run();
  return Number(res.meta.changes ?? 0);
}

/** 我有哪些待收的通知（App「消息」tab 用；文案已经是成品） */
export async function listNotices(
  env: Env,
  customerId: number,
  limit = 20,
): Promise<
  { id: number; kind: string; title: string; body: string; action_url: string | null; action_text: string | null; created_at: string }[]
> {
  const rows = await env.DB.prepare(
    `SELECT id, kind, title, body, action_url, action_text, created_at
       FROM notices WHERE customer_id = ? ORDER BY id DESC LIMIT ?`,
  )
    .bind(customerId, Math.min(50, Math.max(1, limit)))
    .all<{
      id: number;
      kind: string;
      title: string;
      body: string;
      action_url: string | null;
      action_text: string | null;
      created_at: string;
    }>();
  return rows.results ?? [];
}

/** 是否有待领取/待看的通知（红点用） */
export async function pendingNoticeCount(env: Env, customerId: number): Promise<number> {
  const row = await env.DB.prepare(
    `SELECT COUNT(*) AS n FROM notices WHERE customer_id = ? AND status != 'skipped'`,
  )
    .bind(customerId)
    .first<{ n: number }>();
  return Number(row?.n ?? 0);
}

export type { NoticeKind };
