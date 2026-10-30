/**
 * 管理后台：促销 `/api/admin/promotions*`
 *
 * 与套餐一样，这里是**促销的唯一写入口**：App 与官网只读结果（`/plans`、`/quote`、`/me`）。
 *
 * 状态机只有三态，且**不能在 PATCH 里改**（防止误把草稿发出去）：
 *   `draft` → `active`（publish）→ `ended`（end）
 *
 * 为什么不做"券包 / 批量生成码"：见 `docs/promotion.md` §1。要定向给某个人优惠，
 * 建一个 `visible=0` 的活动把码单独发给他即可。
 */

import {
  AUDIENCES,
  EMPTY_REWARDS,
  GIFT_DELIVERIES,
  PROMOTION_COLUMNS,
  hasRewards,
  normalizeRewards,
  promoBadgeText,
  rowToPromotion,
} from "../promotions/model";
import { DEFAULT_CLAIM_DAYS } from "../promotions/claim";
import { deliverGift } from "../promotions/gift";
import { cancelRun, getRun, latestRun, runProgressText, startRun } from "../promotions/runs";
import { generateCodes, listCodes, revokeCode } from "../promotions/codes";

import type { Env } from "../env";
import type { GiftDelivery, GiftRewards, Promotion, PromotionRow } from "../promotions/model";

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8" },
  });
}

const fail = (status: number, error: string, message?: string): Response =>
  json(message ? { error, message } : { error }, status);

async function readBody(request: Request): Promise<Record<string, unknown>> {
  const body = await request.json().catch(() => null);
  return body && typeof body === "object" ? (body as Record<string, unknown>) : {};
}

async function audit(env: Env, actor: string, action: string, target: string, detail?: unknown): Promise<void> {
  await env.DB.prepare(
    `INSERT INTO audit_log (at, actor, action, target, detail) VALUES (?, ?, ?, ?, ?)`,
  )
    .bind(new Date().toISOString(), actor, action, target, detail === undefined ? null : JSON.stringify(detail))
    .run();
}

const PLAN_KINDS = new Set(["period", "traffic", "addon"]);

/** 输入 → 归一后的字段；错误一次性全返回（后台表单喜欢一次看全） */
function validate(input: Record<string, unknown>): { ok: true; value: PromotionInput } | { ok: false; errors: string[] } {
  const errors: string[] = [];
  const str = (v: unknown): string => (typeof v === "string" ? v.trim() : "");
  const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);

  const name = str(input.name);
  if (!name) errors.push("name 必填");
  if (name.length > 60) errors.push("name 太长（≤60）");

  const kind = str(input.kind) || "coupon";
  if (!["coupon", "gift", "referral"].includes(kind)) errors.push("kind 只能是 coupon / gift / referral");

  // v18：码不再手填（由 `POST /promotions/{id}/codes` 生成）。
  // `auto_apply` 只对优惠券有意义：不用码、打开就生效。
  const autoApply = kind === "coupon" && input.auto_apply === true;

  const benefitType = str(input.benefit_type) || "amount";
  if (benefitType !== "amount" && benefitType !== "percent") {
    errors.push("benefit_type 只能是 amount 或 percent");
  }
  const benefitValue = num(input.benefit_value) ?? 0;
  // 礼包不涉及金额（只改权益），所以不校验 benefit_*
  if (kind !== "gift") {
    if (benefitType === "percent") {
      if (!(benefitValue >= 1 && benefitValue <= 100)) errors.push("percent 的 benefit_value 必须在 1–100");
    } else if (!(benefitValue > 0)) {
      errors.push("amount 的 benefit_value 必须 > 0（单位：分）");
    }
  }

  // ── 礼包的奖励项与人群（契约 §2.9.6）──
  const rewards = normalizeRewards(input.rewards);
  if (kind === "gift" && !hasRewards(rewards)) errors.push("礼包至少要送一项：天数 / 流量 GB");

  // ── 送达方式（只对礼包有意义）──
  //   auto  = 触发即到账（悄悄改账，用户感知不到）
  //   claim = 只发一张券，用户自己在有效期内点领取（做营销要用这种）
  const deliveryRaw = str(input.delivery) || "auto";
  if (!(GIFT_DELIVERIES as readonly string[]).includes(deliveryRaw)) {
    errors.push("delivery 只能是 auto / claim");
  }
  const delivery: GiftDelivery = kind === "gift" && deliveryRaw === "claim" ? "claim" : "auto";
  let claimValidDays: number | null = null;
  if (delivery === "claim") {
    const raw = num(input.claim_valid_days) ?? DEFAULT_CLAIM_DAYS;
    if (!(raw >= 1 && raw <= 90)) errors.push("待领取有效期必须是 1–90 天");
    else claimValidDays = Math.round(raw);
  }
  // 通知邮件默认开：不发的话"待领取"没人知道、"已到账"没人感知
  const notify = input.notify !== false;

  const audience = str(input.audience) || "all";
  if (!(AUDIENCES as readonly string[]).includes(audience)) {
    errors.push(`audience 只能是 ${AUDIENCES.join(" / ")}`);
  }
  const audienceDays = input.audience_days === null || input.audience_days === undefined
    ? null
    : num(input.audience_days);
  if (audience === "expiring") {
    if (audienceDays === null || !(audienceDays >= 1 && audienceDays <= 90)) {
      errors.push("audience=expiring 时必须填 audience_days（1–90）");
    }
  } else if (audienceDays !== null) {
    errors.push("只有 audience=expiring 才用 audience_days");
  }
  const cooldownHours = input.cooldown_hours === null || input.cooldown_hours === undefined
    ? null
    : num(input.cooldown_hours);
  if (cooldownHours !== null && !(cooldownHours >= 0)) errors.push("cooldown_hours 不能为负");

  // 载体套餐：只对礼包有意义。**必须是 hidden** —— 这条要查库，放在 handle() 里校验
  const planId = kind === "gift" ? str(input.plan_id) || null : null;

  const minSubtotal = num(input.min_subtotal_minor) ?? 0;
  if (minSubtotal < 0) errors.push("min_subtotal_minor 不能为负");

  const kindsRaw = Array.isArray(input.limit_plan_kinds) ? input.limit_plan_kinds : [];
  const kinds = kindsRaw.map((v) => str(v)).filter(Boolean);
  if (kinds.some((k) => !PLAN_KINDS.has(k))) errors.push("limit_plan_kinds 只能含 period / traffic / addon");

  const idsRaw = Array.isArray(input.limit_plan_ids) ? input.limit_plan_ids : [];
  const ids = idsRaw.map((v) => str(v)).filter(Boolean);

  const maxUsesRaw = num(input.max_uses);
  // 留空 = 不限；填了就必须 ≥ 1（0 和负数不允许 —— “0 单”不是不限，是没有意义）
  if (maxUsesRaw !== null && maxUsesRaw <= 0) {
    errors.push("总名额留空表示不限；要限制就填大于 0 的整数");
  }
  // 名额只有一个来源：自动活动记在活动上；凭码活动记在码上（`promotion_codes.max_uses`）
  const maxUses = autoApply ? maxUsesRaw : null;
  // 每人每活动固定 1 次（契约 §2.9.7）：同一人反复用同一个优惠违背营销语义，
  // 也让"核销次数 = 触达人数"这条报表口径失效。
  const perCustomer = 1;

  const startsAt = str(input.starts_at) || null;
  const endsAt = str(input.ends_at) || null;
  if (startsAt && Number.isNaN(Date.parse(startsAt))) errors.push("starts_at 不是合法时间");
  if (endsAt && Number.isNaN(Date.parse(endsAt))) errors.push("ends_at 不是合法时间");
  if (startsAt && endsAt && Date.parse(endsAt) <= Date.parse(startsAt)) {
    errors.push("ends_at 必须晚于 starts_at");
  }

  const rewardType = str(input.referrer_reward_type) || "none";
  if (!["days", "gb", "none"].includes(rewardType)) errors.push("referrer_reward_type 只能是 days / gb / none");
  const rewardValue = num(input.referrer_reward_value) ?? 0;
  if (kind === "referral" && rewardType !== "none" && !(rewardValue > 0)) {
    errors.push("推荐人奖励必须 > 0（days 或 gb）");
  }

  // ── 站内展示（契约 §2.9.3，v19）──
  // 自动券没有码、没有入口，定价页是它**唯一**的曝光位：不写角标等于隐形券。
  const badgeLabel = str(input.badge_label) || null;
  if (autoApply && !badgeLabel) {
    errors.push("自动生效的券必须有角标文案（用户只能通过它在定价页看到这个活动）");
  }
  // 凭码券一律不进定价页：摆上去等于把渠道专属（博主 / 实体卡）变成人人都有。
  // 租户选择的 `visible` 只在自动券上有意义，其余一律落库为 0。
  const visible = autoApply && kind === "coupon" && input.visible !== false;

  if (errors.length) return { ok: false, errors };

  return {
    ok: true,
    value: {
      auto_apply: autoApply,
      name,
      kind: kind as Promotion["kind"],
      benefit_type: benefitType as Promotion["benefit_type"],
      benefit_value: kind === "gift" ? 0 : Math.round(benefitValue),
      min_subtotal_minor: Math.round(minSubtotal),
      limit_plan_kinds: kinds as Promotion["limit_plan_kinds"],
      limit_plan_ids: ids,
      rewards,
      delivery,
      claim_valid_days: claimValidDays,
      notify,
      audience: audience as Promotion["audience"],
      audience_days: audience === "expiring" ? Math.round(audienceDays ?? 7) : null,
      cooldown_hours: cooldownHours === null ? null : Math.round(cooldownHours),
      plan_id: planId,
      new_user_within_days: num(input.new_user_within_days),
      starts_at: startsAt,
      ends_at: endsAt,
      max_uses: maxUses === null ? null : Math.round(maxUses),
      max_uses_per_customer: Math.round(perCustomer),
      badge_label: badgeLabel,
      visible: visible ? 1 : 0,
      referrer_reward_type: kind === "referral" ? rewardType : null,
      referrer_reward_value: kind === "referral" && rewardType !== "none" ? rewardValue : null,
    },
  };
}

interface PromotionInput {
  auto_apply: boolean;
  name: string;
  kind: Promotion["kind"];
  benefit_type: Promotion["benefit_type"];
  benefit_value: number;
  min_subtotal_minor: number;
  limit_plan_kinds: Promotion["limit_plan_kinds"];
  limit_plan_ids: string[];
  rewards: GiftRewards;
  delivery: GiftDelivery;
  claim_valid_days: number | null;
  notify: boolean;
  audience: Promotion["audience"];
  audience_days: number | null;
  cooldown_hours: number | null;
  plan_id: string | null;
  new_user_within_days: number | null;
  starts_at: string | null;
  ends_at: string | null;
  max_uses: number | null;
  max_uses_per_customer: number;
  badge_label: string | null;
  visible: number;
  referrer_reward_type: string | null;
  referrer_reward_value: number | null;
}

async function insertPromotion(env: Env, input: PromotionInput, status: "draft" | "active"): Promise<number> {
  const now = new Date().toISOString();
  const res = await env.DB.prepare(
    `INSERT INTO promotions (auto_apply, name, kind, benefit_type, benefit_value, min_subtotal_minor,
       limit_plan_kinds, limit_plan_ids, rewards_json, delivery, claim_valid_days, notify,
       audience, audience_days, cooldown_hours,
       plan_id, new_user_within_days, starts_at, ends_at, max_uses, max_uses_per_customer, badge_label, visible,
       referrer_reward_type, referrer_reward_value, status, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  )
    .bind(
      input.auto_apply ? 1 : 0, input.name, input.kind, input.benefit_type, input.benefit_value,
      input.min_subtotal_minor, JSON.stringify(input.limit_plan_kinds),
      JSON.stringify(input.limit_plan_ids), JSON.stringify(input.rewards),
      input.delivery, input.claim_valid_days, input.notify ? 1 : 0,
      input.audience, input.audience_days, input.cooldown_hours, input.plan_id,
      input.new_user_within_days, input.starts_at, input.ends_at, input.max_uses,
      input.max_uses_per_customer, input.badge_label, input.visible,
      input.referrer_reward_type, input.referrer_reward_value, status, now, now,
    )
    .run();
  return Number(res.meta.last_row_id ?? 0);
}

async function updatePromotion(env: Env, id: number, input: PromotionInput): Promise<void> {
  await env.DB.prepare(
    `UPDATE promotions SET auto_apply = ?, name = ?, kind = ?, benefit_type = ?, benefit_value = ?,
       min_subtotal_minor = ?, limit_plan_kinds = ?, limit_plan_ids = ?, rewards_json = ?,
       delivery = ?, claim_valid_days = ?, notify = ?,
       audience = ?, audience_days = ?, cooldown_hours = ?, plan_id = ?,
       new_user_within_days = ?, starts_at = ?, ends_at = ?, max_uses = ?, max_uses_per_customer = ?,
       badge_label = ?, visible = ?, referrer_reward_type = ?, referrer_reward_value = ?, updated_at = ?
     WHERE id = ?`,
  )
    .bind(
      input.auto_apply ? 1 : 0, input.name, input.kind, input.benefit_type, input.benefit_value,
      input.min_subtotal_minor, JSON.stringify(input.limit_plan_kinds),
      JSON.stringify(input.limit_plan_ids), JSON.stringify(input.rewards),
      input.delivery, input.claim_valid_days, input.notify ? 1 : 0,
      input.audience, input.audience_days, input.cooldown_hours, input.plan_id,
      input.new_user_within_days, input.starts_at, input.ends_at, input.max_uses,
      input.max_uses_per_customer, input.badge_label, input.visible,
      input.referrer_reward_type, input.referrer_reward_value,
      new Date().toISOString(), id,
    )
    .run();
}

/** 后台视图 = 行本身 + 已核销次数（判断"这个活动还有没有名额"） */
function view(
  row: PromotionRow,
  uses?: number,
  codeStats?: { codes: number; active: number; capacity: number | null },
): Record<string, unknown> {
  const promo = rowToPromotion(row);
  return {
    id: promo.id,
    auto_apply: promo.auto_apply,
    name: promo.name,
    kind: promo.kind,
    benefit_type: promo.benefit_type,
    benefit_value: promo.benefit_value,
    min_subtotal_minor: promo.min_subtotal_minor,
    limit_plan_kinds: promo.limit_plan_kinds,
    limit_plan_ids: promo.limit_plan_ids,
    rewards: promo.rewards,
    delivery: promo.delivery,
    claim_valid_days: promo.claim_valid_days,
    notify: promo.notify,
    audience: promo.audience,
    audience_days: promo.audience_days,
    cooldown_hours: promo.cooldown_hours,
    plan_id: promo.plan_id,
    new_user_within_days: promo.new_user_within_days,
    starts_at: promo.starts_at,
    ends_at: promo.ends_at,
    max_uses: promo.max_uses,
    max_uses_per_customer: promo.max_uses_per_customer,
    badge_label: promo.badge_label,
    // 用户在定价页真正看到的那句话（含系统生成的人群前缀），后台只能预览、不能改
    badge_label_full: promoBadgeText(promo) || null,
    visible: promo.visible,
    referrer_reward_type: promo.referrer_reward_type,
    referrer_reward_value: promo.referrer_reward_value,
    status: promo.status,
    ...(uses === undefined ? {} : { uses }),
    ...(codeStats ? { code_stats: codeStats } : {}),
  };
}



/**
 * 编辑锁定（契约 §2.9.7）：**码一旦生成，规则就在外面流通了**。
 *
 * 500 个渠道码里可能只用了 3 个，但另外 497 个在用户手里 ——
 * 这时候改力度/范围/载体套餐，等于单方面改承诺。
 *
 * 可以改的：名称、角标、公开展示、人群、冷却、结束时间、名额调大。
 * 全部作废之后自动解锁（外面没有流通的码了）。
 */
const LOCKED_LABELS: [keyof Promotion, string][] = [
  ["kind", "类型"],
  ["benefit_type", "优惠方式"],
  ["benefit_value", "力度"],
  ["rewards", "礼包内容"],
  ["delivery", "送达方式"],
  ["min_subtotal_minor", "最低消费"],
  ["limit_plan_kinds", "适用套餐类型"],
  ["limit_plan_ids", "指定套餐"],
  ["plan_id", "体验套餐"],
  ["auto_apply", "是否自动生效"],
];

async function lockedFields(
  env: Env,
  promotionId: number,
  current: Promotion,
  next: PromotionInput,
): Promise<string[]> {
  const row = await env.DB.prepare(
    `SELECT COUNT(*) AS n FROM promotion_codes WHERE promotion_id = ? AND status = 'active'`,
  )
    .bind(promotionId)
    .first<{ n: number }>();
  if (!Number(row?.n ?? 0)) return [];

  const incoming: Promotion = {
    ...current,
    kind: next.kind as Promotion["kind"],
    auto_apply: next.auto_apply,
    benefit_type: next.benefit_type as Promotion["benefit_type"],
    benefit_value: next.benefit_value,
    rewards: next.rewards,
    min_subtotal_minor: next.min_subtotal_minor,
    limit_plan_kinds: next.limit_plan_kinds,
    limit_plan_ids: next.limit_plan_ids,
    plan_id: next.plan_id,
  };

  const diffs: string[] = [];
  for (const [key, label] of LOCKED_LABELS) {
    if (JSON.stringify(current[key]) !== JSON.stringify(incoming[key])) diffs.push(label);
  }
  return diffs;
}

/**
 * 载体套餐必须存在、上架、且 `visibility='hidden'`。
 *
 * 公开套餐能被直接买到 —— 拿它当载体等于开了个 0 元购买通道，
 * 所以这里必须挡住（`validate()` 是纯函数，查库放在这一层）。
 */
async function checkCarrierPlan(env: Env, planId: string | null): Promise<string | null> {
  if (!planId) return null;
  const row = await env.DB.prepare(`SELECT visibility, status FROM plans WHERE id = ?`)
    .bind(planId)
    .first<{ visibility: string; status: string }>();
  if (!row) return "载体套餐不存在";
  if (row.visibility !== "hidden") return "载体套餐必须是「隐藏」套餐（后台赠送专用）";
  if (row.status !== "active") return "载体套餐已下架";
  return null;
}

/**
 * @returns 命中时返回 Response；未命中返回 `null`（交给 router 继续匹配）
 */
export async function handleAdminPromotions(
  request: Request,
  env: Env,
  actor: string,
): Promise<Response | null> {
  const url = new URL(request.url);
  const path = url.pathname.replace(/^\/api\/admin/, "");
  const method = request.method;

  // ── 列表（带已核销次数）──
  if (method === "GET" && path === "/promotions") {
    const rows = await env.DB.prepare(
      `SELECT ${PROMOTION_COLUMNS} FROM promotions ORDER BY status, id DESC`,
    ).all<PromotionRow>();
    const counts = await env.DB.prepare(
      `SELECT promotion_id, COUNT(*) AS n FROM redemptions
        WHERE order_id IS NOT NULL GROUP BY promotion_id`,
    ).all<{ promotion_id: number; n: number }>();
    const byId = new Map((counts.results ?? []).map((r) => [r.promotion_id, r.n]));

    // 码统计：个数 / 可用个数 / 总容量（NULL 表示有不限量的码）
    const codeRows = await env.DB.prepare(
      `SELECT promotion_id,
              COUNT(*) AS codes,
              SUM(CASE WHEN status = 'active' THEN 1 ELSE 0 END) AS active,
              SUM(CASE WHEN status = 'active' AND max_uses IS NULL THEN 1 ELSE 0 END) AS unlimited,
              SUM(CASE WHEN status = 'active' THEN COALESCE(max_uses, 0) ELSE 0 END) AS capacity
         FROM promotion_codes GROUP BY promotion_id`,
    ).all<{ promotion_id: number; codes: number; active: number; unlimited: number; capacity: number }>();
    const codesById = new Map(
      (codeRows.results ?? []).map((r) => [
        r.promotion_id,
        {
          codes: Number(r.codes),
          active: Number(r.active),
          capacity: Number(r.unlimited) > 0 ? null : Number(r.capacity),
        },
      ]),
    );

    return json({
      promotions: (rows.results ?? []).map((row) =>
        view(row, byId.get(row.id) ?? 0, codesById.get(row.id) ?? { codes: 0, active: 0, capacity: 0 }),
      ),
    });
  }

  // ── 新建（默认 draft；要上线再调 publish）──
  if (method === "POST" && path === "/promotions") {
    const result = validate(await readBody(request));
    if (!result.ok) return json({ error: "invalid_promotion", errors: result.errors }, 400);
    const carrierError = await checkCarrierPlan(env, result.value.plan_id);
    if (carrierError) return fail(400, "invalid_promotion", carrierError);
    const id = await insertPromotion(env, result.value, "draft");
    await audit(env, actor, "promotion_created", String(id), {
      kind: result.value.kind,
      auto_apply: result.value.auto_apply,
      benefit: `${result.value.benefit_type}:${result.value.benefit_value}`,
    });
    const row = await env.DB.prepare(`SELECT ${PROMOTION_COLUMNS} FROM promotions WHERE id = ?`)
      .bind(id)
      .first<PromotionRow>();
    return json({ promotion: view(row as PromotionRow, 0) }, 201);
  }

  const one = path.match(/^\/promotions\/(\d+)$/);
  if (method === "PATCH" && one) {
    const id = Number(one[1]);
    const row = await env.DB.prepare(`SELECT ${PROMOTION_COLUMNS} FROM promotions WHERE id = ?`)
      .bind(id)
      .first<PromotionRow>();
    if (!row) return fail(404, "promotion_not_found");
    const result = validate({ ...view(row), ...(await readBody(request)) });
    if (!result.ok) return json({ error: "invalid_promotion", errors: result.errors }, 400);
    const locked = await lockedFields(env, id, rowToPromotion(row), result.value);
    if (locked.length) {
      return fail(
        409,
        "promotion_locked",
        `已经发出码了，不能再改：${locked.join("、")}。要改请先作废这些码，或新建一个活动。`,
      );
    }
    const carrierError = await checkCarrierPlan(env, result.value.plan_id);
    if (carrierError) return fail(400, "invalid_promotion", carrierError);
    await updatePromotion(env, id, result.value);
    await audit(env, actor, "promotion_updated", String(id), {
      kind: result.value.kind,
      auto_apply: result.value.auto_apply,
    });
    const saved = await env.DB.prepare(`SELECT ${PROMOTION_COLUMNS} FROM promotions WHERE id = ?`)
      .bind(id)
      .first<PromotionRow>();
    return json({ promotion: view(saved as PromotionRow) });
  }

  // ── 上线 / 收工（状态机在这里，PATCH 不碰 status）──
  const publish = path.match(/^\/promotions\/(\d+)\/publish$/);
  if (method === "POST" && publish) {
    const id = Number(publish[1]);
    const res = await env.DB.prepare(
      `UPDATE promotions SET status = 'active', updated_at = ? WHERE id = ? AND status = 'draft'`,
    )
      .bind(new Date().toISOString(), id)
      .run();
    if (!res.meta.changes) return fail(409, "invalid_state", "只有草稿能上线");
    await audit(env, actor, "promotion_published", String(id), null);
    return json({ ok: true });
  }

  const end = path.match(/^\/promotions\/(\d+)\/end$/);
  if (method === "POST" && end) {
    const id = Number(end[1]);
    const res = await env.DB.prepare(
      `UPDATE promotions SET status = 'ended', updated_at = ? WHERE id = ? AND status = 'active'`,
    )
      .bind(new Date().toISOString(), id)
      .run();
    if (!res.meta.changes) return fail(409, "invalid_state", "只有进行中的活动能结束");
    await audit(env, actor, "promotion_ended", String(id), null);
    return json({ ok: true });
  }

  // ── 点名名单（`audience='specific'`）──
  const targets = path.match(/^\/promotions\/(\d+)\/targets$/);
  if (targets && (method === "GET" || method === "PUT")) {
    const id = Number(targets[1]);
    const exists = await env.DB.prepare(`SELECT 1 AS x FROM promotions WHERE id = ?`)
      .bind(id)
      .first<{ x: number }>();
    if (!exists) return fail(404, "promotion_not_found");

    if (method === "GET") {
      const rows = await env.DB.prepare(
        `SELECT c.id, c.email, c.display_name
           FROM promotion_targets t JOIN customers c ON c.id = t.customer_id
          WHERE t.promotion_id = ? ORDER BY c.id`,
      )
        .bind(id)
        .all<{ id: number; email: string; display_name: string | null }>();
      return json({ customers: rows.results ?? [] });
    }

    const ids = readIdList((await readBody(request)).customer_ids);
    if (ids === null) return fail(400, "invalid_request", "customer_ids 必须是整数数组");

    // 整体替换：先删后插，语义与"这份名单就是全部"一致
    await env.DB.prepare(`DELETE FROM promotion_targets WHERE promotion_id = ?`).bind(id).run();
    const now = new Date().toISOString();
    for (const customerId of ids) {
      await env.DB.prepare(
        `INSERT OR IGNORE INTO promotion_targets (promotion_id, customer_id, created_at)
         VALUES (?, ?, ?)`,
      )
        .bind(id, customerId, now)
        .run();
    }
    await audit(env, actor, "promotion_targets_set", String(id), { count: ids.length });
    return json({ ok: true, count: ids.length });
  }


  // ── 删除：只在「草稿 + 没有码 + 没有核销」时允许 ──
  //   其余情况只能"结束" —— 已经发出去的承诺不能凭空消失。
  const del = path.match(/^\/promotions\/(\d+)$/);
  if (method === "DELETE" && del) {
    const id = Number(del[1]);
    const row = await env.DB.prepare(`SELECT status FROM promotions WHERE id = ?`)
      .bind(id)
      .first<{ status: string }>();
    if (!row) return fail(404, "promotion_not_found");
    if (row.status !== "draft") return fail(409, "invalid_state", "只有草稿能删除；进行中/已结束请用「结束」");

    const used = await env.DB.prepare(
      `SELECT (SELECT COUNT(*) FROM promotion_codes WHERE promotion_id = ?) AS codes,
              (SELECT COUNT(*) FROM redemptions
                WHERE promotion_id = ? AND order_id IS NOT NULL) AS redemptions`,
    )
      .bind(id, id)
      .first<{ codes: number; redemptions: number }>();
    if (Number(used?.redemptions ?? 0) > 0) {
      return fail(409, "invalid_state", "已经有核销记录，不能删除");
    }
    if (Number(used?.codes ?? 0) > 0) {
      return fail(409, "invalid_state", "已经生成过码。先把码全部作废，再删除");
    }

    await env.DB.prepare(`DELETE FROM promotions WHERE id = ?`).bind(id).run();
    await audit(env, actor, "promotion_deleted", String(id), null);
    return json({ ok: true });
  }

  // ── 批次码：生成 / 列表 / 作废（契约 §2.9.7）──
  const codes = path.match(/^\/promotions\/(\d+)\/codes$/);
  if (codes && (method === "GET" || method === "POST")) {
    const id = Number(codes[1]);
    const exists = await env.DB.prepare(`SELECT kind, auto_apply FROM promotions WHERE id = ?`)
      .bind(id)
      .first<{ kind: string; auto_apply: number }>();
    if (!exists) return fail(404, "promotion_not_found");

    if (method === "GET") {
      return json({ codes: await listCodes(env, id) });
    }

    // 自动生效与发码互斥（契约 §2.9.3，v19）：门已经对所有人开了，再发码不增加
    // 任何折扣，只会白白吃掉码的名额，还让“渠道带来 N 单”的报表失真。
    if (exists.auto_apply === 1) {
      return fail(
        409,
        "promotion_auto_apply",
        "这个活动是自动生效的，不需要发码；要给渠道发码请另建一个凭码活动",
      );
    }

    const body = await readBody(request);
    const count = Number(body.count ?? 0);
    if (!Number.isInteger(count) || count < 1 || count > 500) {
      return fail(400, "invalid_request", "count 必须是 1–500 的整数");
    }
    const maxUses = body.max_uses === undefined ? 1 : Number(body.max_uses);
    if (!Number.isInteger(maxUses) || maxUses < 1) {
      return fail(400, "invalid_request", "max_uses 必须是 ≥1 的整数");
    }
    const prefix = typeof body.prefix === "string" ? body.prefix : null;

    const { batchId, codes: created } = await generateCodes(env, {
      promotionId: id,
      count,
      maxUses,
      prefix,
      expiresAt: typeof body.expires_at === "string" && body.expires_at ? body.expires_at : null,
      note: typeof body.note === "string" && body.note ? body.note : null,
    });
    await audit(env, actor, "promotion_codes_generated", String(id), {
      batch_id: batchId,
      requested: count,
      created: created.length,
    });
    // 数量不够就如实返回（撞码重试有上限，不假装成功）
    return json({ batch_id: batchId, codes: created, requested: count }, 201);
  }

  const oneCode = path.match(/^\/promotions\/(\d+)\/codes\/(\d+)$/);
  if (method === "DELETE" && oneCode) {
    const [promotionId, codeId] = [Number(oneCode[1]), Number(oneCode[2])];
    const ok = await revokeCode(env, promotionId, codeId);
    if (!ok) return fail(404, "code_not_found", "这个码不存在或已经作废");
    await audit(env, actor, "promotion_code_revoked", String(promotionId), { code_id: codeId });
    return json({ ok: true });
  }

  // ── 批量发放（建任务，立刻返回；真正发放由 cron 分页做）──
  //  为什么不在请求里直接发：上万人 = 上万次 D1 + 上万次 cf-api 调用，
  //  单次 invocation 的 CPU / 子请求 / 并发连接全都撑不住（见 `promotions/runs.ts`）。
  const broadcast = path.match(/^\/promotions\/(\d+)\/broadcast$/);
  if (method === "POST" && broadcast) {
    const id = Number(broadcast[1]);
    const row = await env.DB.prepare(`SELECT ${PROMOTION_COLUMNS} FROM promotions WHERE id = ?`)
      .bind(id)
      .first<PromotionRow>();
    if (!row) return fail(404, "promotion_not_found");
    const promo = rowToPromotion(row);
    if (promo.kind !== "gift") return fail(409, "not_gift", "只有礼包能批量发放");
    if (promo.status !== "active") return fail(409, "invalid_state", "先上线再批量发放");

    const { run, alreadyRunning } = await startRun(env, { promotionId: id });
    if (!alreadyRunning) {
      await audit(env, actor, "promotion_broadcast_started", String(id), {
        run_id: run.id,
        total: run.total,
      });
    }
    return json(
      {
        run: { ...run, progress_text: runProgressText(run) },
        // true = 已经有一个在跑，这次没有新建（幂等，重复点按钮不会开两个任务）
        already_running: alreadyRunning,
      },
      alreadyRunning ? 200 : 202,
    );
  }

  // 进度（前端轮询；文案由 CRM 给）
  const runOne = path.match(/^\/promotions\/(\d+)\/run$/);
  if (method === "GET" && runOne) {
    const id = Number(runOne[1]);
    const run = await latestRun(env, id);
    return json({ run: run ? { ...run, progress_text: runProgressText(run) } : null });
  }

  const runCancel = path.match(/^\/promotions\/runs\/(\d+)\/cancel$/);
  if (method === "POST" && runCancel) {
    const runId = Number(runCancel[1]);
    const ok = await cancelRun(env, runId);
    if (!ok) return fail(409, "invalid_state", "这个任务已经结束或不存在");
    await audit(env, actor, "promotion_broadcast_cancelled", String(runId), null);
    return json({ ok: true });
  }

  // ── 手动发放（礼包）──
  const grant = path.match(/^\/promotions\/(\d+)\/grant$/);
  if (method === "POST" && grant) {
    const id = Number(grant[1]);
    const ids = readIdList((await readBody(request)).customer_ids);
    if (ids === null || !ids.length) {
      return fail(400, "invalid_request", "customer_ids 必须是非空整数数组");
    }

    const row = await env.DB.prepare(`SELECT ${PROMOTION_COLUMNS} FROM promotions WHERE id = ?`)
      .bind(id)
      .first<PromotionRow>();
    if (!row) return fail(404, "promotion_not_found");
    const promo = rowToPromotion(row);
    if (promo.kind !== "gift") return fail(409, "not_gift", "只有礼包能直接发放（优惠券请让用户输码）");

    // 送达方式决定这里到底是"已到账"还是"已发券"（`delivery='claim'` 时权益还没动）
    const results = [];
    for (const customerId of ids) {
      const result = await deliverGift(env, { promotionId: id, customerId, source: "manual" });
      results.push(
        result ?? {
          promotion_id: id,
          customer_id: customerId,
          granted: false,
          pending: false,
          skipped: "礼包不存在或已不是礼包",
          order_id: null,
          applied: EMPTY_REWARDS,
        },
      );
    }
    const granted = results.filter((r) => r.granted).length;
    const pending = results.filter((r) => r.pending).length;
    await audit(env, actor, "promotion_granted", String(id), {
      granted,
      pending,
      total: results.length,
    });
    return json({ granted, pending, total: results.length, results });
  }

  const oneRun = path.match(/^\/promotions\/runs\/(\d+)$/);
  if (method === "GET" && oneRun) {
    const run = await getRun(env, Number(oneRun[1]));
    if (!run) return fail(404, "run_not_found");
    return json({ run: { ...run, progress_text: runProgressText(run) } });
  }

  return null;
}

/** 把 `[1,2,3]` 归一成去重后的正整数数组；含非法值返回 null（整体拒绝） */
function readIdList(raw: unknown): number[] | null {
  if (!Array.isArray(raw)) return null;
  const out = new Set<number>();
  for (const v of raw) {
    const n = typeof v === "number" ? v : Number(v);
    if (!Number.isInteger(n) || n <= 0) return null;
    out.add(n);
  }
  return [...out];
}
