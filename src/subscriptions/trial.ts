/**
 * 免费试用（**套餐 → 订阅 → cf-api 客户**，全程不走支付网关）
 *
 * 为什么是"套餐"而不是"礼包"：
 *   礼包是**营销动作**（对已有订阅加天数/流量），它回答不了"这 7 天给多少流量、
 *   几条线路、几个设备"—— 那些只有套餐知道。所以试用必须是**一个真套餐**：
 *   `plans.trial = 1`（全库最多一个），0 元 + hidden，不进 `/plans`、不能下单。
 *
 * 链路（与付费完全同一条，只是不经过网关）：
 *
 *   注册 → 建一张 0 元已付订单（`source='signup'`）→ 建订阅 → 建 cf-api 客户
 *
 * 落订单不是为了收钱，而是为了复用现成的 `provisioning` + `retryProvisioning`：
 * cf-api 挂了不能把注册打挂，订单停在 `provisioning` 等重试即可。
 *
 * 幂等：一个客户只有一行订阅（`uq_subs_customer`），且 `source='signup'` 的订单
 * 只可能有一张 —— 重复调用（注册流程重放、并发）第二次直接跳过。
 */
import { rowToPlan } from "../plans/model";
import { subscriptionFromPlan } from "../plans/subscription";
import { provisionOrder } from "../platform/provision";
import { customerSubscription, logChange, upsertSubscription } from "./store";

import type { Env } from "../env";
import type { Plan } from "../plans/model";

/** `GET /trial` 的返回体：CRM **组织好**给 App 直接显示的内容 */
export interface TrialInfo {
  available: boolean;
  plan_name: string | null;
  /** 试用天数（= 套餐 term_days） */
  days: number | null;
  /** 试用流量（GB）；`unlimited` 为 true 时没有意义 */
  quota_gb: number | null;
  unlimited: boolean;
  licence_limit: number | null;
  /** 给注册页直接显示的一句（用户可见文案的唯一来源在 CRM） */
  text: string;
}

export interface TrialStart {
  granted: boolean;
  /** 没开通的原因（中文整句，写日志/后台用） */
  reason: string | null;
  order_id: number | null;
  plan_id: string | null;
}

const UNAVAILABLE: TrialInfo = {
  available: false,
  plan_name: null,
  days: null,
  quota_gb: null,
  unlimited: false,
  licence_limit: null,
  text: "",
};

/** 读那个唯一的试用套餐（`trial = 1` 且 `active`） */
export async function loadTrialPlan(env: Env): Promise<Plan | null> {
  const row = await env.DB.prepare(
    `SELECT id, name, kind, price_minor, currency, licence_limit, term_days, monthly_quota_gb,
       traffic_gb, validity_days, line_ids, up_mbps, down_mbps, sales_channels,
       store_product_id, sort_order, status, retired_at, trial
     FROM plans WHERE trial = 1 AND status = 'active' LIMIT 1`,
  ).first<Parameters<typeof rowToPlan>[0]>();
  return row ? rowToPlan(row) : null;
}

/** 给注册页/定价页的「能免费试用吗」—— 免登录可调，只回展示材料，不含任何业务判断 */
export async function trialInfo(env: Env): Promise<TrialInfo> {
  const plan = await loadTrialPlan(env);
  if (!plan || plan.kind !== "period" || !plan.term_days) return UNAVAILABLE;

  const unlimited = plan.monthly_quota_gb === null;
  const quota = unlimited ? "不限量" : `${plan.monthly_quota_gb}GB`;
  return {
    available: true,
    plan_name: plan.name,
    days: plan.term_days,
    quota_gb: plan.monthly_quota_gb,
    unlimited,
    licence_limit: plan.licence_limit,
    text: `注册即送 ${plan.term_days} 天免费试用（${quota}）`,
  };
}

function orderCode(now: Date, customerId: number): string {
  // T + 时间戳 + 客户号 + 3 位随机：人可读、可追溯，且不会与购买单/赠单撞号
  const stamp = now.toISOString().replace(/\D/g, "").slice(0, 14);
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  const bytes = new Uint8Array(3);
  crypto.getRandomValues(bytes);
  let suffix = "";
  for (const b of bytes) suffix += alphabet[b % alphabet.length];
  return `T${stamp}${String(customerId).padStart(6, "0")}${suffix}`;
}

/**
 * 给一个**新注册**的客户开通免费试用。
 *
 * 调用点在注册流程里，所以它**绝不能抛**：任何失败都只是"没开上试用"，
 * 不能把登录打挂。
 */
export async function startTrial(
  env: Env,
  customerId: number,
  now: Date = new Date(),
): Promise<TrialStart> {
  const plan = await loadTrialPlan(env);
  if (!plan) {
    return { granted: false, reason: "未配置免费试用套餐", order_id: null, plan_id: null };
  }

  // ① 已有订阅（哪怕已过期）⇒ 不再开第二次：试用只能领一次
  const existing = await customerSubscription(env, customerId);
  if (existing) {
    return { granted: false, reason: "已有订阅", order_id: null, plan_id: plan.id };
  }

  // ② 兜底幂等：订阅行可能被清理，但 signup 订单是"开过试用"的铁证
  const started = await env.DB.prepare(
    `SELECT id FROM orders WHERE customer_id = ? AND source = 'signup' LIMIT 1`,
  )
    .bind(customerId)
    .first<{ id: number }>();
  if (started) {
    return { granted: false, reason: "试用已开通过", order_id: started.id, plan_id: plan.id };
  }

  const iso = now.toISOString();
  // 订单直接进 `provisioning`：这就是"等待落账"的状态，失败由 retryProvisioning 接手
  const order = await env.DB.prepare(
    `INSERT INTO orders (code, customer_id, plan_id, kind, plan_snapshot, amount_minor,
       discount_minor, currency, source, payment_method, entry, status, paid_at, note,
       created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, 0, 0, ?, 'signup', 'gift', 'app', 'provisioning', ?, ?, ?, ?)`,
  )
    .bind(
      orderCode(now, customerId),
      customerId,
      plan.id,
      plan.kind,
      JSON.stringify(plan),
      plan.currency,
      iso,
      `免费试用「${plan.name}」`,
      iso,
      iso,
    )
    .run();
  const orderId = Number(order.meta.last_row_id ?? 0);

  // ③ 订阅 = 套餐快照（`trial = true` 由 plan.trial 带过来）
  const draft = subscriptionFromPlan(plan, { customerId, paidMinor: 0, now });
  const next = { ...draft, id: 0, order_id: orderId };
  const subscriptionId = await upsertSubscription(env, next);

  await logChange(env, {
    customer_id: customerId,
    subscription_id: subscriptionId,
    action: "new",
    before: null,
    after: { ...next, id: subscriptionId },
    paid_minor: 0,
    detail: { source: "trial", order_id: orderId, plan_id: plan.id },
  });

  // 先记关联，再落账：落账失败时订单停在 provisioning，cron 只重做这一步
  await env.DB.prepare(`UPDATE orders SET subscription_id = ?, updated_at = ? WHERE id = ?`)
    .bind(subscriptionId, iso, orderId)
    .run();

  try {
    await provisionOrder(env, orderId);
  } catch (e) {
    console.error(
      `[trial] 落账失败 customer=${customerId} plan=${plan.id}: ${e instanceof Error ? e.message : e}`,
    );
  }

  return { granted: true, reason: null, order_id: orderId, plan_id: plan.id };
}
