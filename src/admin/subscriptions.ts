/**
 * 管理后台：订阅与结算 `/api/admin/subscriptions*`、`/api/admin/customers*`
 *
 * 现在这里承担两件事：
 *   1. **本地开发/运营兜底**：手工开通订阅、看结算会写出什么（不需要先打通支付）；
 *   2. **结算入口**：`POST /subscriptions/settle` 与定时任务共用 `runSettlement()`，
 *      同一份代码、同一个幂等语义。
 *
 * 支付接入后，`POST /subscriptions` 会被「订单 fulfilled」调用，语义不变——
 * 它只是把**成交那一刻**的套餐快照写成订阅行。
 */

import { planForClient, rowToPlan } from "../plans/model";
import { statusOf, subscriptionFromPlan } from "../plans/subscription";
import {
  customerSubscription,
  listChanges,
  logChange,
  runSettlement,
  upsertSubscription,
} from "../subscriptions/store";

import type { Env } from "../env";
import type { PlanRow } from "../plans/model";

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

export async function handleAdminSubscriptions(
  request: Request,
  env: Env,
  actor: string,
): Promise<Response | null> {
  const url = new URL(request.url);
  const path = url.pathname.replace(/^\/api\/admin/, "");
  const method = request.method;

  // ── 客户（本地测试用；正式由 App 登录创建）──
  if (method === "GET" && path === "/customers") {
    const rows = await env.DB.prepare(
      `SELECT id, email, display_name, status, created_at FROM customers ORDER BY id DESC LIMIT 200`,
    ).all<{ id: number; email: string; display_name: string | null; status: string; created_at: string }>();
    return json({ customers: rows.results ?? [] });
  }

  if (method === "POST" && path === "/customers") {
    const body = await readBody(request);
    const email = typeof body.email === "string" ? body.email.trim().toLowerCase() : "";
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return fail(400, "invalid_email");
    const exists = await env.DB.prepare(`SELECT id FROM customers WHERE email = ?`).bind(email)
      .first<{ id: number }>();
    if (exists) return json({ customer: { id: exists.id, email } });
    const res = await env.DB.prepare(
      `INSERT INTO customers (email, display_name, status, created_at) VALUES (?, ?, 'active', ?)`,
    )
      .bind(email, typeof body.display_name === "string" ? body.display_name : null, new Date().toISOString())
      .run();
    const id = Number(res.meta.last_row_id ?? 0);
    await audit(env, actor, "customer_created", String(id), { email });
    return json({ customer: { id, email } }, 201);
  }

  // ── 当前订阅 + 变更流水（单行模型：一个客户一条） ──
  if (method === "GET" && path === "/subscriptions") {
    const customerId = Number(url.searchParams.get("customer_id") ?? 0);
    if (!customerId) return fail(400, "customer_id_required");
    const subscription = await customerSubscription(env, customerId);
    return json({
      subscription,
      // 状态是算出来的，顺带把原因给后台，避免运营自己算
      state: subscription ? statusOf(subscription) : null,
      changes: await listChanges(env, customerId),
    });
  }

  // ── 手工开通（本地开发 / 运营补单）──
  if (method === "POST" && path === "/subscriptions") {
    const body = await readBody(request);
    const customerId = Number(body.customer_id ?? 0);
    const planId = typeof body.plan_id === "string" ? body.plan_id.trim() : "";
    if (!customerId) return fail(400, "customer_id_required");
    if (!planId) return fail(400, "plan_id_required");

    const planRow = await env.DB.prepare(
      `SELECT id, name, kind, price_minor, currency, licence_limit, term_days, monthly_quota_gb,
         traffic_gb, validity_days, allow_addons, line_ids, up_mbps, down_mbps, sales_channels,
         store_product_id, sort_order, status, retired_at
       FROM plans WHERE id = ?`,
    ).bind(planId).first<PlanRow>();
    if (!planRow) return fail(404, "plan_not_found");

    const plan = rowToPlan(planRow);
    if (plan.kind === "addon") return fail(400, "addon_not_main_subscription", "加购包请走换购流程（暂未开放）");

    const paidMinor = body.paid_minor === undefined || body.paid_minor === null
      ? plan.price_minor
      : Number(body.paid_minor);
    if (!Number.isFinite(paidMinor) || paidMinor < 0) return fail(400, "invalid_paid_minor");

    const now = body.now ? new Date(String(body.now)) : undefined;
    // 单行模型：手工开通 = 覆盖这一行（历史进流水）
    const before = await customerSubscription(env, customerId);
    const draft = subscriptionFromPlan(plan, { customerId, paidMinor, now });
    const id = await upsertSubscription(env, { ...draft, id: before?.id ?? 0 });
    const after = await customerSubscription(env, customerId);
    await logChange(env, {
      customer_id: customerId,
      subscription_id: id,
      action: "new",
      before,
      after,
      paid_minor: paidMinor,
      detail: { plan_id: plan.id, kind: plan.kind, by: "admin" },
    });
    await audit(env, actor, "subscription_created", String(id), { plan: plan.id, paid_minor: paidMinor });
    return json({ subscription: { id, ...draft }, plan: planForClient(plan) }, 201);
  }

  // ── 跑一次结算（默认 dry-run，避免误写线上）──
  if (method === "POST" && path === "/subscriptions/settle") {
    const body = await readBody(request);
    const dryRun = body.dry_run !== false;
    const customerId = body.customer_id ? Number(body.customer_id) : undefined;
    const report = await runSettlement(env, { dryRun, customerId });
    if (!dryRun && report.settled) {
      await audit(env, actor, "subscriptions_settled", "-", { settled: report.settled });
    }
    return json({ ...report, dry_run: dryRun });
  }

  return null;
}
