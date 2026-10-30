/**
 * 核销占位 —— **幂等地基**
 *
 * 一句话：**先占下"这一次核销"，再改订阅。**
 *
 * 为什么不能"发完再记账"：发放链路里真正花钱的动作（改 `expires_at` / 加流量 /
 * 调 cf-api）和记账（写 `redemptions`）之间只要崩一次，重跑时：
 *   - `checkForCustomer` 数不到那行台账 ⇒ 认为"他还没领过" ⇒ **再发一份**；
 *   - 于是又多一张 0 元订单、多一份额度。
 * 额度是真金白银，不能靠"大概不会崩"。批量发放（跑上万人）之后这会变成“重跑一页
 * 就多发一页”，所以占位先行是**批量安全的前提**，不是洁癖。
 *
 * 三步：
 *   1. `reserveRedemption()` —— `INSERT OR IGNORE`，占位行 `order_id IS NULL`。
 *      `changes = 1` ⇒ 我们抢到了；`changes = 0` ⇒ 别人已经占/已经发完。
 *   2. 正常发放（建 0 元订单 → 改订阅 → 推平台）。
 *   3. `settleRedemption()` —— 回填 `order_id` 与**实际生效**的奖励；
 *      失败则 `releaseRedemption()` 把占位删掉（否则这个人永远领不到：唯一索引挡着）。
 *
 * 崩溃恢复：占位行 `order_id IS NULL` 且 `created_at` 超过 `REDEMPTION_LOCK_MS`
 * 视为那次发放崩了，允许后来的接管（与 `promotion_claims` 的 `claiming` 同一个思路）。
 * 在这 5 分钟内重入会得到"正在发放中"，而不是悄悄再发一份。
 */
import type { Env } from "../env";
import type { GiftRewards } from "./model";

/** 占位超过这个时长视为上次崩了，可被接管 */
export const REDEMPTION_LOCK_MS = 5 * 60 * 1000;

export type RedemptionReservation = { ok: true; id: number } | { ok: false; reason: string };

/**
 * 占下"这个人 × 这个活动"这一次核销。
 *
 * 调用方必须先做完所有**只读**校验（人群 / 名额 / 适用性），这里只负责"抢"：
 * 校验放在前面，失败就不用占位、也不用回滚。
 */
export async function reserveRedemption(
  env: Env,
  opts: {
    promotionId: number;
    customerId: number;
    /** 命中的批次码（`promotion_codes.id`）；主码 / 系统发放传 null */
    codeId: number | null;
    now: Date;
  },
): Promise<RedemptionReservation> {
  const nowIso = opts.now.toISOString();
  const inserted = await env.DB.prepare(
    `INSERT OR IGNORE INTO redemptions
       (promotion_id, customer_id, order_id, code_id, discount_minor, granted_json, created_at)
     VALUES (?, ?, NULL, ?, 0, '{}', ?)`,
  )
    .bind(opts.promotionId, opts.customerId, opts.codeId, nowIso)
    .run();

  if (Number(inserted.meta.changes ?? 0) > 0) {
    const lastId = Number(inserted.meta.last_row_id ?? 0);
    if (lastId > 0) return { ok: true, id: lastId };
    // 极少数运行时不给 last_row_id：回查一次（按唯一键，只有一行）
    const row = await env.DB.prepare(
      `SELECT id FROM redemptions WHERE promotion_id = ? AND customer_id = ?`,
    )
      .bind(opts.promotionId, opts.customerId)
      .first<{ id: number }>();
    if (row) return { ok: true, id: row.id };
    return { ok: false, reason: "发放登记失败，请稍后再试" };
  }

  // 唯一键挡住了 ⇒ 要么已经发过，要么别人正在发（或上次崩在这儿）
  const existing = await env.DB.prepare(
    `SELECT id, order_id, created_at FROM redemptions WHERE promotion_id = ? AND customer_id = ?`,
  )
    .bind(opts.promotionId, opts.customerId)
    .first<{ id: number; order_id: number | null; created_at: string }>();
  if (!existing) return { ok: false, reason: "发放登记失败，请稍后再试" };

  if (existing.order_id !== null) {
    return { ok: false, reason: "这个东西你已经领过了" };
  }
  // 占位还没到期 ⇒ 真的有人在发（并发双击 / 批量重入）
  if (Date.parse(existing.created_at) > opts.now.getTime() - REDEMPTION_LOCK_MS) {
    return { ok: false, reason: "正在发放中，请稍后再看" };
  }
  // 上次崩在中间：接管这条占位（只刷新时间戳，不新增行）
  await env.DB.prepare(`UPDATE redemptions SET created_at = ? WHERE id = ?`)
    .bind(nowIso, existing.id)
    .run();
  return { ok: true, id: existing.id };
}

/** 发放成功：回填订单号与**实际生效**的权益（不是配置值） */
export async function settleRedemption(
  env: Env,
  id: number,
  orderId: number,
  applied: GiftRewards,
): Promise<void> {
  await env.DB.prepare(
    `UPDATE redemptions SET order_id = ?, granted_json = ? WHERE id = ?`,
  )
    .bind(orderId, JSON.stringify(applied), id)
    .run();
}

/**
 * 发放失败：把占位还回去。
 *
 * 必须删掉而不是留空：唯一索引会一直挡着这个人，他再也领不到这份礼包。
 */
export async function releaseRedemption(env: Env, id: number): Promise<void> {
  await env.DB.prepare(`DELETE FROM redemptions WHERE id = ? AND order_id IS NULL`)
    .bind(id)
    .run();
}
