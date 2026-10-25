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

import { AUDIENCES, PROMOTION_COLUMNS, hasRewards, normalizeRewards, rowToPromotion } from "../promotions/model";
import { grantGift } from "../promotions/gift";

import type { Env } from "../env";
import type { GiftRewards, Promotion, PromotionRow } from "../promotions/model";

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

  const rawCode = input.code === null || input.code === undefined ? "" : str(input.code).toUpperCase();
  if (rawCode && !/^[A-Z0-9_-]{2,32}$/.test(rawCode)) {
    errors.push("code 只能包含 A-Z / 0-9 / _ / -，长度 2–32（留空 = 自动活动）");
  }

  const kind = str(input.kind) || "coupon";
  if (!["coupon", "gift", "referral"].includes(kind)) errors.push("kind 只能是 coupon / gift / referral");

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
  if (kind === "gift" && !hasRewards(rewards)) errors.push("礼包至少要送一项：天数 / GB / 重置本月已用");

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

  const minSubtotal = num(input.min_subtotal_minor) ?? 0;
  if (minSubtotal < 0) errors.push("min_subtotal_minor 不能为负");

  const kindsRaw = Array.isArray(input.limit_plan_kinds) ? input.limit_plan_kinds : [];
  const kinds = kindsRaw.map((v) => str(v)).filter(Boolean);
  if (kinds.some((k) => !PLAN_KINDS.has(k))) errors.push("limit_plan_kinds 只能含 period / traffic / addon");

  const idsRaw = Array.isArray(input.limit_plan_ids) ? input.limit_plan_ids : [];
  const ids = idsRaw.map((v) => str(v)).filter(Boolean);

  const maxUses = input.max_uses === null || input.max_uses === undefined ? null : num(input.max_uses);
  if (maxUses !== null && maxUses <= 0) errors.push("max_uses 必须 > 0，或不填表示不限");
  const perCustomer = num(input.max_uses_per_customer) ?? 1;
  if (perCustomer < 0) errors.push("max_uses_per_customer 不能为负");

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

  if (errors.length) return { ok: false, errors };

  return {
    ok: true,
    value: {
      code: rawCode || null,
      name,
      kind: kind as Promotion["kind"],
      benefit_type: benefitType as Promotion["benefit_type"],
      benefit_value: kind === "gift" ? 0 : Math.round(benefitValue),
      min_subtotal_minor: Math.round(minSubtotal),
      limit_plan_kinds: kinds as Promotion["limit_plan_kinds"],
      limit_plan_ids: ids,
      rewards,
      audience: audience as Promotion["audience"],
      audience_days: audience === "expiring" ? Math.round(audienceDays ?? 7) : null,
      cooldown_hours: cooldownHours === null ? null : Math.round(cooldownHours),
      new_user_within_days: num(input.new_user_within_days),
      starts_at: startsAt,
      ends_at: endsAt,
      max_uses: maxUses === null ? null : Math.round(maxUses),
      max_uses_per_customer: Math.round(perCustomer),
      badge_label: str(input.badge_label) || null,
      visible: input.visible === false ? 0 : 1,
      referrer_reward_type: kind === "referral" ? rewardType : null,
      referrer_reward_value: kind === "referral" && rewardType !== "none" ? rewardValue : null,
    },
  };
}

interface PromotionInput {
  code: string | null;
  name: string;
  kind: Promotion["kind"];
  benefit_type: Promotion["benefit_type"];
  benefit_value: number;
  min_subtotal_minor: number;
  limit_plan_kinds: Promotion["limit_plan_kinds"];
  limit_plan_ids: string[];
  rewards: GiftRewards;
  audience: Promotion["audience"];
  audience_days: number | null;
  cooldown_hours: number | null;
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
    `INSERT INTO promotions (code, name, kind, benefit_type, benefit_value, min_subtotal_minor,
       limit_plan_kinds, limit_plan_ids, rewards_json, audience, audience_days, cooldown_hours,
       new_user_within_days, starts_at, ends_at, max_uses, max_uses_per_customer, badge_label, visible,
       referrer_reward_type, referrer_reward_value, status, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  )
    .bind(
      input.code, input.name, input.kind, input.benefit_type, input.benefit_value,
      input.min_subtotal_minor, JSON.stringify(input.limit_plan_kinds),
      JSON.stringify(input.limit_plan_ids), JSON.stringify(input.rewards),
      input.audience, input.audience_days, input.cooldown_hours,
      input.new_user_within_days, input.starts_at, input.ends_at, input.max_uses,
      input.max_uses_per_customer, input.badge_label, input.visible,
      input.referrer_reward_type, input.referrer_reward_value, status, now, now,
    )
    .run();
  return Number(res.meta.last_row_id ?? 0);
}

async function updatePromotion(env: Env, id: number, input: PromotionInput): Promise<void> {
  await env.DB.prepare(
    `UPDATE promotions SET code = ?, name = ?, kind = ?, benefit_type = ?, benefit_value = ?,
       min_subtotal_minor = ?, limit_plan_kinds = ?, limit_plan_ids = ?, rewards_json = ?,
       audience = ?, audience_days = ?, cooldown_hours = ?,
       new_user_within_days = ?, starts_at = ?, ends_at = ?, max_uses = ?, max_uses_per_customer = ?,
       badge_label = ?, visible = ?, referrer_reward_type = ?, referrer_reward_value = ?, updated_at = ?
     WHERE id = ?`,
  )
    .bind(
      input.code, input.name, input.kind, input.benefit_type, input.benefit_value,
      input.min_subtotal_minor, JSON.stringify(input.limit_plan_kinds),
      JSON.stringify(input.limit_plan_ids), JSON.stringify(input.rewards),
      input.audience, input.audience_days, input.cooldown_hours,
      input.new_user_within_days, input.starts_at, input.ends_at, input.max_uses,
      input.max_uses_per_customer, input.badge_label, input.visible,
      input.referrer_reward_type, input.referrer_reward_value,
      new Date().toISOString(), id,
    )
    .run();
}

/** 后台视图 = 行本身 + 已核销次数（判断"这个活动还有没有名额"） */
function view(row: PromotionRow, uses?: number): Record<string, unknown> {
  const promo = rowToPromotion(row);
  return {
    id: promo.id,
    code: promo.code,
    name: promo.name,
    kind: promo.kind,
    benefit_type: promo.benefit_type,
    benefit_value: promo.benefit_value,
    min_subtotal_minor: promo.min_subtotal_minor,
    limit_plan_kinds: promo.limit_plan_kinds,
    limit_plan_ids: promo.limit_plan_ids,
    rewards: promo.rewards,
    audience: promo.audience,
    audience_days: promo.audience_days,
    cooldown_hours: promo.cooldown_hours,
    new_user_within_days: promo.new_user_within_days,
    starts_at: promo.starts_at,
    ends_at: promo.ends_at,
    max_uses: promo.max_uses,
    max_uses_per_customer: promo.max_uses_per_customer,
    badge_label: promo.badge_label,
    visible: promo.visible,
    referrer_reward_type: promo.referrer_reward_type,
    referrer_reward_value: promo.referrer_reward_value,
    status: promo.status,
    ...(uses === undefined ? {} : { uses }),
  };
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
      `SELECT promotion_id, COUNT(*) AS n FROM redemptions GROUP BY promotion_id`,
    ).all<{ promotion_id: number; n: number }>();
    const byId = new Map((counts.results ?? []).map((r) => [r.promotion_id, r.n]));
    return json({ promotions: (rows.results ?? []).map((row) => view(row, byId.get(row.id) ?? 0)) });
  }

  // ── 新建（默认 draft；要上线再调 publish）──
  if (method === "POST" && path === "/promotions") {
    const result = validate(await readBody(request));
    if (!result.ok) return json({ error: "invalid_promotion", errors: result.errors }, 400);
    if (result.value.code) {
      const dup = await env.DB.prepare(`SELECT 1 AS x FROM promotions WHERE code = ?`)
        .bind(result.value.code)
        .first<{ x: number }>();
      if (dup) return fail(409, "code_exists", "这个码已经被用了");
    }
    const id = await insertPromotion(env, result.value, "draft");
    await audit(env, actor, "promotion_created", String(id), {
      code: result.value.code,
      kind: result.value.kind,
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
    if (result.value.code) {
      const dup = await env.DB.prepare(`SELECT id FROM promotions WHERE code = ? AND id <> ?`)
        .bind(result.value.code, id)
        .first<{ id: number }>();
      if (dup) return fail(409, "code_exists", "这个码已经被别的活动用了");
    }
    await updatePromotion(env, id, result.value);
    await audit(env, actor, "promotion_updated", String(id), { code: result.value.code });
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

    const results = [];
    for (const customerId of ids) {
      const result = await grantGift(env, { promotionId: id, customerId, source: "manual" });
      results.push(
        result ?? {
          promotion_id: id,
          customer_id: customerId,
          granted: false,
          skipped: "礼包不存在或已不是礼包",
          order_id: null,
          applied: { days: 0, gb: 0, reset_month: false },
        },
      );
    }
    const granted = results.filter((r) => r.granted).length;
    await audit(env, actor, "promotion_granted", String(id), { granted, total: results.length });
    return json({ granted, total: results.length, results });
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
