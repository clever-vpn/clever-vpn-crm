/**
 * 推荐奖励卡（契约 `app-crm.md` §2.9.9）—— **发卡**与**读卡**。
 *
 * 为什么要有这张表：v23 之前推荐人奖励是"好友付首单 ⇒ 立刻改推荐人的订阅"。
 * 那样做有两个毛病：
 *   1. 推荐人不知道发生了什么 —— 权益悄悄变了，没有"我去领一下"的爽感；
 *   2. 它绕开了礼包那套「这份订阅收不收得下」的判断，给不限量用户送 GB
 *      会把不限量写成"20GB 上限"（真实事故）。
 *
 * 现在：**好友付款 ⇒ 发一张卡**（这里），**推荐人自己点领取**才动订阅
 * （`gift.ts` 的 `claimRewardCard`，与礼包共用同一段发放代码）。
 *
 * 本文件刻意只做两件事（建卡 / 读卡），**不 import gift.ts** ——
 * 依赖方向是 `gift.ts → reward.ts`，反过来会成环。
 */
import type { Env } from "../env";
import type { GiftRewards } from "./model";

/** 卡的三种状态；`claiming` 只是并发占位，前端看不到 */
export type RewardCardState = "pending" | "claiming" | "claimed";

/** 读卡时的行（够渲染货架 + 决定能不能领） */
export interface RewardCardRow {
  id: number;
  referrer_id: number;
  promotion_id: number;
  rewards_json: string;
  promotion_snapshot: string | null;
  state: RewardCardState;
  claiming_at: string | null;
  claimed_at: string | null;
  granted_json: string | null;
  created_at: string;
}

/** 占位多久后可以被别人（其实是"另一个请求"）接管 */
export const CLAIM_TAKEOVER_MS = 5 * 60_000;

/**
 * 发一张奖励卡（幂等：一条 `referral_id` 只有一张）。
 *
 * 好友付了首单就该有卡，但**重复的通知不能发两张** ——
 * 唯一索引 `uq_referral_rewards_referral` 兜底，这里用 `ON CONFLICT DO NOTHING`。
 *
 * @returns 新建时返回卡 id；已存在时返回 `null`（调用方据此判断"这次是重复通知"）
 */
export async function createRewardCard(
  env: Env,
  opts: {
    referralId: number;
    referrerId: number;
    promotionId: number;
    rewards: GiftRewards;
    promotionName?: string | null;
    promotionBadge?: string | null;
    now?: Date;
  },
): Promise<number | null> {
  const now = opts.now ?? new Date();
  const snapshot = JSON.stringify({
    name: opts.promotionName ?? null,
    badge: opts.promotionBadge ?? null,
    rewards: opts.rewards,
  });

  const res = await env.DB.prepare(
    `INSERT INTO referral_rewards
       (referral_id, referrer_id, promotion_id, rewards_json, promotion_snapshot, state, created_at)
     VALUES (?, ?, ?, ?, ?, 'pending', ?)
     ON CONFLICT (referral_id) DO NOTHING`,
  )
    .bind(
      opts.referralId,
      opts.referrerId,
      opts.promotionId,
      JSON.stringify(opts.rewards),
      snapshot,
      now.toISOString(),
    )
    .run();

  const changed = Number(res.meta?.changes ?? 0);
  if (changed === 0) return null;

  const row = await env.DB.prepare(`SELECT id FROM referral_rewards WHERE referral_id = ?`)
    .bind(opts.referralId)
    .first<{ id: number }>();
  return row?.id ?? null;
}

/** 这个人的**所有**卡（含已领的，货架要显示"已领取（日期）"） */
export async function listRewardCards(
  env: Env,
  customerId: number,
  limit = 50,
): Promise<RewardCardRow[]> {
  const rows = await env.DB.prepare(
    `SELECT id, referrer_id, promotion_id, rewards_json, promotion_snapshot,
            state, claiming_at, claimed_at, granted_json, created_at
       FROM referral_rewards
      WHERE referrer_id = ?
      ORDER BY id DESC
      LIMIT ?`,
  )
    .bind(customerId, limit)
    .all<RewardCardRow>();
  return rows.results ?? [];
}

/** 读一张卡并确认**是这个人**的（不是他的 ⇒ 一律当不存在，避免泄露"这张卡存在"） */
export async function findRewardCard(
  env: Env,
  rewardId: number,
  customerId: number,
): Promise<RewardCardRow | null> {
  const row = await env.DB.prepare(
    `SELECT id, referrer_id, promotion_id, rewards_json, promotion_snapshot,
            state, claiming_at, claimed_at, granted_json, created_at
       FROM referral_rewards
      WHERE id = ? AND referrer_id = ?`,
  )
    .bind(rewardId, customerId)
    .first<RewardCardRow>();
  return row ?? null;
}

/**
 * 抢占位：`pending` 或**过期的 `claiming`** 才能拿下。
 *
 * 一条 UPDATE 完成"判状态 + 占位"，不先查后写 —— 先查后写会让两个并发请求
 * 都读到 `pending`，于是同一张卡发两份。
 *
 * @returns 抢到返回 true；别人正在领（未过期）返回 false
 */
export async function takeRewardCard(
  env: Env,
  rewardId: number,
  now: Date = new Date(),
): Promise<boolean> {
  const stale = new Date(now.getTime() - CLAIM_TAKEOVER_MS).toISOString();
  const res = await env.DB.prepare(
    `UPDATE referral_rewards
        SET state = 'claiming',
            claiming_at = CASE WHEN ? IS NULL THEN NULL ELSE ? END
      WHERE id = ?
        AND (state = 'pending' OR (state = 'claiming' AND claiming_at < ?))`,
  )
    .bind(now.toISOString(), now.toISOString(), rewardId, stale)
    .run();
  return Number(res.meta?.changes ?? 0) > 0;
}

/** 发放成功：落终态 + 记下**实际到账**（可能与配置不同） */
export async function settleRewardCard(
  env: Env,
  rewardId: number,
  opts: { granted: GiftRewards; now?: Date },
): Promise<void> {
  const now = opts.now ?? new Date();
  await env.DB.prepare(
    `UPDATE referral_rewards
        SET state = 'claimed', claimed_at = ?, claiming_at = NULL, granted_json = ?
      WHERE id = ?`,
  )
    .bind(now.toISOString(), JSON.stringify(opts.granted), rewardId)
    .run();
}

/** 发放失败：还回去（否则这张卡永远卡在 `claiming`，要等 5 分钟才可能被接管） */
export async function releaseRewardCard(env: Env, rewardId: number): Promise<void> {
  await env.DB.prepare(
    `UPDATE referral_rewards SET state = 'pending', claiming_at = NULL
      WHERE id = ? AND state = 'claiming'`,
  )
    .bind(rewardId)
    .run();
}
