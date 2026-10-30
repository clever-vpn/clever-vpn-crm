/**
 * 核销占位 —— 礼包领取与优惠券核销**共用的唯一闸门**
 *
 * 一句话：**先占下"这一次核销"，再改订阅。**
 *
 * 为什么必须先占：发放链路里真正花钱的动作（改 `expires_at` / 加流量 / 调 cf-api）
 * 和记账之间只要崩一次，重跑就会认为"他还没领过"→ 再发一份。额度是真金白银。
 *
 * 三步：
 *   1. `reserveRedemption()` —— **条件插入**，一条语句同时完成
 *      「名额还有」「我还没领过」「占下来」三件事（原子，不需要锁）；
 *   2. 正常发放（改订阅 → 推平台）；
 *   3. `settleRedemption()` 回填（`settled_at` + 实际生效权益 + 活动快照）；
 *      失败则 `releaseRedemption()` 删掉占位，否则这个人永远领不到。
 *
 * 名额口径（两处不同，别混）：
 *   - **还用掉多少名额** = 数全部行（**包含占位**）—— 不包含就会并发超发；
 *   - **我是不是已经领过** = 只数 `settled_at IS NOT NULL`。
 */
import type { Env } from "../env";
import type { GiftRewards } from "./model";

/** 占位超过这个时长视为上次崩了，可被接管 */
export const RESERVATION_LOCK_MS = 5 * 60 * 1000;

export type RedemptionReservation =
  | { ok: true; id: number }
  | { ok: false; reason: "already_claimed" | "sold_out" | "busy" | "failed"; message: string };

/**
 * 占下"这个人 × 这个活动"这一次核销。
 *
 * 调用方必须先做完所有**只读**校验（人群 / 时间窗 / 适用性）——
 * 这里只负责"抢"，抢不到就明确告诉他为什么。
 *
 * @param maxUses  `null` = 不限；否则**包含占位行**计数，绝不超发
 */
export async function reserveRedemption(
  env: Env,
  opts: {
    promotionId: number;
    customerId: number;
    /** 命中的批次码（`promotion_codes.id`）；主码 / 无码传 null */
    codeId: number | null;
    /** `null` = 不限名额 */
    maxUses: number | null;
    now: Date;
  },
): Promise<RedemptionReservation> {
  const nowIso = opts.now.toISOString();

  // 一条语句干三件事：名额还有 + 我还没领过 + 占位。
  // 用 `SELECT ... WHERE` 而不是"先查再插"：两次往返之间的窗口就是超发。
  const inserted = await env.DB.prepare(
    `INSERT INTO redemptions
       (promotion_id, customer_id, order_id, code_id, discount_minor, granted_json,
        promotion_snapshot, settled_at, created_at)
     SELECT ?, ?, NULL, ?, 0, '{}', NULL, NULL, ?
      WHERE (? IS NULL OR (SELECT COUNT(*) FROM redemptions WHERE promotion_id = ?) < ?)
        AND NOT EXISTS (
          SELECT 1 FROM redemptions WHERE promotion_id = ? AND customer_id = ?
        )`,
  )
    .bind(
      opts.promotionId,
      opts.customerId,
      opts.codeId,
      nowIso,
      opts.maxUses,
      opts.promotionId,
      opts.maxUses,
      opts.promotionId,
      opts.customerId,
    )
    .run();

  if (Number(inserted.meta.changes ?? 0) > 0) {
    const lastId = Number(inserted.meta.last_row_id ?? 0);
    if (lastId > 0) return { ok: true, id: lastId };
    const row = await env.DB.prepare(
      `SELECT id FROM redemptions WHERE promotion_id = ? AND customer_id = ?`,
    )
      .bind(opts.promotionId, opts.customerId)
      .first<{ id: number }>();
    if (row) return { ok: true, id: row.id };
    return { ok: false, reason: "failed", message: "领取登记失败，请稍后再试" };
  }

  // 抢不到 ⇒ 分清是"我领过了"还是"名额没了"（两个要说不同的话）
  const mine = await env.DB.prepare(
    `SELECT id, settled_at FROM redemptions WHERE promotion_id = ? AND customer_id = ?`,
  )
    .bind(opts.promotionId, opts.customerId)
    .first<{ id: number; settled_at: string | null }>();

  if (mine) {
    if (mine.settled_at) {
      return { ok: false, reason: "already_claimed", message: "这个礼包你已经领过了" };
    }
    // 占位还在（同一个人正在领）：它到底是"在飞"还是"上次崩了"？
    // 崩了就接管（不新增行），在飞就让他等几秒。
    const stale = await env.DB.prepare(
      `UPDATE redemptions SET created_at = ? WHERE id = ? AND settled_at IS NULL
         AND created_at < ?`,
    )
      .bind(
        nowIso,
        mine.id,
        new Date(opts.now.getTime() - RESERVATION_LOCK_MS).toISOString(),
      )
      .run();
    if (Number(stale.meta.changes ?? 0) > 0) return { ok: true, id: mine.id };
    return { ok: false, reason: "busy", message: "正在发放中，请稍后再看" };
  }

  return { ok: false, reason: "sold_out", message: "来晚了一步，这份礼包已经被抢完了" };
}

/** 发放成功：回填完成时间、**实际生效**的权益、以及活动快照 */
export async function settleRedemption(
  env: Env,
  id: number,
  opts: {
    applied: GiftRewards;
    snapshot: { name: string; badge: string | null; rewards: GiftRewards };
    now: Date;
  },
): Promise<void> {
  await env.DB.prepare(
    `UPDATE redemptions
        SET settled_at = ?, granted_json = ?, promotion_snapshot = ?
      WHERE id = ? AND settled_at IS NULL`,
  )
    .bind(
      opts.now.toISOString(),
      JSON.stringify(opts.applied),
      JSON.stringify(opts.snapshot),
      id,
    )
    .run();
}

/**
 * 发放失败：把占位还回去。
 *
 * 必须删掉而不是留空：唯一索引会一直挡着这个人，他再也领不到。
 */
export async function releaseRedemption(env: Env, id: number): Promise<void> {
  await env.DB.prepare(`DELETE FROM redemptions WHERE id = ? AND settled_at IS NULL`)
    .bind(id)
    .run();
}
