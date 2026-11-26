/**
 * 兑换码（契约 §2.9.7）—— 用户自己输码换礼包权益
 *
 * 三条设计约束：
 *
 *   1. **码是分发方式，不是新物件**：直接复用 `promotions.code`（全表唯一），
 *      不建批次表。一码一渠道 = 建多个活动，核销数天然分开。
 *   2. **失败一律给整句理由**（`ok:false` + `state` + `result_text`），与领取同形；
 *      同口径 —— 码错了不是系统错误，不该让客户端当异常处理。
 *   3. **必须防撞库**：共享码是公开的，`A-Z0-9` 6 位可被穷举。同一客户每小时
 *      失败 5 次就锁。计数落在 `audit_log`（现成的表），不新增结构。
 */
import { lookupCode, normalizeCode } from "./codes";
import { claimGiftFor } from "./gift";
import { EMPTY_REWARDS } from "./model";
import { customerSubscription } from "../subscriptions/store";

import type { Env } from "../env";
import type { GiftClaimState } from "./gift";
import type { GiftRewards } from "./model";

/** 同一客户每小时的失败上限（超过 ⇒ 429） */
export const MAX_FAILED_ATTEMPTS = 5;
/** 码长下限：太短的码等于送（可穷举） */
export const MIN_CODE_LENGTH = 6;

/** 兑换结论的状态：与礼包领取同一套词，外加一个"码本身不成立"。 */
export type RedeemState = GiftClaimState | "invalid_code";

/** 兑换结论。业务失败一律 HTTP 200；只有限流是 429。与 `/me/gifts/{id}/claim` 同形。 */
export interface RedeemResult {
  ok: boolean;
  state: RedeemState;
  /** 礼包名；`invalid_code` 时为 null */
  title: string | null;
  /** 直接给用户看的一句话（成功/失败都有） */
  result_text: string;
  /** @deprecated 旧站点 SDK 1.2.0 的兑换弹窗读 `promotion_name`；重发后删 */
  promotion_name?: string;
  /** @deprecated 旧站点 0 元开户提示读 `opened`；重发后删 */
  opened?: boolean;
  /** @deprecated 旧站点失败态读 `reason`；重发后删 */
  reason?: string;
  /** 实际到账的权益；失败时为 0 */
  applied: GiftRewards;
  /** 兑换后的有效期；永久为 null */
  expires_at: string | null;
  /** 兑换后的剩余流量（GB）；不限量 / 无订阅为 null */
  remaining_gb: number | null;
}

export type RedeemOutcome =
  | { status: 200; body: RedeemResult }
  | { status: 429; body: { error: { code: "too_many_attempts"; message: string }; retry_after_s: number } };

const fail = (reason: string, state: RedeemState = "invalid_code"): RedeemOutcome => ({
  status: 200,
  body: {
    ok: false,
    state,
    title: null,
    result_text: reason,
    // @deprecated 旧站点 SDK 1.2.0
    reason,
    applied: EMPTY_REWARDS,
    expires_at: null,
    remaining_gb: null,
  },
});

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
    // 只记前 3 位：完整码等同于一份可用的权益凭证，不进日志
    .bind(now.toISOString(), `customer:${customerId}`, `customer:${customerId}`, JSON.stringify({ code_prefix: code.slice(0, 3) }))
    .run();
}

/** 兑换后的展示值（口径与 `/me` 完全一致：period = 额度 + 额外池） */
async function snapshot(env: Env, customerId: number): Promise<{ expires_at: string | null; remaining_gb: number | null }> {
  const row = await env.DB.prepare(
    `SELECT kind, expires_at, traffic_remaining_gb, period_quota_gb, period_extra_gb
       FROM platform_subscriptions WHERE customer_id = ?`,
  )
    .bind(customerId)
    .first<{
      kind: string;
      expires_at: string | null;
      traffic_remaining_gb: number | null;
      period_quota_gb: number | null;
      period_extra_gb: number | null;
    }>();
  if (!row) return { expires_at: null, remaining_gb: null };
  const remaining =
    row.kind === "traffic"
      ? row.traffic_remaining_gb
      : row.period_quota_gb === null
        ? null
        : row.period_quota_gb + (row.period_extra_gb ?? 0);
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
        error: { code: "too_many_attempts", message: "试得太频繁了，请 1 小时后再试" },
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

  // ── 3) 发放（人群 / 次数 / 冷却 / 载体套餐开户都在 `claimGiftFor` 里）──
  // 输码**本身就是**一次领取：用户已经在"拉"了，
  // 他要知道的结果（拿到了什么 / 为什么不行）必须当场返回，
  // 所以走同一个 `claimGiftFor`，只是多带一个 `codeId`。
  const promo = hit.promotion;
  // 领之前有没有订阅 —— 用来告诉前端"这次是给你新开的户"
  const hadSub = Boolean(await customerSubscription(env, opts.customerId));
  const grant = await claimGiftFor(env, {
    promotionId: promo.id,
    customerId: opts.customerId,
    now,
    codeId: hit.codeId,
  });
  if (grant.state === "not_found") return fail("兑换码不对，或者这个活动已经结束了", "invalid_code");
  if (grant.state !== "granted") return fail(grant.message, grant.state);

  await recordSuccess(env, opts.customerId, code, now);
  const view = await snapshot(env, opts.customerId);
  const head = hadSub
    ? `「${promo.name}」已到账`
    : `「${promo.name}」已到账，并为你开通了体验套餐`;
  return {
    status: 200,
    body: {
      ok: true,
      state: "granted",
      title: promo.name,
      result_text: `${head}，可以在「我的订阅」里看到`,
      // @deprecated 旧站点 SDK 1.2.0
      promotion_name: promo.name,
      opened: !hadSub,
      applied: grant.applied,
      expires_at: view.expires_at,
      remaining_gb: view.remaining_gb,
    },
  };
}
