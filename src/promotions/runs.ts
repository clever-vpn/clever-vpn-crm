/**
 * 批量发放（**分页 + 重入**）
 *
 * 一个问题：**上万人不能在一次请求里发完**。
 *
 * Cloudflare 的硬约束（写在这里当编程边界，别当耳旁风）：
 *   - CPU：单次 invocation 30s（cron 可到 300s 但要申请）
 *   - 墙钟：cron 15 分钟；HTTP 请求也可能被掐
 *   - 子请求：付费版 1000 / 次；**同时在飞的连接只有 6 个**
 *   - D1：单次 invocation 的查询数也有上限，且是串行吞吐瓶颈
 *
 * 一个人的发放要 ~8 次 D1 + 1 次 cf-api HTTP ⇒ 一次最多几十上百人。
 * 所以这里把"给一万人发"拆成：
 *
 *   建任务（后台按钮，立刻返回） → 冻结 `MAX(customers.id)` 与总数
 *   每个 tick 处理一批（默认 50 人，并发 6） → 推进 id 游标
 *   跑完置 `done`
 *
 * 三个不变式：
 *   1. **每次只做有界的一小片**（`RUN_BATCH`），撞线就停、下一轮接着来；
 *   2. **进度只在表里**（内存丢失 = 下次从游标重来）；
 *   3. **重跑安全**：`redemptions` 的 `(promotion_id, customer_id)` 唯一索引
 *      保证同一个人不会拿到两份（见 `promotions/redemption.ts`）。
 *
 * 人群筛选**不做 SQL 预筛**：直接枚举客户，把"这人符不符合条件"交给
 * `deliverGift`（它内部就是 `checkForCustomer`）。多花一点查询，换来的是
 * **只有一套判定逻辑** —— 批量与单人发放绝不会给出两个结论。
 */
import { deliverGift } from "./gift";
import { PROMOTION_COLUMNS, rowToPromotion } from "./model";

import type { Env } from "../env";
import type { Promotion, PromotionRow } from "./model";

/** 每批处理多少人（50 × ~8 次 D1 ≈ 400 查询，稳在单次上限内） */
export const RUN_BATCH = 50;

/** 并发上限 = Workers 单次调用"同时在飞"的连接数，配大了没有意义 */
export const RUN_CONCURRENCY = 6;

export interface PromotionRun {
  id: number;
  promotion_id: number;
  snapshot_max_id: number;
  cursor: number;
  total: number;
  processed: number;
  granted: number;
  pending: number;
  skipped: number;
  failed: number;
  status: "running" | "done" | "cancelled";
  created_at: string;
  updated_at: string;
  finished_at: string | null;
}

const RUN_COLUMNS = `id, promotion_id, snapshot_max_id, cursor, total, processed,
  granted, pending, skipped, failed, status, created_at, updated_at, finished_at`;

function rowToRun(row: Record<string, unknown>): PromotionRun {
  const n = (v: unknown) => Number(v ?? 0);
  return {
    id: n(row.id),
    promotion_id: n(row.promotion_id),
    snapshot_max_id: n(row.snapshot_max_id),
    cursor: n(row.cursor),
    total: n(row.total),
    processed: n(row.processed),
    granted: n(row.granted),
    pending: n(row.pending),
    skipped: n(row.skipped),
    failed: n(row.failed),
    status:
      row.status === "done" ? "done" : row.status === "cancelled" ? "cancelled" : "running",
    created_at: String(row.created_at ?? ""),
    updated_at: String(row.updated_at ?? ""),
    finished_at: row.finished_at ? String(row.finished_at) : null,
  };
}

export async function getRun(env: Env, runId: number): Promise<PromotionRun | null> {
  const row = await env.DB.prepare(`SELECT ${RUN_COLUMNS} FROM promotion_runs WHERE id = ?`)
    .bind(runId)
    .first<Record<string, unknown>>();
  return row ? rowToRun(row) : null;
}

/** 这个活动最近一次任务（后台展示进度用） */
export async function latestRun(env: Env, promotionId: number): Promise<PromotionRun | null> {
  const row = await env.DB.prepare(
    `SELECT ${RUN_COLUMNS} FROM promotion_runs WHERE promotion_id = ? ORDER BY id DESC LIMIT 1`,
  )
    .bind(promotionId)
    .first<Record<string, unknown>>();
  return row ? rowToRun(row) : null;
}

/**
 * 建一个批量任务。**只有建任务，不发放**（立刻返回，前端轮询进度）。
 *
 * 冻结两件事：`snapshot_max_id`（客户上界）与 `total`（分母）。冻结上界是为了
 * "能跑完" —— 不冻结的话，跑的过程中新注册的人会让任务永远追不上。
 */
export async function startRun(
  env: Env,
  opts: { promotionId: number; now?: Date },
): Promise<{ run: PromotionRun; alreadyRunning: boolean }> {
  const now = opts.now ?? new Date();
  const nowIso = now.toISOString();

  const running = await env.DB.prepare(
    `SELECT ${RUN_COLUMNS} FROM promotion_runs
      WHERE promotion_id = ? AND status = 'running' ORDER BY id DESC LIMIT 1`,
  )
    .bind(opts.promotionId)
    .first<Record<string, unknown>>();
  if (running) return { run: rowToRun(running), alreadyRunning: true };

  const bounds = await env.DB.prepare(
    `SELECT COALESCE(MAX(id), 0) AS max_id, COUNT(*) AS total FROM customers`,
  ).first<{ max_id: number; total: number }>();
  const snapshot = Number(bounds?.max_id ?? 0);
  const total = Number(bounds?.total ?? 0);

  const res = await env.DB.prepare(
    `INSERT INTO promotion_runs (promotion_id, snapshot_max_id, cursor, total, status,
       created_at, updated_at)
     VALUES (?, ?, 0, ?, 'running', ?, ?)`,
  )
    .bind(opts.promotionId, snapshot, total, nowIso, nowIso)
    .run();

  const run = await getRun(env, Number(res.meta.last_row_id ?? 0));
  if (!run) throw new Error("批量任务创建失败");
  return { run, alreadyRunning: false };
}

export interface BatchReport {
  runId: number;
  processed: number;
  granted: number;
  pending: number;
  skipped: number;
  failed: number;
  /** 这一轮之后是否还有剩 */
  hasMore: boolean;
}

/**
 * 处理**一批**（cron 每 tick 调一次）。
 *
 * - 取一个 `running` 的任务（最早的那个）；
 * - 按 id 游标取 `RUN_BATCH` 个客户，并发 6 逐个 `deliverGift`；
 * - 单人失败只记 `failed`，**不中断整轮**（平台抖动不该让一千人白等）；
 * - 一批不满或游标到顶 ⇒ 置 `done`。
 *
 * 没有可跑的任务时返回 `null`（cron 就该干别的去了）。
 */
export async function runNextBatch(
  env: Env,
  opts: { now?: Date; batch?: number } = {},
): Promise<BatchReport | null> {
  const now = opts.now ?? new Date();
  const nowIso = now.toISOString();
  const batch = Math.max(1, Math.min(200, opts.batch ?? RUN_BATCH));

  const row = await env.DB.prepare(
    `SELECT ${RUN_COLUMNS} FROM promotion_runs WHERE status = 'running' ORDER BY id ASC LIMIT 1`,
  ).first<Record<string, unknown>>();
  if (!row) return null;
  const run = rowToRun(row);

  const promoRow = await env.DB.prepare(`SELECT ${PROMOTION_COLUMNS} FROM promotions WHERE id = ?`)
    .bind(run.promotion_id)
    .first<PromotionRow>();
  // 活动被删了 / 不是礼包 ⇒ 任务作废（否则每 tick 都会白跑一批）
  if (!promoRow) {
    await env.DB.prepare(
      `UPDATE promotion_runs SET status = 'cancelled', finished_at = ?, updated_at = ? WHERE id = ?`,
    )
      .bind(nowIso, nowIso, run.id)
      .run();
    return {
      runId: run.id,
      processed: 0,
      granted: 0,
      pending: 0,
      skipped: 0,
      failed: 0,
      hasMore: false,
    };
  }
  const promo: Promotion = rowToPromotion(promoRow);

  const targetRows = await env.DB.prepare(
    `SELECT id FROM customers
      WHERE id > ? AND id <= ? ORDER BY id ASC LIMIT ?`,
  )
    .bind(run.cursor, run.snapshot_max_id, batch)
    .all<{ id: number }>();
  const ids = (targetRows.results ?? []).map((r) => Number(r.id));

  let granted = 0;
  let pending = 0;
  let skipped = 0;
  let failed = 0;
  let cursor = run.cursor;

  // 并发 6（Workers 同时在飞的上限）；每人独立 try，一个失败不牵连别人
  for (let i = 0; i < ids.length; i += RUN_CONCURRENCY) {
    const chunk = ids.slice(i, i + RUN_CONCURRENCY);
    const results = await Promise.all(
      chunk.map(async (customerId) => {
        try {
          const r = await deliverGift(env, {
            promotionId: promo.id,
            customerId,
            source: "manual",
            now,
          });
          if (!r) return "skipped" as const;
          if (r.granted) return "granted" as const;
          if (r.pending) return "pending" as const;
          return "skipped" as const;
        } catch (e) {
          console.error(
            `[run] 发放异常 promo=${promo.id} customer=${customerId}: ${e instanceof Error ? e.message : e}`,
          );
          return "failed" as const;
        }
      }),
    );
    for (const r of results) {
      if (r === "granted") granted += 1;
      else if (r === "pending") pending += 1;
      else if (r === "failed") failed += 1;
      else skipped += 1;
    }
    cursor = chunk[chunk.length - 1] ?? cursor;
  }

  const reachedEnd = ids.length < batch || cursor >= run.snapshot_max_id;
  await env.DB.prepare(
    `UPDATE promotion_runs SET cursor = ?, processed = processed + ?,
       granted = granted + ?, pending = pending + ?, skipped = skipped + ?, failed = failed + ?,
       status = ?, finished_at = ?, updated_at = ?
     WHERE id = ?`,
  )
    .bind(
      cursor,
      ids.length,
      granted,
      pending,
      skipped,
      failed,
      reachedEnd ? "done" : "running",
      reachedEnd ? nowIso : null,
      nowIso,
      run.id,
    )
    .run();

  return {
    runId: run.id,
    processed: ids.length,
    granted,
    pending,
    skipped,
    failed,
    hasMore: !reachedEnd,
  };
}

/** 取消（已发出的不退；剩下的不再处理） */
export async function cancelRun(
  env: Env,
  runId: number,
  now: Date = new Date(),
): Promise<boolean> {
  const res = await env.DB.prepare(
    `UPDATE promotion_runs SET status = 'cancelled', finished_at = ?, updated_at = ?
      WHERE id = ? AND status = 'running'`,
  )
    .bind(now.toISOString(), now.toISOString(), runId)
    .run();
  return Number(res.meta.changes ?? 0) > 0;
}

/** 进度文案（后台直接显示，前端不拼） */
export function runProgressText(run: PromotionRun): string {
  if (run.status === "cancelled") return `已取消（${run.processed} / ${run.total}）`;
  if (run.status === "done") {
    return `已完成：到账 ${run.granted} · 发券 ${run.pending} · 跳过 ${run.skipped} · 失败 ${run.failed}`;
  }
  return `进行中 ${run.processed} / ${run.total}（到账 ${run.granted} · 发券 ${run.pending} · 跳过 ${run.skipped}）`;
}
