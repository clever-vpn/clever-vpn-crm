/**
 * 礼包 = **货架上的东西，用户自己来拉**（契约 `app-crm.md` §2.9.6）
 *
 * 模型（这一版的关键）：
 *   - **没有"推送"**：不存在"批量任务给一万个人发券"，也没有"待领取的券"表。
 *     礼包就是 `promotions` 里一条生效中的活动；能不能领，**每次查询时现算**。
 *   - **没有订单**：礼包不走购买流程，所以不写 `orders`。凭证是核销行
 *     （`redemptions` + `promotion_snapshot`），历史是 `subscription_changes`。
 *   - **领取 = 一次条件插入**：名额还有 + 我还没领过 + 占下来，一条语句完成。
 *
 * 三条硬规则（与优惠券共享）：
 *   1. **必须有地方放**：有订阅 ⇒ 加到订阅上；没订阅 ⇒ 用礼包的「载体套餐」0 元开户。
 *   2. **两个维度互相独立、都是「加」不是「替换」**（实现共用 `subscriptions/entitlement.ts`）。
 *   3. **订阅没有这个权益就不改**：无限期不收天数、不限量不收 GB；两项都不适用就直接拒绝，
 *      并且**不动任何一行**。
 */
import { EMPTY_REWARDS, PROMOTION_COLUMNS, hasRewards, rowToPromotion } from "./model";
import { checkAllForCustomer, checkForCustomer } from "./service";
import { releaseRedemption, reserveRedemption, settleRedemption } from "./redemption";
import { createNotice } from "../notices/store";
import { grantedNotice } from "../notices/model";
import { provisionSubscription } from "../platform/provision";
import { applicableAdditive, applyAdditive, pushAdditive } from "../subscriptions/entitlement";
import { customerSubscription, freshenTraffic, logChange, upsertSubscription } from "../subscriptions/store";
import { rowToPlan } from "../plans/model";
import { subscriptionFromPlan } from "../plans/subscription";

import type { Env } from "../env";
import type { GiftRewards, Promotion, PromotionRow } from "./model";
import type { Plan, PlanRow } from "../plans/model";
import type { Subscription } from "../plans/subscription";

/**
 * 这份订阅**能收下**哪些奖励 —— 不适用的维度归 0。
 *
 * 与"管理员直接调整"共用同一份判断（`subscriptions/entitlement.ts`）：
 * 无限期不收天数、不限量不收 GB，两个维度互不牵连。
 */
export const applicableRewards = applicableAdditive;

/** "延长 7 天" / "+10 GB 流量" / "延长 7 天、+10 GB 流量" */
export function rewardsText(r: GiftRewards): string {
  const parts: string[] = [];
  if (r.days > 0) parts.push(`延长 ${r.days} 天`);
  if (r.gb > 0) parts.push(`+${r.gb} GB 流量`);
  return parts.length ? parts.join("、") : "无";
}

// ────────────────────────────────────────────────────────────────────────────
// 领取
// ────────────────────────────────────────────────────────────────────────────

/**
 * 领取结果的状态。
 *
 * 为什么把「抢完了」单列：用户**有资格**但**来晚了**是两件事，
 * 混成一句"不可用"会让他以为自己没资格，反而来问客服。
 */
export type GiftClaimState =
  | "granted"
  | "already_claimed"
  | "sold_out"
  | "not_eligible"
  | "not_applicable"
  | "busy"
  | "not_found";

export interface GiftClaimResult {
  state: GiftClaimState;
  /** 直接给用户看的一句话（前端只渲染，不判断） */
  message: string;
  /** 礼包名（not_found 时为 null） */
  title: string | null;
  /** 实际到账的权益（`state='granted'` 才有） */
  applied: GiftRewards;
  /** 领完之后的到期日（null = 无限期；没领成功为 undefined） */
  expires_at?: string | null;
  /** 这次领取的核销行 id（台账追溯用，前端不渲染） */
  redemption_id: number | null;
}

/** 各状态的默认文案（`checkPromotion` 给了具体理由时用它的） */
const STATE_TEXT = {
  already_claimed: "这个礼包你已经领过了",
  sold_out: "来晚了一步，这份礼包已经被抢完了",
  not_applicable: "这个礼包送的内容对当前套餐不适用（不限量 / 无限期）",
  busy: "正在发放中，请稍后再看",
  not_found: "这个礼包已经不在了",
} as const;

/**
 * 「不能领」的原因要说**礼包的话**。
 *
 * `checkPromotion` 的文案是为输码场景写的（"这个码已经过期了"），
 * 而无码礼包根本没有码 —— 用户看到一个不存在的"码"只会更困惑。
 */
function blockText(promo: Promotion, reason: string, now: Date): string {
  if (promo.ends_at && Date.parse(promo.ends_at) <= now.getTime()) return "这个礼包已经结束了";
  if (promo.starts_at && Date.parse(promo.starts_at) > now.getTime()) return "这个礼包还没开始";
  return reason;
}

function claimResult(
  state: GiftClaimState,
  message: string,
  extra: Partial<GiftClaimResult> = {},
): GiftClaimResult {
  return { state, message, title: null, applied: EMPTY_REWARDS, redemption_id: null, ...extra };
}

/** 这个人**是否已经领过**（只算已完成的核销：占位中不算领过） */
async function claimedBy(env: Env, promotionId: number, customerId: number): Promise<boolean> {
  const row = await env.DB.prepare(
    `SELECT 1 AS x FROM redemptions
      WHERE promotion_id = ? AND customer_id = ? AND settled_at IS NOT NULL LIMIT 1`,
  )
    .bind(promotionId, customerId)
    .first<{ x: number }>();
  return Boolean(row);
}

/**
 * 这个活动已经被用掉多少名额。
 *
 * 口径：**含占位行** —— 占位代表"有人正在领"，不数就会超发。
 */
async function usedOf(env: Env, promotionId: number): Promise<number> {
  const row = await env.DB.prepare(
    `SELECT COUNT(*) AS n FROM redemptions WHERE promotion_id = ?`,
  )
    .bind(promotionId)
    .first<{ n: number }>();
  return Number(row?.n ?? 0);
}

/**
 * 读礼包的**载体套餐**（客户还没有订阅时用它 0 元开户）。
 *
 * 只允许 `visibility='hidden'` 的套餐：公开套餐能被直接买到，
 * 拿它当载体等于开了个 0 元购买通道。
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
 * **领取一个礼包**（用户点"领取"、输兑换码、后台手动发放 —— 全走这里）。
 *
 * 顺序刻意固定：**所有只读校验做完，才动钱**。
 * 占位之后任一步抛错都要把占位还回去，否则这个人永远领不到（唯一索引挡着）。
 *
 * @param codeId 命中的批次码（`promotion_codes.id`）；无码礼包传 null
 */
export async function claimGiftFor(
  env: Env,
  opts: {
    promotionId: number;
    customerId: number;
    codeId?: number | null;
    now?: Date;
    /** 注册礼包：那一刻刚变首单，语义上仍是新客（见 `checkForCustomer`） */
    assumeFirstPurchase?: boolean;
  },
): Promise<GiftClaimResult> {
  const now = opts.now ?? new Date();

  const row = await env.DB.prepare(`SELECT ${PROMOTION_COLUMNS} FROM promotions WHERE id = ?`)
    .bind(opts.promotionId)
    .first<PromotionRow>();
  if (!row) return claimResult("not_found", STATE_TEXT.not_found);
  const promo = rowToPromotion(row);
  if (promo.kind !== "gift") return claimResult("not_found", STATE_TEXT.not_found);
  const title = promo.name;

  // ── 1) 资格：人群 / 时间窗 / 次数 / 冷却（全是只读）──
  const check = await checkForCustomer(env, promo, opts.customerId, now, {
    assumeFirstPurchase: opts.assumeFirstPurchase,
  });
  if (!check.ok) {
    // 预检会先撞上「次数上限」（`max_uses_per_customer`）和「名额」，
    // 但那两种都不是"你没资格"：
    //   1. 我领过   ⇒ already_claimed（"你已经领过了"）
    //   2. 名额没了 ⇒ sold_out（"来晚了一步"）
    //   3. 其余     ⇒ not_eligible（人群 / 时间窗 / 冷却，用 checkPromotion 的理由）
    if (await claimedBy(env, promo.id, opts.customerId)) {
      return claimResult("already_claimed", STATE_TEXT.already_claimed, { title });
    }
    if (promo.max_uses !== null && (await usedOf(env, promo.id)) >= promo.max_uses) {
      return claimResult("sold_out", STATE_TEXT.sold_out, { title });
    }
    return claimResult("not_eligible", blockText(promo, check.reason, now), { title });
  }

  // ── 2) 有没有"地方可放" ──
  const before = await customerSubscription(env, opts.customerId);
  let plan: Plan | null = null;
  if (!before) {
    if (!promo.plan_id) {
      return claimResult(
        "not_applicable",
        "还需要先有套餐；这个礼包没有配置体验套餐，请联系客服",
        { title },
      );
    }
    plan = await loadCarrierPlan(env, promo.plan_id);
    if (!plan) {
      return claimResult("not_applicable", "礼包的体验套餐已不可用，请联系客服", { title });
    }
  }

  // 先算"目标订阅快照"，再判断礼包**对它有没有意义**
  const target =
    before ?? subscriptionFromPlan(plan as Plan, { customerId: opts.customerId, paidMinor: 0, now });
  const applied = applicableRewards(target, promo.rewards);
  if (!hasRewards(applied)) {
    return claimResult("not_applicable", STATE_TEXT.not_applicable, { title });
  }

  // 送 GB 必须落在**平台真实剩余**上：读不到就不发（拿旧缓存加，会把已用流量还回去）
  let platformRemainingGb: number | undefined;
  if (applied.gb > 0 && before?.platform_customer_id) {
    const fresh = await freshenTraffic(env, before);
    if (!fresh || fresh.traffic_remaining_gb === null) {
      return claimResult("not_applicable", "平台的剩余流量暂时读不到，礼包稍后再领", { title });
    }
    platformRemainingGb = fresh.traffic_remaining_gb;
  }

  // ── 3) 抢占位（名额 + 我是否领过，一条语句）──
  const reservation = await reserveRedemption(env, {
    promotionId: promo.id,
    customerId: opts.customerId,
    codeId: opts.codeId ?? null,
    maxUses: promo.max_uses,
    now,
  });
  if (!reservation.ok) {
    const mapped: GiftClaimState =
      reservation.reason === "already_claimed"
        ? "already_claimed"
        : reservation.reason === "sold_out"
          ? "sold_out"
          : "busy";
    return claimResult(mapped, reservation.message, { title });
  }

  // ── 4) 发放（从这一刻起会动钱）──
  try {
    const result = before
      ? await applyToSubscription(env, {
          before,
          applied,
          promo,
          redemptionId: reservation.id,
          platformRemainingGb,
          now,
        })
      : await openFromCarrierPlan(env, {
          planId: promo.plan_id as string,
          base: target,
          applied,
          promo,
          redemptionId: reservation.id,
          now,
        });

    // 回填：完成时间 + **实际生效**的权益 + 活动快照（凭证不跟着活动改名而变）
    await settleRedemption(env, reservation.id, {
      applied: result.applied,
      snapshot: { name: promo.name, badge: promo.badge_label, rewards: promo.rewards },
      now,
    });

    await notifyReceipt(env, {
      promo,
      customerId: opts.customerId,
      redemptionId: reservation.id,
      applied: result.applied,
      expiresAt: result.after.expires_at,
      now,
    });

    return {
      state: "granted",
      message: `已到账：${rewardsText(result.applied)}`,
      title,
      applied: result.applied,
      expires_at: result.after.expires_at,
      redemption_id: reservation.id,
    };
  } catch (e) {
    // 没发完 ⇒ 还回占位（不还的话这个人永远领不到）
    await releaseRedemption(env, reservation.id);
    throw e;
  }
}

/** 把奖励项作用到**已有订阅**上，并落账到 cf-api */
async function applyToSubscription(
  env: Env,
  opts: {
    before: Subscription;
    /** 已过 `applicableRewards` 过滤 */
    applied: GiftRewards;
    promo: Promotion;
    redemptionId: number;
    platformRemainingGb?: number | null;
    now: Date;
  },
): Promise<{ applied: GiftRewards; after: Subscription }> {
  const before = opts.before;
  const next = applyAdditive(before, opts.applied, {
    platformRemainingGb: opts.platformRemainingGb,
  });

  const id = await upsertSubscription(env, next);
  const after = { ...next, id };

  await logChange(env, {
    customer_id: before.customer_id,
    subscription_id: id,
    action: "gift",
    before,
    after,
    detail: {
      promotion_id: opts.promo.id,
      promotion_name: opts.promo.name,
      redemption_id: opts.redemptionId,
      rewards: opts.applied,
    },
  });

  try {
    await pushAdditive(env, after, opts.applied, opts.platformRemainingGb, next.expires_at);
  } catch (e) {
    // 本地账已记；推特失败交给月结/人工补齐，不影响领取结论
    console.error(
      `[gift] 落账失败 customer=${before.customer_id} promo=${opts.promo.id}: ${
        e instanceof Error ? e.message : e
      }`,
    );
  }

  return { applied: opts.applied, after };
}

/** 用载体套餐 0 元开户，并把已过滤过的奖励叠上去 */
async function openFromCarrierPlan(
  env: Env,
  opts: {
    planId: string;
    base: Omit<Subscription, "id">;
    applied: GiftRewards;
    promo: Promotion;
    redemptionId: number;
    now: Date;
  },
): Promise<{ applied: GiftRewards; after: Subscription }> {
  const customerId = opts.base.customer_id;

  // 0 元开户：套餐给骨架，礼包在**它之上累加**（不是覆盖）——
  // 载体套餐自己有 30 天、礼包再送 7 天，用户拿到的是 37 天。
  const next = applyAdditive({ ...opts.base, id: 0 }, opts.applied);

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
      promotion_id: opts.promo.id,
      promotion_name: opts.promo.name,
      redemption_id: opts.redemptionId,
      carrier_plan_id: opts.planId,
      rewards: opts.applied,
    },
  });

  try {
    // 新开户要**建客户**，所以走全量落账
    await provisionSubscription(env, after);
  } catch (e) {
    console.error(
      `[gift] 开户落账失败 customer=${customerId} plan=${opts.planId}: ${
        e instanceof Error ? e.message : e
      }`,
    );
  }

  return { applied: opts.applied, after };
}

/**
 * **收据**邮件（`promotions.notify = 1` 才发，默认不发）。
 *
 * 默认不发的理由：领取结果同步返回给客户端（弹窗里就有"已到账 +7 天"），
 * 邮件只会晚到且重复，还吃发信配额 —— 那个配额是验证码的命脉。
 */
async function notifyReceipt(
  env: Env,
  opts: {
    promo: Promotion;
    customerId: number;
    redemptionId: number;
    applied: GiftRewards;
    expiresAt: string | null;
    now: Date;
  },
): Promise<void> {
  if (!opts.promo.notify || !hasRewards(opts.applied)) return;
  try {
    await createNotice(
      env,
      grantedNotice({
        customerId: opts.customerId,
        refId: opts.redemptionId,
        badgeLabel: opts.promo.badge_label,
        rewards: opts.applied,
        expiresAt: opts.expiresAt,
        siteUrl: env.SITE_URL ?? "",
      }),
      opts.now,
    );
  } catch (e) {
    console.error(
      `[notice] 收据写入失败 customer=${opts.customerId} redemption=${opts.redemptionId}: ${
        e instanceof Error ? e.message : e
      }`,
    );
  }
}

// ────────────────────────────────────────────────────────────────────────────
// 货架
// ────────────────────────────────────────────────────────────────────────────

/** 货架上一样东西的状态 —— 前端只按这个渲染，不自己算 */
export type GiftShelfState = "available" | "sold_out" | "claimed" | "ended";

export interface GiftShelfItem {
  promotion_id: number;
  title: string;
  /** 角标（`badge_label`，可能与人群前缀拼在一起） */
  badge: string | null;
  /** 这份礼包的**配置**内容（"延长 7 天"），不是"你实际拿到多少" */
  rewards_text: string;
  state: GiftShelfState;
  /** 给用户看的一句话 */
  status_text: string;
  /** 还剩多少份（`null` = 不限量）；`available` / `sold_out` 时有意义 */
  remaining: number | null;
  /** 活动结束时间（`null` = 不限） */
  ends_at: string | null;
  /** 只有 `state='available'` 才是 true —— 前端据此显示按钮 */
  claimable: boolean;
  /** 领取接口路径（前端不自己拼） */
  claim_action: string;
}

export interface GiftShelf {
  items: GiftShelfItem[];
  /** 列表为空时给用户看的话（内容由服务端决定，前端只渲染） */
  empty_text: string | null;
}

/**
 * 每个活动还剩多少份。
 *
 * 口径：**包含占位行**（`settled_at IS NULL` 也算用掉了）——
 * 宁可少报一份，也不能报出一份马上领不到的"名额"。
 */
async function remainingOf(
  env: Env,
  promos: readonly Promotion[],
): Promise<Map<number, number | null>> {
  const out = new Map<number, number | null>();
  for (const p of promos) out.set(p.id, p.max_uses);
  const limited = promos.filter((p) => p.max_uses !== null);
  if (!limited.length) return out;

  const marks = limited.map(() => "?").join(",");
  const rows = await env.DB.prepare(
    `SELECT promotion_id, COUNT(*) AS n FROM redemptions
      WHERE promotion_id IN (${marks}) GROUP BY promotion_id`,
  )
    .bind(...limited.map((p) => p.id))
    .all<{ promotion_id: number; n: number }>();
  const used = new Map((rows.results ?? []).map((r) => [r.promotion_id, r.n]));
  for (const p of limited) {
    out.set(p.id, Math.max(0, (p.max_uses as number) - (used.get(p.id) ?? 0)));
  }
  return out;
}

/**
 * **我的礼包货架**（`GET /me/gifts`）—— 实时算，没有"发出去的行"。
 *
 * 默认只列**我能领 / 我领过**的；不符合资格的活动根本不出现
 * （列一屏"你不符合条件"只会让人觉得自己被歧视）。
 * 带 `?promotion_id=` 深链时**例外**：那条一定出现，并说明为什么不能领
 * —— 用户是拿着链接来的，什么都不显示等于页面坏了。
 */
export async function listGiftShelf(
  env: Env,
  customerId: number,
  now: Date = new Date(),
  opts: { promotionId?: number | null } = {},
): Promise<GiftShelf> {
  const deepLink = opts.promotionId ?? null;

  // 货架 = **公开可见**的生效礼包。深链不会放开这个过滤 ——
  // 否则一条 `visible=0` 的定向活动被拿链接猜出来就成了人人可见。
  const rows = await env.DB.prepare(
    `SELECT ${PROMOTION_COLUMNS} FROM promotions
      WHERE kind = 'gift' AND status = 'active' AND visible = 1
      ORDER BY id DESC`,
  ).all<PromotionRow>();
  const promos = (rows.results ?? []).map(rowToPromotion);

  // 深链那条如果不在货架上（定向 / 未公开 / 已结束），单独补进来好解释原因
  let extra: Promotion | null = null;
  if (deepLink && !promos.some((p) => p.id === deepLink)) {
    const row = await env.DB.prepare(
      `SELECT ${PROMOTION_COLUMNS} FROM promotions WHERE id = ? AND kind = 'gift'`,
    )
      .bind(deepLink)
      .first<PromotionRow>();
    if (row) extra = rowToPromotion(row);
  }

  const all = extra ? [...promos, extra] : promos;
  if (!all.length) return { items: [], empty_text: "暂时没有可以领取的礼包" };

  const ids = all.map((p) => p.id);
  const marks = ids.map(() => "?").join(",");

  // 没有订阅的人能不能领，取决于礼包有没有**可用的载体套餐**（0 元开户）。
  // 不预先算清楚，货架就会显示"可以领取"、点下去却说"需要先有套餐" ——
  // 那种自相矛盾比不显示更伤信任。
  const carrierIds = [...new Set(all.map((p) => p.plan_id).filter((v): v is string => Boolean(v)))];

  const [checks, remaining, mine, sub, carriers] = await Promise.all([
    checkAllForCustomer(env, all, customerId, now),
    remainingOf(env, all),
    // 我领过哪些（**只算已完成**：占位中不算"领过"）
    env.DB.prepare(
      `SELECT promotion_id, settled_at FROM redemptions
        WHERE customer_id = ? AND promotion_id IN (${marks}) AND settled_at IS NOT NULL
        ORDER BY id DESC`,
    )
      .bind(customerId, ...ids)
      .all<{ promotion_id: number; settled_at: string }>(),
    customerSubscription(env, customerId),
    carrierIds.length
      ? env.DB.prepare(
          `SELECT id FROM plans
            WHERE id IN (${carrierIds.map(() => "?").join(",")})
              AND visibility = 'hidden' AND status = 'active' AND kind <> 'addon'`,
        )
          .bind(...carrierIds)
          .all<{ id: string }>()
      : Promise.resolve({ results: [] as { id: string }[] }),
  ]);
  const usableCarrier = new Set((carriers.results ?? []).map((r) => r.id));

  const claimedAt = new Map<number, string>();
  for (const r of mine.results ?? []) claimedAt.set(r.promotion_id, r.settled_at);

  const items: GiftShelfItem[] = [];
  for (const promo of all) {
    const check = checks.get(promo.id);
    const left = remaining.get(promo.id) ?? null;
    const claimedOn = claimedAt.get(promo.id);
    const action = `/me/gifts/${promo.id}/claim`;
    const base: Omit<GiftShelfItem, "state" | "status_text" | "claimable"> = {
      promotion_id: promo.id,
      title: promo.name,
      badge: promo.badge_label,
      rewards_text: rewardsText(promo.rewards),
      remaining: left,
      ends_at: promo.ends_at,
      claim_action: action,
    };

    // 1) 领过 ⇒ claimed（既成事实，与现在名额 / 资格无关）
    if (claimedOn) {
      items.push({
        ...base,
        state: "claimed",
        status_text: `已领取（${claimedOn.slice(0, 10)}）`,
        claimable: false,
      });
      continue;
    }

    // 2) 名额没了 ⇒ sold_out（**有资格但来晚了**，必须说清楚）
    if (left !== null && left <= 0) {
      items.push({ ...base, state: "sold_out", status_text: STATE_TEXT.sold_out, claimable: false });
      continue;
    }

    // 3) 资格（人群 / 时间窗 / 冷却）+ 适用性
    const applicable = sub
      ? hasRewards(applicableRewards(sub, promo.rewards))
      : Boolean(promo.plan_id && usableCarrier.has(promo.plan_id));
    const blocked = !check?.ok
      ? blockText(promo, check?.reason ?? STATE_TEXT.not_found, now)
      : !applicable
        ? STATE_TEXT.not_applicable
        : null;
    if (blocked) {
      // 不符合资格：**默认不出现**（除深链，须解释原因）
      if (promo.id !== deepLink) continue;
      items.push({ ...base, state: "ended", status_text: blocked, claimable: false });
      continue;
    }

    items.push({
      ...base,
      state: "available",
      status_text: left === null ? "可以领取" : `可以领取（还剩 ${left} 份）`,
      claimable: true,
    });
  }

  return { items, empty_text: items.length ? null : "暂时没有可以领取的礼包" };
}
