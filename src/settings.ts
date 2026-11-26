/**
 * 运行期设置（`settings` 表）的读写
 *
 * 放**实例级参数**：发信配额、上次跑每小时任务的时间、实例 UUID（`crm_id`）。
 * 代码里的阈值/批次不在这里（那些改了要发版，走常量）。
 *
 * 为什么单独一层：`settings` 被通知泵和 cron 门同时用，各自写一份 upsert SQL
 * 迟早会漂移。
 */
import type { Env } from "./env";

export async function getSetting(env: Env, key: string): Promise<string | null> {
  const row = await env.DB.prepare(`SELECT value FROM settings WHERE key = ?`)
    .bind(key)
    .first<{ value: string }>();
  return row?.value ?? null;
}

export async function setSetting(
  env: Env,
  key: string,
  value: string,
  now: Date = new Date(),
): Promise<void> {
  await env.DB.prepare(
    `INSERT INTO settings (key, value, updated_at) VALUES (?, ?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
  )
    .bind(key, value, now.toISOString())
    .run();
}

/** 读数字设置；缺失/坏值返回 `null`（调用方决定默认值） */
export async function getNumberSetting(env: Env, key: string): Promise<number | null> {
  const raw = await getSetting(env, key);
  if (raw === null) return null;
  const n = Number(raw);
  return Number.isFinite(n) ? n : null;
}

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/**
 * 实例 UUID（`crm_id`）：**首次被读取时生成，此后永不变**。
 *
 * 用途只有一个：App 构建期比对 `app.json.crm.id`，防"配错 CRM"（见 `clients.md` §7.1）。
 * 它不是秘密，但不得展示给终端用户，也不做任何运行时判定。
 *
 * 并发安全：先 `ON CONFLICT DO NOTHING` 再回读，保证两个同时到达的请求拿到同一个值。
 */
export async function getOrCreateCrmId(env: Env): Promise<string> {
  const existing = await getSetting(env, "crm_id");
  if (existing && UUID_RE.test(existing)) return existing;

  const candidate = crypto.randomUUID();
  const now = new Date().toISOString();
  await env.DB.prepare(
    `INSERT INTO settings (key, value, updated_at) VALUES ('crm_id', ?, ?)
     ON CONFLICT(key) DO NOTHING`,
  )
    .bind(candidate, now)
    .run();

  const row = await env.DB.prepare(`SELECT value FROM settings WHERE key = 'crm_id'`)
    .first<{ value: string }>();
  if (row?.value && UUID_RE.test(row.value)) return row.value;

  // 库里是坏值（手工改坏/旧格式）：覆盖成新的。实例 ID 只服务于构建门禁，坏值没有保留价值。
  await setSetting(env, "crm_id", candidate, new Date(now));
  return candidate;
}
