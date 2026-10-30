/**
 * 礼包发放（**权益层**）—— 契约 `app-crm.md` §2.9.6
 *
 * 与优惠券的区别只有一句：优惠券少收钱，礼包改权益。所以这里
 * **一分钱都不碰**（`benefit_value` 恒 0），只动订阅的 `expires_at` / `period_extra_gb` /
 * `traffic_total_gb`+`traffic_remaining_gb`。
 *
 * 四条硬规则：
 *   1. **必须有地方放**：有订阅 ⇒ 加到订阅上；没订阅 ⇒ 用礼包的「载体套餐」0 元开户。
 *   2. **两个维度互相独立，而且都是「加」不是「替换」**：送天数是在**原到期日**上加、送 GB 是在
 *      **原余额**上加，谁也不推谁、谁也不会把套餐自带的期限/流量拿掉。
 *      **不提供 "重置本月已用"** —— 那等于把已消费的流量变回额度，是改账不是送礼。
 *   3. **订阅没有这个权益就不改**：无限期（`expires_at = null`）不收天数、
 *      不限量（period 的 `period_quota_gb = null` / traffic 的 `traffic_total_gb = null`）
 *      不收 GB —— 两项都不适用就直接跳过，连 0 元订单都不建。
 *   4. **一次发放 = 一张 0 元已付订单**，且幂等靠次数与冷却（`max_uses_per_customer`
 *      + `cooldown_hours` 在发放前判定）：否则财务侧永远解释不了"这个人为什么多了 7 天"。
 */
import { EMPTY_REWARDS, PROMOTION_COLUMNS, hasRewards, normalizeRewards, rowToPromotion } from "./model";
import { CLAIM_LOCK_MS, claimDeadline, claimView } from "./claim";
import { releaseRedemption, reserveRedemption, settleRedemption } from "./redemption";
import { checkForCustomer } from "./service";
import { provisionSubscription } from "../platform/provision";
import {
  applicableAdditive,
  applyAdditive,
  pushAdditive,
} from "../subscriptions/entitlement";
import {
  customerSubscription,
  freshenTraffic,
  logChange,
  upsertSubscription,
} from "../subscriptions/store";
import { rowToPlan } from "../plans/model";
import { subscriptionFromPlan } from "../plans/subscription";

import type { Env } from "../env";
import type { GiftClaimStatus, GiftClaimView } from "./claim";
import type { GiftRewards, Promotion, PromotionRow } from "./model";
import type { Plan, PlanRow } from "../plans/model";
import type { Subscription } from "../plans/subscription";

const DAY_MS = 86_400_000;

/** 发放来源：注册即送 / 到期前挽回 / 后台手动 / 用户自己输码 */
export type GiftSource = "signup" | "expiring" | "manual" | "redeem";

export interface GiftGrant {
  promotion_id: number;
  customer_id: number;
  /** 是否真的写到了订阅上 */
  granted: boolean;
  /** `true` = 本次是用载体套餐新开的订阅（客户原本没有订阅） */
  opened?: boolean;
  /** 没发出去的原因（给后台看的中文整句） */
  skipped: string | null;
  /** 0 元订单号；没发出去为 null */
  order_id: number | null;
  applied: GiftRewards;
}

function orderCode(now: Date, customerId: number): string {
  // 时间戳 + 客户号 + 3 位随机：人可读、可追溯。
  // **随机后缀是必须的** —— 同一客户在同一秒内收到两个礼包（比如注册礼包 + 立刻兑换）
  // 会撞 `orders.code` 的唯一约束。
  const stamp = now.toISOString().replace(/\D/g, "").slice(0, 14);
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  const bytes = new Uint8Array(3);
  crypto.getRandomValues(bytes);
  let suffix = "";
  for (const b of bytes) suffix += alphabet[b % alphabet.length];
  return `G${stamp}${String(customerId).padStart(6, "0")}${suffix}`;
}

/**
 * 一张 0 元、直接“已支付”的订单 —— 礼包的账簿凭证。
 *
 * `source='gift'`：统计里与真实销售分开；`payment_method='gift'`：
 * 永远不会进对账（没有渠道流水）。
 */
async function createGiftOrder(
  env: Env,
  promo: Promotion,
  customerId: number,
  now: Date,
): Promise<number> {
  const iso = now.toISOString();
  const res = await env.DB.prepare(
    `INSERT INTO orders (code, customer_id, plan_id, kind, plan_snapshot, amount_minor,
       discount_minor, promotion_id, currency, source, payment_method, entry, status,
       paid_at, note, created_at, updated_at)
     VALUES (?, ?, ?, 'addon', ?, 0, 0, ?, 'CNY', 'gift', 'gift', 'admin', 'paid', ?, ?, ?, ?)`,
  )
    .bind(
      orderCode(now, customerId),
      customerId,
      `gift:${promo.id}`,
      JSON.stringify({ gift: promo.name, promotion_id: promo.id, rewards: promo.rewards }),
      promo.id,
      iso,
      `礼包「${promo.name}」`,
      iso,
      iso,
    )
    .run();
  return Number(res.meta.last_row_id ?? 0);
}

/**
 * 这份订阅**能收下**哪些奖励 —— 不适用的维度归 0。
 *
 * 实现与"管理员直接调整"共用（`subscriptions/entitlement.ts`）：无限期不收天数、
 * 不限量不收 GB，两个维度互不牵连。
 */
export const applicableRewards = applicableAdditive;

/**
 * 把奖励项作用到**已有订阅**上，并落账到 cf-api。
 *
 * 调用方必须先确认订阅存在、且 `applied` 已经过 `applicableRewards` 过滤
 * （全 0 时不该走到这里）—— 这里不再判空，以免"先建单、后发现没订阅"留下无主订单。
 */
async function applyGift(
  env: Env,
  opts: {
    before: Subscription;
    /** 已经过滤过"这份订阅收不收得下"的奖励 */
    applied: GiftRewards;
    promotionId: number;
    orderId: number;
    source: GiftSource;
    /** 已落账时的平台真实剩余（GB）；未落账传 undefined */
    platformRemainingGb?: number | null;
  },
): Promise<{ subscriptionId: number; applied: GiftRewards }> {
  const before = opts.before;
  const customerId = before.customer_id;

  // 加天数 / 加流量：与"管理员直接调整"共用同一份实现（见 entitlement.ts）
  const next = applyAdditive(before, opts.applied, {
    platformRemainingGb: opts.platformRemainingGb,
  });

  const id = await upsertSubscription(env, next);
  const after = { ...next, id };

  await logChange(env, {
    customer_id: customerId,
    subscription_id: id,
    action: "gift",
    before,
    after,
    detail: {
      source: opts.source,
      promotion_id: opts.promotionId,
      order_id: opts.orderId,
      rewards: opts.applied,
    },
  });

  try {
    await pushAdditive(env, after, opts.applied, opts.platformRemainingGb, next.expires_at);
  } catch (e) {
    // 本地账已记；推特失败交给月结/人工补齐，不影响发放结论
    console.error(
      `[gift] 落账失败 customer=${customerId} promo=${opts.promotionId}: ${e instanceof Error ? e.message : e}`,
    );
  }

  return { subscriptionId: id, applied: opts.applied };
}

/**
 * 读礼包的**载体套餐**（客户还没有订阅时用它 0 元开户）。
 *
 * 语义分工：**套餐管"是什么包"**（流量 / 线路 / 设备数），
 * **礼包管"再多送多少"**（`rewards.days` / `rewards.gb`，都是在套餐基础上**累加**
 * 而不是覆盖）—— 与 XBoard 的 `plan_id` + `plan_validity_days` 同一个道理。
 *
 * 只允许 `visibility='hidden'` 的套餐：公开套餐能被直接买到，
 * 拿它当载体等于开了个 0 元购买通道。
 *
 * @returns `null` = 不可用（不存在 / 不是 hidden / 已下架 / 是加购包）
 */
async function loadCarrierPlan(env: Env, planId: string): Promise<Plan | null> {
  const row = await env.DB.prepare(
    `SELECT id, name, kind, price_minor, currency, licence_limit, term_days, monthly_quota_gb,
       traffic_gb, validity_days, line_ids, up_mbps, down_mbps, sales_channels,
       store_product_id, sort_order, status, retired_at, trial, visibility
     FROM plans WHERE id = ?`,
  )
    .bind(planId)
    .first<PlanRow & { visibility: string }>();
  if (!row) return null;
  if (row.visibility !== "hidden" || row.status !== "active") return null;

  const plan = rowToPlan(row);
  if (plan.kind === "addon") return null; // 加购包不产生订阅
  return plan;
}

/**
 * 用载体套餐 0 元开户，并把已经过滤过的奖励叠上去。
 *
 * `base` 由调用方算好（同一份快照也用来判断"礼包对它有没有意义"），
 * 这里只负责落库与落账。
 */
async function openFromCarrierPlan(
  env: Env,
  opts: {
    planId: string;
    /** 已算好的骨架快照（同一份也用来判断礼包对它有没有意义） */
    base: Omit<Subscription, "id">;
    /** 已经过 `applicableRewards` 过滤 */
    applied: GiftRewards;
    promotionId: number;
    orderId: number;
    source: GiftSource;
  },
): Promise<{ subscriptionId: number; applied: GiftRewards }> {
  const { base, applied } = opts;
  const customerId = base.customer_id;

  // 0 元开户：套餐给骨架，礼包在**它之上累加**（不是覆盖）——
  // 载体套餐自己有 30 天、礼包再送 7 天，用户拿到的是 37 天。
  const next = applyAdditive({ ...base, id: 0 }, applied);

  const id = await upsertSubscription(env, next);
  const after = { ...next, id };

  await logChange(env, {
    customer_id: customerId,
    subscription_id: id,
    action: "new",
    before: null,
    after,
    paid_minor: 0,
    detail: {
      source: opts.source,
      promotion_id: opts.promotionId,
      order_id: opts.orderId,
      carrier_plan_id: opts.planId,
      rewards: opts.applied,
    },
  });

  try {
    // 新开户要**建客户**，所以走全量落账（此时平台上还没有已用量，`额度 + 池子` 就是对的）
    await provisionSubscription(env, after);
  } catch (e) {
    console.error(
      `[gift] 开户落账失败 customer=${customerId} plan=${opts.planId}: ${e instanceof Error ? e.message : e}`,
    );
  }

  return { subscriptionId: id, applied: opts.applied };
}

/**
 * 给一个客户发一个礼包。
 *
 * 幂等：先过 `checkForCustomer`（含次数上限与冷却），通过了才建单发放。
 * 重复调用（手抖点两次、注册流程重放）第二次会被 `max_uses_per_customer` 挡下。
 */
export async function grantGift(
  env: Env,
  opts: {
    promotionId: number;
    customerId: number;
    source: GiftSource;
    now?: Date;
    assumeFirstPurchase?: boolean;
    /** 命中的批次码 id（`promotion_codes.id`）；用主码 / 系统发放时为 null */
    codeId?: number | null;
    /**
     * 跳过「人群 / 时间窗 / 名额 / 冷却」重判。
     *
     * 只给**领取待领券**用：券送达那一刻已经判过一次，那张券就是按他当时的身份点名的。
     * 用户晚两天回来领，不该因为期间付过费（`audience='new'` 不再成立）而领不到。
     * 幂等仍然由「券本身只有一张 + 状态只能从 pending 跳一次」保证。
     */
    skipCheck?: boolean;
  },
): Promise<GiftGrant | null> {
  const now = opts.now ?? new Date();
  const row = await env.DB.prepare(`SELECT ${PROMOTION_COLUMNS} FROM promotions WHERE id = ?`)
    .bind(opts.promotionId)
    .first<PromotionRow>();
  if (!row) return null;
  const promo = rowToPromotion(row);
  if (promo.kind !== "gift") return null;

  const skip = (reason: string): GiftGrant => ({
    promotion_id: promo.id,
    customer_id: opts.customerId,
    granted: false,
    skipped: reason,
    order_id: null,
    applied: EMPTY_REWARDS,
  });

  // 领取待领券时不重判人群（见 opts.skipCheck）：那张券是按当时身份点名的
  if (!opts.skipCheck) {
    const check = await checkForCustomer(env, promo, opts.customerId, now, {
      assumeFirstPurchase: opts.assumeFirstPurchase ?? opts.source === "signup",
    });
    if (!check.ok) return skip(check.reason);
  }

  // 有没有"地方可放"：有订阅 → 加权益；没有订阅 → 看礼包有没有配载体套餐。
  const before = await customerSubscription(env, opts.customerId);

  let plan: Plan | null = null;
  if (!before) {
    if (!promo.plan_id) {
      return skip("还需要先有套餐；这个兑换码没有配置体验套餐，请联系客服");
    }
    plan = await loadCarrierPlan(env, promo.plan_id);
    if (!plan) return skip("礼包的体验套餐已不可用，请联系客服");
  }

  // 先算出"目标订阅快照"，再判断礼包**对它有没有意义**：
  // 无限期不收天数、不限量不收 GB。两条都不适用就**不发放、也不建 0 元订单**。
  const target =
    before ??
    subscriptionFromPlan(plan as Plan, { customerId: opts.customerId, paidMinor: 0, now });
  const appliedRewards = applicableRewards(target, promo.rewards);
  if (!hasRewards(appliedRewards)) {
    return skip("这个礼包送的内容对当前套餐不适用（不限量 / 无限期），未发放");
  }

  // 送 GB 必须落在**平台真实剩余**上：先回源，读不到就不发 ——
  // 拿旧缓存去加，会把用户这段时间用掉的流量又还回去。
  let platformRemainingGb: number | undefined;
  if (appliedRewards.gb > 0 && before?.platform_customer_id) {
    const fresh = await freshenTraffic(env, before);
    if (!fresh || fresh.traffic_remaining_gb === null) {
      return skip("平台的剩余流量暂时读不到，礼包稍后再发");
    }
    platformRemainingGb = fresh.traffic_remaining_gb;
  }

  // ── 先占位、再发放 ──
  // 校验都做完了（上面全是只读判断），从这里开始才动钱。占位这一行本身就是
  // "这次核销"的唯一凭证：`(promotion_id, customer_id)` 唯一 ⇒ 崩溃后重跑、
  // 并发双击、批量任务重入，都只会有一份额度（见 `redemption.ts`）。
  const reservation = await reserveRedemption(env, {
    promotionId: promo.id,
    customerId: opts.customerId,
    codeId: opts.codeId ?? null,
    now,
  });
  if (!reservation.ok) return skip(reservation.reason);

  let orderId = 0;
  try {
    orderId = await createGiftOrder(env, promo, opts.customerId, now);

    let result: { subscriptionId: number; applied: GiftRewards };
    let opened = false;
    if (before) {
      result = await applyGift(env, {
        before,
        applied: appliedRewards,
        promotionId: promo.id,
        orderId,
        source: opts.source,
        platformRemainingGb,
      });
    } else {
      result = await openFromCarrierPlan(env, {
        planId: promo.plan_id as string,
        base: target,
        applied: appliedRewards,
        promotionId: promo.id,
        orderId,
        source: opts.source,
      });
      opened = true;
    }
    const applied = result;

    // 回填订单号与**实际生效**的权益（不是配置值：不限量/无限期时可能少一项）
    await settleRedemption(env, reservation.id, orderId, applied.applied);

    return {
      promotion_id: promo.id,
      customer_id: opts.customerId,
      granted: true,
      opened,
      skipped: null,
      order_id: orderId,
      applied: applied.applied,
    };
  } catch (e) {
    // 发放没走完 ⇒ 把占位还回去（不删的话这个人永远领不到：唯一索引挡着）
    await releaseRedemption(env, reservation.id);
    throw e;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// 待领取（`promotions.delivery = 'claim'`）
//
//   券先送到手里（`promotion_claims`），用户在有效期内**自己点一下**才真正到账。
//   为什么要这样：直接改账用户感知不到 —— 到期日悄悄延长 10 天，用户直到某天发现
//   "居然还能用"才隐约感觉到，那不是营销，是没人知道的善意。必须有个"领取"动作，
//   福利才变成用户看得见、记得住、会跟人说的事。
//
//   这里只做三件事：建券 / 领券 / 列券。权益怎么加仍然只有 `grantGift` 一份实现 ——
//   待领取只是"送达"，不是第二套发放逻辑。
// ─────────────────────────────────────────────────────────────────────────────

interface ClaimRecord {
  id: number;
  promotion_id: number;
  customer_id: number;
  status: string;
  source: string;
  created_at: string;
  expires_at: string;
  claimed_at: string | null;
  order_id: number | null;
  granted_json: string;
}

const CLAIM_COLUMNS = `id, promotion_id, customer_id, status, source, created_at, expires_at,
  claimed_at, order_id, granted_json`;

/** 配送结论：`pending = true` 表示券已送出、权益**还没**到账（等用户领） */
export interface GiftDelivery extends GiftGrant {
  pending?: boolean;
  claim_id?: number | null;
  /** 这张券的领取截止时间 */
  claim_expires_at?: string | null;
}

/** 用户点「领取」的结果 */
export interface ClaimResult {
  ok: boolean;
  /** 失败原因（中文整句，App 直接显示） */
  reason: string | null;
  /** missing = 这张券不存在（或不属于当前用户） */
  status: GiftClaimStatus | "missing";
  /** 真正到账的权益 */
  applied?: GiftRewards;
  /** 领完之后这张券长什么样 */
  gift: GiftClaimView | null;
}

/**
 * 给一个客户**发券**（不发权益）。
 *
 * 判断顺序与直接发放完全一致 —— 人群 / 名额 / 时间窗先过一遍，
 * 再确认"这份订阅收不收得下"（无限期不收天数、不限量不收 GB）。
 * 收不下就**连券都不发**，免得用户看到一张永远领不掉的卡。
 */
async function offerGift(
  env: Env,
  opts: { promo: Promotion; customerId: number; source: GiftSource; now: Date },
): Promise<GiftDelivery> {
  const { promo, customerId, source, now } = opts;
  const skip = (reason: string): GiftDelivery => ({
    promotion_id: promo.id,
    customer_id: customerId,
    granted: false,
    pending: false,
    skipped: reason,
    order_id: null,
    applied: EMPTY_REWARDS,
    claim_id: null,
    claim_expires_at: null,
  });

  const check = await checkForCustomer(env, promo, customerId, now, {
    assumeFirstPurchase: source === "signup",
  });
  if (!check.ok) return skip(check.reason);

  const before = await customerSubscription(env, customerId);
  let target: Subscription | Omit<Subscription, "id">;
  if (before) {
    target = before;
  } else {
    if (!promo.plan_id) {
      return skip("还需要先有套餐；这个礼包没有配置体验套餐，请联系客服");
    }
    const plan = await loadCarrierPlan(env, promo.plan_id);
    if (!plan) return skip("礼包的体验套餐已不可用，请联系客服");
    target = subscriptionFromPlan(plan, { customerId, paidMinor: 0, now });
  }
  const willApply = applicableRewards(target, promo.rewards);
  if (!hasRewards(willApply)) {
    return skip("这个礼包送的内容对当前套餐不适用（不限量 / 无限期），未发放");
  }

  const nowIso = now.toISOString();
  const deadline = claimDeadline(promo, now).toISOString();

  // 同一活动对同一个人只留一张：重复触发只**刷新截止时间**；
  // 已领取的绝不回退（`WHERE status != 'claimed'`）。
  await env.DB.prepare(
    `INSERT INTO promotion_claims
       (promotion_id, customer_id, status, source, created_at, expires_at, granted_json)
     VALUES (?, ?, 'pending', ?, ?, ?, '{}')
     ON CONFLICT(promotion_id, customer_id) DO UPDATE SET
       status = 'pending', source = excluded.source, created_at = excluded.created_at,
       expires_at = excluded.expires_at, claimed_at = NULL
     WHERE promotion_claims.status != 'claimed'`,
  )
    .bind(promo.id, customerId, source, nowIso, deadline)
    .run();

  const claim = await env.DB.prepare(
    `SELECT ${CLAIM_COLUMNS} FROM promotion_claims WHERE promotion_id = ? AND customer_id = ?`,
  )
    .bind(promo.id, customerId)
    .first<ClaimRecord>();
  if (!claim) return skip("待领取凭证写入失败，请稍后再试");
  if (claim.status === "claimed") return skip("这个礼包已经领过了，权益已到账");

  return {
    promotion_id: promo.id,
    customer_id: customerId,
    granted: false,
    pending: true,
    skipped: null,
    order_id: null,
    // 券上写的是"领了能得到什么"（按当前订阅裁过，与真正发放时的口径一致）
    applied: willApply,
    claim_id: claim.id,
    claim_expires_at: claim.expires_at,
  };
}

/**
 * 按活动配置把礼包**送出去** —— 所有触发点（注册 / 到期挽回 / 后台点名）都走这里。
 *
 * `delivery = 'auto'`  ⇒ 直接到账（返回的就是 `grantGift` 的结论）
 * `delivery = 'claim'` ⇒ 只发一张券，权益等用户自己来领
 */
export async function deliverGift(
  env: Env,
  opts: {
    promotionId: number;
    customerId: number;
    source: GiftSource;
    now?: Date;
    assumeFirstPurchase?: boolean;
    codeId?: number | null;
  },
): Promise<GiftDelivery | null> {
  const now = opts.now ?? new Date();
  const row = await env.DB.prepare(`SELECT ${PROMOTION_COLUMNS} FROM promotions WHERE id = ?`)
    .bind(opts.promotionId)
    .first<PromotionRow>();
  if (!row) return null;
  const promo = rowToPromotion(row);
  if (promo.kind !== "gift") return null;

  if (promo.delivery !== "claim") return grantGift(env, opts);
  return offerGift(env, { promo, customerId: opts.customerId, source: opts.source, now });
}

/**
 * 用户点「领取」。
 *
 * 并发保护靠**状态机**而不是锁：`pending → claiming` 是一次带条件的 UPDATE，
 * `changes = 0` 就说明别人（另一个设备 / 手抖两次）已经抢到了。
 * 领取途中失败（平台余额读不到等）就把券**还回 pending**，用户能再试一次 —— 券不该因为
 * 一次网络抖动就消失。占位超过 `CLAIM_LOCK_MS` 视为那次失败（进程被杀也能自愈）。
 */
export async function claimGift(
  env: Env,
  opts: { customerId: number; claimId: number; now?: Date },
): Promise<ClaimResult> {
  const now = opts.now ?? new Date();
  const nowIso = now.toISOString();

  const claim = await env.DB.prepare(
    `SELECT ${CLAIM_COLUMNS} FROM promotion_claims WHERE id = ? AND customer_id = ?`,
  )
    .bind(opts.claimId, opts.customerId)
    .first<ClaimRecord>();
  if (!claim) return { ok: false, reason: "这张券不存在", status: "missing", gift: null };

  const row = await env.DB.prepare(`SELECT ${PROMOTION_COLUMNS} FROM promotions WHERE id = ?`)
    .bind(claim.promotion_id)
    .first<PromotionRow>();
  if (!row) return { ok: false, reason: "这个活动已经不存在了", status: "missing", gift: null };
  const promo = rowToPromotion(row);
  const view = claimView(claim, promo, now);

  if (claim.status === "claimed") {
    return { ok: false, reason: "已经领过了，权益已到账", status: "claimed", gift: view };
  }
  if (view.status === "expired") {
    return { ok: false, reason: "这张券已经过期了", status: "expired", gift: view };
  }

  // 抢券：只有一张、只能从 pending（或超时的 claiming）跳一次
  const staleBefore = new Date(now.getTime() - CLAIM_LOCK_MS).toISOString();
  const lock = await env.DB.prepare(
    `UPDATE promotion_claims SET status = 'claiming', claimed_at = ?
      WHERE id = ? AND customer_id = ?
        AND (status = 'pending' OR (status = 'claiming' AND claimed_at < ?))`,
  )
    .bind(nowIso, claim.id, opts.customerId, staleBefore)
    .run();
  if (!lock.meta.changes) {
    return { ok: false, reason: "正在处理中，请稍后再看", status: "pending", gift: view };
  }

  // 权益发放仍然只有一份实现（含"平台余额回源失败就不发"这些规则）
  const grant = await grantGift(env, {
    promotionId: promo.id,
    customerId: opts.customerId,
    source: claim.source as GiftSource,
    now,
    skipCheck: true,
  });

  if (!grant || !grant.granted) {
    await env.DB.prepare(
      `UPDATE promotion_claims SET status = 'pending', claimed_at = NULL WHERE id = ?`,
    )
      .bind(claim.id)
      .run();
    return {
      ok: false,
      reason: grant?.skipped ?? "领取失败，请稍后再试",
      status: "pending",
      gift: view,
    };
  }

  await env.DB.prepare(
    `UPDATE promotion_claims SET status = 'claimed', claimed_at = ?, order_id = ?, granted_json = ?
      WHERE id = ?`,
  )
    .bind(nowIso, grant.order_id, JSON.stringify(grant.applied), claim.id)
    .run();

  return {
    ok: true,
    reason: null,
    status: "claimed",
    applied: grant.applied,
    gift: claimView({ ...claim, status: "claimed" }, promo, now),
  };
}

/**
 * 我的礼包列表（**含已领取 / 已过期**，让用户看得见"我拿过什么"）。
 *
 * 排序：能领的在前（越快要作废越靠前），其次已过期，最后已领取。
 */
export async function listGifts(
  env: Env,
  customerId: number,
  now: Date = new Date(),
): Promise<GiftClaimView[]> {
  const rows = await env.DB.prepare(
    `SELECT c.id, c.promotion_id, c.status, c.source, c.expires_at, p.badge_label, p.rewards_json
       FROM promotion_claims c JOIN promotions p ON p.id = c.promotion_id
      WHERE c.customer_id = ?`,
  )
    .bind(customerId)
    .all<{
      id: number;
      promotion_id: number;
      status: string;
      source: string;
      expires_at: string;
      badge_label: string | null;
      rewards_json: string;
    }>();

  const rank: Record<GiftClaimStatus, number> = { pending: 0, expired: 1, claimed: 2 };
  return (rows.results ?? [])
    .map((r) =>
      claimView(
        r,
        { badge_label: r.badge_label, rewards: normalizeRewards(JSON.parse(r.rewards_json || "{}")) },
        now,
      ),
    )
    .sort((a, b) => rank[a.status] - rank[b.status] || a.expires_at.localeCompare(b.expires_at));
}

/** 有几张能领（`/me` 的红点用，省掉一次列表请求） */
export async function pendingGiftCount(
  env: Env,
  customerId: number,
  now: Date = new Date(),
): Promise<number> {
  const row = await env.DB.prepare(
    `SELECT COUNT(*) AS n FROM promotion_claims
      WHERE customer_id = ? AND status != 'claimed' AND expires_at > ?`,
  )
    .bind(customerId, now.toISOString())
    .first<{ n: number }>();
  return Number(row?.n ?? 0);
}
