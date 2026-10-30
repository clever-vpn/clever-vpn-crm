/**
 * 权益变更时间线（**用户视角**）—— 纯函数 + 一条查询
 *
 * 与 `subscription_changes` 的关系：那张表是**事实账**（后台/客服对账用），
 * 这里是它的**用户可渲染版本**。两者不是同一件事：
 *
 *   - **白名单**：只有 `new / renewal / upgrade / addon / gift / adjust` 进时间线。
 *     `settle`（每月额度重置）与 `hold`（冻结/解冻）**不进** ——
 *     前者每月一行噪音、且容易被误读成"又给了我额度"（规则用
 *     `/subscription.next_reset_at` 表达）；后者是内部原因，用户看到结论就够了。
 *   - **文案由 CRM 出**：App 只按 `title` / `delta_text` / `tone` 渲染，不判断业务。
 *
 * 礼包的兑现信息不需要新表：`logChange(action='gift', detail.rewards)` 已经是完整证据。
 */
import type { Env } from "../env";

/** 进时间线的 action（白名单；改这里等于改用户的账单口径） */
export const TIMELINE_ACTIONS = ["new", "renewal", "upgrade", "addon", "gift", "adjust"] as const;

export interface TimelineItem {
  id: number;
  at: string;
  action: string;
  title: string;
  /** 变化量的一句话（`+7 天` / `+5 GB` / `¥15.00`）；没有变化量时为 null */
  delta_text: string | null;
  /** 前端按它选颜色：success（加量）/ info（调整）/ neutral */
  tone: "neutral" | "success" | "info";
}

const DAY_MS = 86_400_000;

function daysBetween(from: string | null, to: string | null): number | null {
  if (!from || !to) return null;
  const a = Date.parse(from);
  const b = Date.parse(to);
  if (!Number.isFinite(a) || !Number.isFinite(b)) return null;
  const d = Math.round((b - a) / DAY_MS);
  return d === 0 ? null : d;
}

function gbDelta(before: number | null, after: number | null): number | null {
  if (before === null || after === null) return after ?? null;
  const d = Math.round((after - before) * 10) / 10;
  return d === 0 ? null : d;
}

function signed(n: number, unit: string): string {
  return `${n > 0 ? "+" : ""}${n} ${unit}`;
}

function yuan(minor: number): string {
  return `¥${(minor / 100).toFixed(2)}`;
}

interface ChangeRow {
  id: number;
  at: string;
  action: string;
  paid_minor: number | null;
  plan_after: string | null;
  plan_after_name: string | null;
  expires_before: string | null;
  expires_after: string | null;
  period_extra_before: number | null;
  period_extra_after: number | null;
  detail: string | null;
}

/** 一行台账 → 用户能读的一句 */
export function renderChange(row: ChangeRow): TimelineItem | null {
  const days = daysBetween(row.expires_before, row.expires_after);
  const gb = gbDelta(row.period_extra_before, row.period_extra_after);
  const plan = row.plan_after_name ?? row.plan_after;

  let detail: { rewards?: { days?: number; gb?: number } } = {};
  if (row.detail) {
    try {
      detail = JSON.parse(row.detail) as typeof detail;
    } catch {
      detail = {};
    }
  }

  const base = { id: row.id, at: row.at, action: row.action };
  switch (row.action) {
    case "new":
      return {
        ...base,
        title: plan ? `开通 ${plan}` : "开通订阅",
        delta_text: row.paid_minor ? yuan(row.paid_minor) : null,
        tone: "neutral",
      };
    case "renewal":
      return {
        ...base,
        title: days && days > 0 ? `续费 ${days} 天` : "续费",
        delta_text: row.paid_minor ? yuan(row.paid_minor) : null,
        tone: "neutral",
      };
    case "upgrade":
      return {
        ...base,
        title: plan ? `升级到 ${plan}` : "升级",
        delta_text: row.paid_minor ? yuan(row.paid_minor) : null,
        tone: "neutral",
      };
    case "addon":
      return {
        ...base,
        title: gb ? `加购 ${gb} GB` : "加购流量",
        delta_text: row.paid_minor ? yuan(row.paid_minor) : null,
        tone: "neutral",
      };
    case "gift": {
      // 优先用发放时记下的**实际生效**权益（不限量/无限期时会少一项）
      const rewards = detail.rewards ?? {};
      const parts: string[] = [];
      if (rewards.days) parts.push(signed(rewards.days, "天"));
      if (rewards.gb) parts.push(signed(rewards.gb, "GB"));
      if (!parts.length) {
        if (days) parts.push(signed(days, "天"));
        if (gb) parts.push(signed(gb, "GB"));
      }
      return {
        ...base,
        title: "礼包已到账",
        delta_text: parts.length ? parts.join(" · ") : null,
        tone: "success",
      };
    }
    case "adjust": {
      // 补偿/纠错：中性标题 + 变化量。**不暴露操作人、工单号**（那是内部口径）
      const parts: string[] = [];
      if (days) parts.push(signed(days, "天"));
      if (gb) parts.push(signed(gb, "GB"));
      return {
        ...base,
        title: days && days > 0 ? "有效期延长" : "权益调整",
        delta_text: parts.length ? parts.join(" · ") : null,
        tone: "info",
      };
    }
    default:
      return null;
  }
}

/**
 * 时间线一页。
 *
 * `cursor` 是**上一页最后一条的 id**（倒序翻页：`id < cursor`）。
 * 用 id 而不是 OFFSET：台账会一直增长，OFFSET 翻页会漂移（翻着翻着漏条）。
 */
export async function listTimeline(
  env: Env,
  customerId: number,
  opts: { cursor?: number; limit?: number } = {},
): Promise<{ items: TimelineItem[]; next_cursor: number | null }> {
  const limit = Math.min(50, Math.max(1, opts.limit ?? 20));
  const cursor = opts.cursor && opts.cursor > 0 ? opts.cursor : 0;
  const marks = TIMELINE_ACTIONS.map(() => "?").join(",");

  const rows = await env.DB.prepare(
    `SELECT c.id, c.at, c.action, c.paid_minor, c.plan_after, p.name AS plan_after_name,
            c.expires_before, c.expires_after,
            c.period_extra_before, c.period_extra_after, c.detail
       FROM subscription_changes c LEFT JOIN plans p ON p.id = c.plan_after
      WHERE c.customer_id = ?
        AND c.action IN (${marks})
        AND (? = 0 OR c.id < ?)
      ORDER BY c.id DESC
      LIMIT ?`,
  )
    .bind(customerId, ...TIMELINE_ACTIONS, cursor, cursor, limit + 1)
    .all<ChangeRow>();

  const all = (rows.results ?? []).map(renderChange).filter((x): x is TimelineItem => x !== null);
  const hasMore = all.length > limit;
  const items = hasMore ? all.slice(0, limit) : all;
  return { items, next_cursor: hasMore ? (items[items.length - 1]?.id ?? null) : null };
}
