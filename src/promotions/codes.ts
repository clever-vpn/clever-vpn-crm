/**
 * 批次码（契约 §2.9.7）—— 一个活动下 N 个码，一码一人
 *
 * 为什么要这张表：一码一人 / 按码统计用量 / 单独作废某个码，都要求"码"本身是
 * 一行数据。`promotions.code` 保留为**主码**（单码活动），两者共存：
 *
 *   **查找顺序：先主码，再批次码。** 用户只看到一串字符，不关心里面是谁。
 *
 * 用量只有一个事实来源：数 `redemptions.code_id`，不另存 `used_count`
 * （两份数迟早对不上）。
 */
import { PROMOTION_COLUMNS, rowToPromotion } from "./model";

import type { Env } from "../env";
import type { Promotion, PromotionRow } from "./model";

/** 去掉 I / O / 0 / 1：码要能被念出来、手抄下来 */
const ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
const DEFAULT_LENGTH = 8;

export function randomCode(length = DEFAULT_LENGTH): string {
  const bytes = new Uint8Array(length);
  crypto.getRandomValues(bytes);
  let out = "";
  for (const b of bytes) out += ALPHABET[b % ALPHABET.length];
  return out;
}

/** 码归一：去空格 + 大写（用户手输常见这两种） */
export function normalizeCode(raw: unknown): string {
  return typeof raw === "string" ? raw.trim().toUpperCase() : "";
}

export interface CodeHit {
  promotion: Promotion;
  /** 批次码的 id；命中的是主码时为 `null` */
  codeId: number | null;
  /** 这个码已经用了几次 */
  used: number;
  /** 这个码最多能用几次（主码按活动的 per-customer 规则走，记 Infinity） */
  maxUses: number;
  expiresAt: string | null;
}

/**
 * 把一个码解析成「活动 + 这个码的用量」。
 *
 * 只认**进行中的活动** + **有效的码**：活动没上线、码被作废，都当不存在。
 * 调用方拿不到 `null` 之外的区分信息 —— 别让猜码的人得到收敛信息。
 */
export async function lookupCode(env: Env, rawCode: string): Promise<CodeHit | null> {
  const code = normalizeCode(rawCode);
  if (!code) return null;

  // ① 主码（单码活动）
  const byMain = await env.DB.prepare(
    `SELECT ${PROMOTION_COLUMNS} FROM promotions
      WHERE code = ? AND status = 'active'`,
  )
    .bind(code)
    .first<PromotionRow>();
  if (byMain) {
    const used = await env.DB.prepare(
      `SELECT COUNT(*) AS n FROM redemptions WHERE promotion_id = ? AND code_id IS NULL`,
    )
      .bind(byMain.id)
      .first<{ n: number }>();
    return {
      promotion: rowToPromotion(byMain),
      codeId: null,
      used: Number(used?.n ?? 0),
      // 主码的"可用次数"由活动的 max_uses 管，这里不额外限制
      maxUses: Number.POSITIVE_INFINITY,
      expiresAt: null,
    };
  }

  // ② 批次码
  const meta = await env.DB.prepare(
    `SELECT id, promotion_id, max_uses, expires_at FROM promotion_codes
      WHERE code = ? AND status = 'active'`,
  )
    .bind(code)
    .first<{ id: number; promotion_id: number; max_uses: number; expires_at: string | null }>();
  if (!meta) return null;

  const promoRow = await env.DB.prepare(`SELECT ${PROMOTION_COLUMNS} FROM promotions WHERE id = ?`)
    .bind(meta.promotion_id)
    .first<PromotionRow>();
  if (!promoRow || promoRow.status !== "active") return null;

  const used = await env.DB.prepare(`SELECT COUNT(*) AS n FROM redemptions WHERE code_id = ?`)
    .bind(meta.id)
    .first<{ n: number }>();

  return {
    promotion: rowToPromotion(promoRow),
    codeId: meta.id,
    used: Number(used?.n ?? 0),
    maxUses: meta.max_uses,
    expiresAt: meta.expires_at,
  };
}

export interface GeneratedCode {
  id: number;
  code: string;
}

/**
 * 生成一批码（同一次生成共用一个 `batch_id`）。
 *
 * 撞码靠唯一索引兜底：`INSERT OR IGNORE` 失败就重生成那一个，
 * 最多重试 `count` 轮，仍然不够就如实返回（不假装成功）。
 */
export async function generateCodes(
  env: Env,
  opts: {
    promotionId: number;
    count: number;
    maxUses?: number;
    prefix?: string | null;
    expiresAt?: string | null;
    note?: string | null;
    now?: Date;
  },
): Promise<{ batchId: string; codes: GeneratedCode[] }> {
  const now = opts.now ?? new Date();
  const batchId = `B${now.toISOString().replace(/\D/g, "").slice(0, 14)}${randomCode(4)}`;
  const prefix = (opts.prefix ?? "").toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 8);
  const created: GeneratedCode[] = [];

  for (let attempt = 0; attempt < opts.count * 2 && created.length < opts.count; attempt += 1) {
    const code = prefix + randomCode(DEFAULT_LENGTH);
    const res = await env.DB.prepare(
      `INSERT OR IGNORE INTO promotion_codes
         (promotion_id, code, batch_id, max_uses, status, expires_at, note, created_at)
       VALUES (?, ?, ?, ?, 'active', ?, ?, ?)`,
    )
      .bind(
        opts.promotionId,
        code,
        batchId,
        Math.max(1, Math.round(opts.maxUses ?? 1)),
        opts.expiresAt ?? null,
        opts.note ?? null,
        now.toISOString(),
      )
      .run();
    if (res.meta.changes) created.push({ id: Number(res.meta.last_row_id ?? 0), code });
  }

  return { batchId, codes: created };
}

export interface CodeRowView {
  id: number;
  code: string;
  batch_id: string | null;
  max_uses: number;
  used: number;
  status: string;
  expires_at: string | null;
  note: string | null;
  created_at: string;
}

/** 某个活动下的所有批次码（带用量），按生成顺序 */
export async function listCodes(env: Env, promotionId: number): Promise<CodeRowView[]> {
  const rows = await env.DB.prepare(
    `SELECT c.id, c.code, c.batch_id, c.max_uses, c.status, c.expires_at, c.note, c.created_at,
            (SELECT COUNT(*) FROM redemptions r WHERE r.code_id = c.id) AS used
       FROM promotion_codes c
      WHERE c.promotion_id = ?
      ORDER BY c.id`,
  )
    .bind(promotionId)
    .all<Omit<CodeRowView, "used"> & { used: number }>();
  return (rows.results ?? []).map((r) => ({ ...r, used: Number(r.used) }));
}

/** 作废一个码（已核销的记录不动 —— 台账是事实） */
export async function revokeCode(env: Env, promotionId: number, codeId: number): Promise<boolean> {
  const res = await env.DB.prepare(
    `UPDATE promotion_codes SET status = 'revoked'
      WHERE id = ? AND promotion_id = ? AND status = 'active'`,
  )
    .bind(codeId, promotionId)
    .run();
  return Boolean(res.meta.changes);
}
