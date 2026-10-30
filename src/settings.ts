/**
 * 运行期设置（`settings` 表）的读写
 *
 * 只放**运营参数**：发信配额、上次跑每小时任务的时间。代码里的阈值/批次不在这里
 * （那些改了要发版，走常量）。
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
