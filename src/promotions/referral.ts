/**
 * 邀请码（**关系层**）—— 唯一归因来源
 *
 * 契约：`app-crm.md` §2.9.1 / §2.9.3；设计取舍见 `docs/promotion.md` §1–§2。
 *
 * 三条必须守住的边界：
 *   1. **永远不必填**：用户刚装完 App，没有义务输码；输错/输不存在的码一律**静默忽略**，
 *      绝不能因为一个选填字段把注册挡下来。
 *   2. **只在建号那一刻生效**：已注册用户再次传码不报错、也不改关系。
 *   3. **奖励只给权益**（天数 / 流量），不给现金 —— 避免佣金提现那套合规问题。
 *
 * 奖励给的是**推荐人**，触发条件是**被邀请人首单支付成功**（未付款不结奖，防刷）。
 */
import { PROMOTION_COLUMNS, rowToPromotion } from "./model";
import { provisionSubscription } from "../platform/provision";
import { customerSubscription, logChange, upsertSubscription } from "../subscriptions/store";

import type { Env } from "../env";
import type { Promotion, PromotionRow } from "./model";
import type { Subscription } from "../plans/subscription";

/**
 * 去掉 I / O / 0 / 1：邀请码要靠人念、靠手输，形近字符必须排除。
 * 32^8 ≈ 1.1e12，小体量租户不会撞码（撞了也有唯一索引兜底）。
 */
const CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
const CODE_LENGTH = 8;

function randomCode(length = CODE_LENGTH): string {
  const bytes = new Uint8Array(length);
  crypto.getRandomValues(bytes);
  let out = "";
  for (const b of bytes) out += CODE_ALPHABET[b % CODE_ALPHABET.length];
  return out;
}

/** 码归一：去空格 + 大写（输入框里粘贴常带空格/小写） */
export function normalizeReferralCode(raw: unknown): string {
  return typeof raw === "string" ? raw.trim().toUpperCase() : "";
}

/**
 * 拿到（必要时生成）这个用户的邀请码。
 *
 * 懒生成而非注册即生成：绝大多数用户从不分享，没必要给每行都写一个码；
 * 而且老用户（码列为空）也能自然获得。
 */
export async function ensureReferralCode(env: Env, customerId: number): Promise<string | null> {
  const row = await env.DB.prepare(`SELECT referral_code FROM customers WHERE id = ?`)
    .bind(customerId)
    .first<{ referral_code: string | null }>();
  if (!row) return null;
  if (row.referral_code) return row.referral_code;

  for (let attempt = 0; attempt < 5; attempt++) {
    const code = randomCode();
    const taken = await env.DB.prepare(`SELECT 1 AS x FROM customers WHERE referral_code = ?`)
      .bind(code)
      .first<{ x: number }>();
    if (taken) continue;
    // 条件更新：并发下只有一个人能写上
    await env.DB.prepare(
      `UPDATE customers SET referral_code = ? WHERE id = ? AND referral_code IS NULL`,
    )
      .bind(code, customerId)
      .run();
    const saved = await env.DB.prepare(`SELECT referral_code FROM customers WHERE id = ?`)
      .bind(customerId)
      .first<{ referral_code: string | null }>();
    if (saved?.referral_code) return saved.referral_code;
  }
  return null;
}

/** 当前生效的邀请活动（最近创建的那个）；没有就返回 null（只记关系，不发奖励） */
async function activeReferralPromotion(env: Env): Promise<Promotion | null> {
  const row = await env.DB.prepare(
    `SELECT ${PROMOTION_COLUMNS} FROM promotions
      WHERE kind = 'referral' AND status = 'active' ORDER BY id DESC LIMIT 1`,
  ).first<PromotionRow>();
  return row ? rowToPromotion(row) : null;
}

/**
 * 绑定邀请关系（幂等 + 全静默）。
 *
 * @returns 真的建立了关系才 `true`；已绑定 / 码不存在 / 自己邀自己 / 码为空 → `false`
 */
export async function bindReferral(
  env: Env,
  opts: { customerId: number; code: unknown; now?: Date },
): Promise<boolean> {
  const code = normalizeReferralCode(opts.code);
  if (!code) return false;

  const existing = await env.DB.prepare(`SELECT 1 AS x FROM referrals WHERE customer_id = ?`)
    .bind(opts.customerId)
    .first<{ x: number }>();
  if (existing) return false;

  const referrer = await env.DB.prepare(
    `SELECT id FROM customers WHERE referral_code = ? AND id <> ?`,
  )
    .bind(code, opts.customerId)
    .first<{ id: number }>();
  if (!referrer) return false;

  const promo = await activeReferralPromotion(env);
  await env.DB.prepare(
    `INSERT OR IGNORE INTO referrals (customer_id, referrer_id, promotion_id, code, created_at)
     VALUES (?, ?, ?, ?, ?)`,
  )
    .bind(opts.customerId, referrer.id, promo?.id ?? null, code, (opts.now ?? new Date()).toISOString())
    .run();
  return true;
}

export interface ReferralPanel {
  /** 我的邀请码；生成失败（极罕见）时为 null */
  code: string | null;
  /** 已成功邀请且完成首单的人数 */
  invited: number;
  /** 累计获得的天数 / GB（权益型奖励，不含现金） */
  reward_days: number;
  reward_gb: number;
}

/** `/me.referral`：官网与 App 共用同一块面板（契约 §2.9.3） */
export async function referralPanel(env: Env, customerId: number): Promise<ReferralPanel> {
  const code = await ensureReferralCode(env, customerId);
  const stats = await env.DB.prepare(
    `SELECT
       SUM(CASE WHEN rewarded_at IS NOT NULL THEN 1 ELSE 0 END) AS invited,
       SUM(CASE WHEN reward_type = 'days' THEN reward_value ELSE 0 END) AS reward_days,
       SUM(CASE WHEN reward_type = 'gb' THEN reward_value ELSE 0 END) AS reward_gb
     FROM referrals WHERE referrer_id = ?`,
  )
    .bind(customerId)
    .first<{ invited: number | null; reward_days: number | null; reward_gb: number | null }>();

  return {
    code,
    invited: Number(stats?.invited ?? 0),
    reward_days: Number(stats?.reward_days ?? 0),
    reward_gb: Number(stats?.reward_gb ?? 0),
  };
}

export interface ReferralReward {
  referrer_id: number;
  type: "days" | "gb" | "none";
  value: number;
  /** 是否真的写到了推荐人的订阅上（false = 推荐人没有订阅，只留痕） */
  applied: boolean;
}

async function markRewarded(
  env: Env,
  referralId: number,
  type: "days" | "gb" | "none",
  value: number,
  now: Date,
): Promise<void> {
  await env.DB.prepare(
    `UPDATE referrals SET rewarded_at = ?, reward_type = ?, reward_value = ?
      WHERE id = ? AND rewarded_at IS NULL`,
  )
    .bind(now.toISOString(), type, value, referralId)
    .run();
}

/**
 * 被邀请人**首单支付成功**后给推荐人发奖。
 *
 * 幂等：`referrals.rewarded_at` 只有第一次能写成功（带 `IS NULL` 条件）。
 * 不是首单 ⇒ 记 `none` 收尾，避免每次续费都重新判定。
 *
 * @returns 没绑定关系（或已经发过）时返回 `null`
 */
export async function rewardReferrer(
  env: Env,
  opts: { referredCustomerId: number; orderId: number; now?: Date },
): Promise<ReferralReward | null> {
  const now = opts.now ?? new Date();
  const ref = await env.DB.prepare(
    `SELECT id, referrer_id, promotion_id FROM referrals
      WHERE customer_id = ? AND rewarded_at IS NULL`,
  )
    .bind(opts.referredCustomerId)
    .first<{ id: number; referrer_id: number; promotion_id: number | null }>();
  if (!ref) return null;

  // 首单判定：除本单外不能再有成功的收款
  const other = await env.DB.prepare(
    `SELECT 1 AS x FROM orders
      WHERE customer_id = ? AND id <> ?
        AND status IN ('paid', 'provisioning', 'active', 'refunded') LIMIT 1`,
  )
    .bind(opts.referredCustomerId, opts.orderId)
    .first<{ x: number }>();
  if (other) {
    await markRewarded(env, ref.id, "none", 0, now);
    return null;
  }

  const promo = ref.promotion_id
    ? await env.DB.prepare(`SELECT ${PROMOTION_COLUMNS} FROM promotions WHERE id = ?`)
      .bind(ref.promotion_id)
      .first<PromotionRow>()
    : null;
  const type = (promo?.referrer_reward_type as ReferralReward["type"] | null) ?? "none";
  const value = promo?.referrer_reward_value ?? 0;

  if (type !== "days" && type !== "gb") {
    await markRewarded(env, ref.id, "none", 0, now);
    return { referrer_id: ref.referrer_id, type: "none", value: 0, applied: false };
  }
  if (!(value > 0)) {
    await markRewarded(env, ref.id, type, 0, now);
    return { referrer_id: ref.referrer_id, type, value: 0, applied: false };
  }

  const before = await customerSubscription(env, ref.referrer_id);
  if (!before) {
    // 推荐人自己没订阅：先把奖励记在案上（客服可手工补），不要静默吞掉
    await markRewarded(env, ref.id, type, value, now);
    return { referrer_id: ref.referrer_id, type, value, applied: false };
  }

  const after: Subscription =
    type === "days"
      ? {
          ...before,
          // 永不过期（expires_at = null）不动：给期限没意义
          expires_at: before.expires_at
            ? new Date(Date.parse(before.expires_at) + value * 86_400_000).toISOString()
            : null,
        }
      : {
          ...before,
          balance_gb: (before.balance_gb ?? 0) + value,
          remaining_gb: before.remaining_gb === null ? null : before.remaining_gb + value,
        };

  const id = await upsertSubscription(env, after);
  await logChange(env, {
    customer_id: ref.referrer_id,
    subscription_id: id,
    action: "gift",
    before,
    after: { ...after, id },
    detail: { source: "referral", referral_id: ref.id, type, value, referred_customer_id: opts.referredCustomerId },
  });
  await markRewarded(env, ref.id, type, value, now);

  // 落账到 cf-api：送的是天数 ⇒ expire_date，送的是流量 ⇒ traffic_balance
  try {
    await provisionSubscription(env, { ...after, id });
  } catch (e) {
    // 本地账已经记了；落账失败由结算/重试任务补齐，不把回调打挂
    console.error(`[referral] 推荐人奖励落账失败 referrer=${ref.referrer_id}: ${e instanceof Error ? e.message : e}`);
  }

  return { referrer_id: ref.referrer_id, type, value, applied: true };
}
