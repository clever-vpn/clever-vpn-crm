/**
 * 兑换码（契约 §2.9.7）—— 用户自己输码换礼包权益
 *
 * 三条设计约束：
 *
 *   1. **码是分发方式，不是新物件**：直接复用 `promotions.code`（全表唯一），
 *      不建批次表。一码一渠道 = 建多个活动，核销数天然分开。
 *   2. **失败一律给整句理由**（`ok:false` + `reason`），与 `/quote` 的 `allowed:false`
 *      同口径 —— 码错了不是系统错误，不该让客户端当异常处理。
 *   3. **必须防撞库**：共享码是公开的，`A-Z0-9` 6 位可被穷举。同一客户每小时
 *      失败 5 次就锁。计数落在 `audit_log`（现成的表），不新增结构。
 */
import { lookupCode, normalizeCode } from "./codes";
import { grantGift } from "./gift";

import type { Env } from "../env";
import type { GiftRewards } from "./model";

/** 同一客户每小时的失败上限（超过 ⇒ 429） */
export const MAX_FAILED_ATTEMPTS = 5;
/** 码长下限：太短的码等于送（可穷举） */
export const MIN_CODE_LENGTH = 6;

/** 兑换结论。`ok:false` 一律 HTTP 200，只有限流才是 429。 */
export interface RedeemResult {
  ok: boolean;
  /** 兑换成功：礼包名（给客户端做"已到账：某某"的文案） */
  promotion_name?: string;
  applied?: GiftRewards;
  /** true = 本次用载体套餐新开户（客户原本没有订阅） */
  opened?: boolean;
  /** 兑换后的有效期；永久为 null */
  expires_at?: string | null;
  /** 兑换后的剩余流量（GB）；不限量 / 无订阅为 null */
  remaining_gb?: number | null;
  /** 失败原因（整句中文） */
  reason?: string;
}

export type RedeemOutcome =
  | { status: 200; body: RedeemResult }
  | { status: 429; body: { error: "too_many_attempts"; message: string; retry_after_s: number } };

const fail = (reason: string): RedeemOutcome => ({ status: 200, body: { ok: false, reason } });

/** 码归一：去空格 + 大写（粘贴常带空格/小写）。实现在 `./codes.ts`，这里转出。 */
export const normalizePromoCode = normalizeCode;

async function countRecentFailures(env: Env, customerId: number, since: Date): Promise<number> {
  const row = await env.DB.prepare(
    `SELECT COUNT(*) AS n FROM audit_log
      WHERE action = 'redeem_failed' AND target = ? AND at >= ?`,
  )
    .bind(`customer:${customerId}`, since.toISOString())
    .first<{ n: number }>();
  return Number(row?.n ?? 0);
}

async function recordFailure(env: Env, customerId: number, code: string, now: Date): Promise<void> {
  await env.DB.prepare(
    `INSERT INTO audit_log (at, actor, action, target, detail) VALUES (?, ?, 'redeem_failed', ?, ?)`,
  )
    .bind(
      now.toISOString(),
      `customer:${customerId}`,
      `customer:${customerId}`,
      // 只记前 3 位，避免把用户猜的完整码写进日志（也可能正是别人的有效码）
      JSON.stringify({ code_prefix: code.slice(0, 3) }),
    )
    .run();
}

async function recordSuccess(env: Env, customerId: number, code: string, now: Date): Promise<void> {
  await env.DB.prepare(
    `INSERT INTO audit_log (at, actor, action, target, detail) VALUES (?, ?, 'redeem_ok', ?, ?)`,
  )
    .bind(now.toISOString(), `customer:${customerId}`, `customer:${customerId}`, JSON.stringify({ code }))
    .run();
}

/** 兑换后的展示值（口径与 `/me` 一致） */
async function snapshot(env: Env, customerId: number): Promise<{ expires_at: string | null; remaining_gb: number | null }> {
  const row = await env.DB.prepare(
    `SELECT kind, expires_at, remaining_gb, quota_gb, balance_gb
       FROM platform_subscriptions WHERE customer_id = ?`,
  )
    .bind(customerId)
    .first<{
      kind: string;
      expires_at: string | null;
      remaining_gb: number | null;
      quota_gb: number | null;
      balance_gb: number | null;
    }>();
  if (!row) return { expires_at: null, remaining_gb: null };
  const remaining =
    row.kind === "traffic" ? row.remaining_gb : row.quota_gb === null ? null : row.quota_gb + (row.balance_gb ?? 0);
  return { expires_at: row.expires_at, remaining_gb: remaining };
}

/**
 * 兑换一个码。
 *
 * 顺序：限流检查 → 找活动 → 发放（内部含人群 / 次数 / 冷却 / 开户）→ 回报。
 * **失败先计数再返回**，保证猜码有成本。
 */
export async function redeemGiftCode(
  env: Env,
  opts: { customerId: number; code: string; now?: Date },
): Promise<RedeemOutcome> {
  const now = opts.now ?? new Date();
  const code = normalizePromoCode(opts.code);

  // ── 1) 防撞库：先看失败次数 ──
  const failures = await countRecentFailures(env, opts.customerId, new Date(now.getTime() - 3_600_000));
  if (failures >= MAX_FAILED_ATTEMPTS) {
    return {
      status: 429,
      body: {
        error: "too_many_attempts",
        message: "试得太频繁了，请 1 小时后再试",
        retry_after_s: 3600,
      },
    };
  }

  if (!code) return fail("请输入兑换码");
  if (code.length < MIN_CODE_LENGTH) {
    await recordFailure(env, opts.customerId, code, now);
    return fail("兑换码不对，请检查后重试");
  }

  // ── 2) 找活动：主码或批次码，且必须是「进行中的礼包」 ──
  const hit = await lookupCode(env, code);
  if (!hit || hit.promotion.kind !== "gift") {
    await recordFailure(env, opts.customerId, code, now);
    // 不区分"码不存在"与"活动已结束"：别让猜码的人拿到收敛信息
    return fail("兑换码不对，或者这个活动已经结束了");
  }

  // 码自己的额度与有效期（批次码一码一人，用完即失效）
  if (hit.expiresAt && Date.parse(hit.expiresAt) <= now.getTime()) {
    await recordFailure(env, opts.customerId, code, now);
    return fail("这个兑换码已经过期了");
  }
  if (hit.used >= hit.maxUses) {
    await recordFailure(env, opts.customerId, code, now);
    return fail("这个兑换码已经被领完了");
  }

  // ── 3) 发放（人群 / 次数 / 冷却 / 载体套餐开户都在 grantGift 里） ──
  const promo = hit.promotion;
  const grant = await grantGift(env, {
    promotionId: promo.id,
    customerId: opts.customerId,
    source: "redeem",
    now,
    codeId: hit.codeId,
  });
  if (!grant) return fail("兑换码不对，或者这个活动已经结束了");
  if (!grant.granted) return fail(grant.skipped ?? "这个兑换码现在不可用");

  await recordSuccess(env, opts.customerId, code, now);
  const view = await snapshot(env, opts.customerId);
  return {
    status: 200,
    body: {
      ok: true,
      promotion_name: promo.name,
      applied: grant.applied,
      opened: grant.opened ?? false,
      expires_at: view.expires_at,
      remaining_gb: view.remaining_gb,
    },
  };
}
