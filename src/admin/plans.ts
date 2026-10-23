/**
 * 管理后台：套餐设计器 `/api/admin/plans*`
 *
 * 这里是**销售策略的唯一写入口**：改价、上下架、换规则都只改这张表，
 * App 不需要发版（`app-crm.md` §0）。
 *
 * 不可变性：`active` 的套餐不允许原地修改（历史订单要能追溯当时的规则）。
 * 想改价/改内容 → `POST /plans/:id/clone` 生成 `supersedes_id` 指向旧行的新草稿 → 发布 → 下线旧行。
 * 没卖出去的 `draft` 可以随便改。
 */

import {
  planForClient,
  planToControlParams,
  rowToPlan,
  validatePlan,
} from "../plans/model";
import { quotePurchase } from "../plans/quote";

import type { Env } from "../env";
import type { CurrentSubscription } from "../plans/quote";
import type { Plan, PlanRow } from "../plans/model";

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

const PLAN_COLUMNS = `id, name, kind, price_minor, currency, licence_limit, term_days, monthly_quota_gb,
  traffic_gb, validity_days, allow_addons, line_ids, up_mbps, down_mbps, channels, store_product_id,
  sort_order, status, supersedes_id, retired_at, created_at, updated_at`;

/** 后台视图 = App 视图 + 后台才需要的状态字段 */
function view(plan: Plan): Record<string, unknown> {
  return {
    ...planForClient(plan),
    status: plan.status,
    sort_order: plan.sort_order,
    supersedes_id: plan.supersedes_id,
    retired_at: plan.retired_at,
  };
}

async function loadPlan(env: Env, id: string): Promise<PlanRow | null> {
  return env.DB.prepare(`SELECT ${PLAN_COLUMNS} FROM plans WHERE id = ?`).bind(id).first<PlanRow>();
}

async function insertPlan(env: Env, plan: Plan): Promise<void> {
  const now = new Date().toISOString();
  await env.DB.prepare(
    `INSERT INTO plans (id, name, kind, price_minor, currency, licence_limit, term_days, monthly_quota_gb,
       traffic_gb, validity_days, allow_addons, line_ids, up_mbps, down_mbps, channels, store_product_id,
       sort_order, status, supersedes_id, retired_at, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  )
    .bind(
      plan.id, plan.name, plan.kind, plan.price_minor, plan.currency, plan.licence_limit,
      plan.term_days, plan.monthly_quota_gb, plan.traffic_gb, plan.validity_days,
      plan.allow_addons ? 1 : 0, JSON.stringify(plan.line_ids), plan.up_mbps, plan.down_mbps,
      JSON.stringify(plan.channels), JSON.stringify(plan.store_product_id),
      plan.sort_order, plan.status, plan.supersedes_id, plan.retired_at, now, now,
    )
    .run();
}

async function updatePlan(env: Env, plan: Plan): Promise<void> {
  await env.DB.prepare(
    `UPDATE plans SET name = ?, kind = ?, price_minor = ?, currency = ?, licence_limit = ?,
       term_days = ?, monthly_quota_gb = ?, traffic_gb = ?, validity_days = ?, allow_addons = ?,
       line_ids = ?, up_mbps = ?, down_mbps = ?, channels = ?, store_product_id = ?,
       sort_order = ?, status = ?, supersedes_id = ?, retired_at = ?, updated_at = ?
     WHERE id = ?`,
  )
    .bind(
      plan.name, plan.kind, plan.price_minor, plan.currency, plan.licence_limit,
      plan.term_days, plan.monthly_quota_gb, plan.traffic_gb, plan.validity_days,
      plan.allow_addons ? 1 : 0, JSON.stringify(plan.line_ids), plan.up_mbps, plan.down_mbps,
      JSON.stringify(plan.channels), JSON.stringify(plan.store_product_id),
      plan.sort_order, plan.status, plan.supersedes_id, plan.retired_at,
      new Date().toISOString(), plan.id,
    )
    .run();
}

/** 把 Plan 反向摊平成校验函数能吃的形状（PATCH 合并时用） */
function planToInput(row: PlanRow): Record<string, unknown> {
  const plan = rowToPlan(row);
  return {
    id: plan.id,
    name: plan.name,
    kind: plan.kind,
    price_minor: plan.price_minor,
    currency: plan.currency,
    licence_limit: plan.licence_limit,
    term_days: plan.term_days,
    monthly_quota_gb: plan.monthly_quota_gb,
    traffic_gb: plan.traffic_gb,
    validity_days: plan.validity_days,
    allow_addons: plan.allow_addons,
    line_ids: plan.line_ids,
    up_mbps: plan.up_mbps,
    down_mbps: plan.down_mbps,
    channels: plan.channels,
    store_product_id: plan.store_product_id,
    sort_order: plan.sort_order,
    status: plan.status,
    supersedes_id: plan.supersedes_id,
  };
}

/**
 * @returns 命中时返回 Response；未命中返回 `null`（交给 router 继续匹配）
 */
export async function handleAdminPlans(
  request: Request,
  env: Env,
  actor: string,
): Promise<Response | null> {
  const url = new URL(request.url);
  const path = url.pathname.replace(/^\/api\/admin/, "");
  const method = request.method;

  // ── 列表 ──
  if (method === "GET" && path === "/plans") {
    const status = url.searchParams.get("status");
    const rows = status
      ? await env.DB.prepare(`SELECT ${PLAN_COLUMNS} FROM plans WHERE status = ? ORDER BY sort_order, created_at`)
        .bind(status)
        .all<PlanRow>()
      : await env.DB.prepare(`SELECT ${PLAN_COLUMNS} FROM plans ORDER BY sort_order, created_at`).all<PlanRow>();
    return json({ plans: (rows.results ?? []).map((row) => view(rowToPlan(row))) });
  }

  // ── 预览（不写库）：看清"这单会落成什么控制参数、换购补多少" ──
  if (method === "POST" && path === "/plans/preview") {
    const body = await readBody(request);
    const result = validatePlan((body.plan ?? {}) as Record<string, unknown>);
    if (!result.ok) return json({ error: "invalid_plan", errors: result.errors }, 400);
    const current = (body.current ?? null) as CurrentSubscription | null;
    let control: Record<string, unknown>;
    try {
      control = planToControlParams(result.plan) as unknown as Record<string, unknown>;
    } catch (e) {
      return json({ error: "invalid_plan", errors: [(e as Error).message] }, 400);
    }
    return json({
      plan: view(result.plan),
      control,
      quote: quotePurchase(current, result.plan),
    });
  }

  // ── 新建 ──
  if (method === "POST" && path === "/plans") {
    const body = await readBody(request);
    const result = validatePlan(body);
    if (!result.ok) return json({ error: "invalid_plan", errors: result.errors }, 400);
    if (await loadPlan(env, result.plan.id)) return fail(409, "plan_exists");
    const plan = { ...result.plan, status: "draft" as const };
    await insertPlan(env, plan);
    await audit(env, actor, "plan_created", plan.id, { kind: plan.kind, price_minor: plan.price_minor });
    return json({ plan: view(plan) }, 201);
  }

  // ── 修改（仅草稿） ──
  const patch = path.match(/^\/plans\/([a-z0-9][a-z0-9_-]{1,39})$/);
  if (method === "PATCH" && patch) {
    const row = await loadPlan(env, patch[1]!);
    if (!row) return fail(404, "plan_not_found");
    if (row.status !== "draft") {
      return fail(409, "plan_immutable", "已发布/已下线的套餐不能改，请 clone 一个新版本");
    }
    const body = await readBody(request);
    const merged = { ...planToInput(row), ...body, id: row.id, status: row.status };
    const result = validatePlan(merged);
    if (!result.ok) return json({ error: "invalid_plan", errors: result.errors }, 400);
    await updatePlan(env, { ...result.plan, status: "draft", retired_at: null });
    await audit(env, actor, "plan_updated", row.id, null);
    return json({ plan: view({ ...result.plan, status: "draft", retired_at: null }) });
  }

  // ── 克隆为下一个版本 ──
  const clone = path.match(/^\/plans\/([a-z0-9][a-z0-9_-]{1,39})\/clone$/);
  if (method === "POST" && clone) {
    const row = await loadPlan(env, clone[1]!);
    if (!row) return fail(404, "plan_not_found");
    const body = await readBody(request);
    const merged = {
      ...planToInput(row),
      ...body,
      status: "draft",
      supersedes_id: row.id,
    };
    const result = validatePlan(merged);
    if (!result.ok) return json({ error: "invalid_plan", errors: result.errors }, 400);
    if (await loadPlan(env, result.plan.id)) return fail(409, "plan_exists");
    const plan = { ...result.plan, status: "draft" as const, retired_at: null };
    await insertPlan(env, plan);
    await audit(env, actor, "plan_cloned", plan.id, { supersedes: row.id });
    return json({ plan: view(plan) }, 201);
  }

  // ── 发布 / 下线 ──
  const publish = path.match(/^\/plans\/([a-z0-9][a-z0-9_-]{1,39})\/publish$/);
  if (method === "POST" && publish) {
    const row = await loadPlan(env, publish[1]!);
    if (!row) return fail(404, "plan_not_found");
    if (row.status !== "draft") return fail(409, "invalid_state", "只有草稿可以发布");
    const plan = { ...rowToPlan(row), status: "active" as const };
    await updatePlan(env, plan);
    await audit(env, actor, "plan_published", plan.id, null);
    return json({ plan: view(plan) });
  }

  const retire = path.match(/^\/plans\/([a-z0-9][a-z0-9_-]{1,39})\/retire$/);
  if (method === "POST" && retire) {
    const row = await loadPlan(env, retire[1]!);
    if (!row) return fail(404, "plan_not_found");
    if (row.status === "retired") return fail(409, "invalid_state", "已经是下线状态");
    const plan = { ...rowToPlan(row), status: "retired" as const, retired_at: new Date().toISOString() };
    await updatePlan(env, plan);
    await audit(env, actor, "plan_retired", plan.id, null);
    return json({ plan: view(plan) });
  }

  return null;
}
