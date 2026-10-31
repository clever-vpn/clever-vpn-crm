/**
 * 营销 · 优惠券 / 礼包 / 邀请 —— 列表页
 *
 * 三种物件共用一张列表，但**列和表单都按类型定制**：
 *   优惠券 —— 改订单金额（自动生效 或 凭码）
 *   礼包   —— 改订阅权益（送天数 / 送流量）
 *   邀请   —— 建关系（唯一能回答"谁拉来的"）
 *
 * 这里**不做任何价格判断**：能不能用、便宜多少，全在服务端
 * （`src/promotions/*`），所以后台看到的与 App / 官网必然一致。
 *
 * 表单是右侧抽屉（`./promotion/Form.tsx`），不是列表下方的内联卡片 ——
 * 内联卡片一长，用户必须滚到底才能找到「取消」。
 */
import { useCallback, useEffect, useState } from "react";

import {
  api,
  ApiError,
  type PromotionDraft,
  type PromotionKind,
  type PromotionView,
} from "../api";
import { AUDIENCE_OPTIONS, PromotionForm, emptyDraft } from "./promotion/Form";
import type { CodeMode } from "./promotion/Form";

const message = (err: unknown, fallback: string) =>
  err instanceof ApiError && err.message && err.message !== err.code
    ? err.message
    : fallback;

const PLAN_KINDS: { value: string; label: string }[] = [
  { value: "period", label: "周期套餐" },
  { value: "traffic", label: "流量套餐" },
  { value: "addon", label: "加购包" },
];

const yuan = (minor: number): string => (minor / 100).toFixed(2);

function benefitLabel(p: { benefit_type: string; benefit_value: number }): string {
  return p.benefit_type === "percent" ? `减 ${p.benefit_value}%` : `立减 ¥${yuan(p.benefit_value)}`;
}

/** 礼包的内容：送多少天 / 多少 GB（两个维度独立，谁也没连带） */
function rewardsLabel(r: { days: number; gb: number }): string {
  const parts: string[] = [];
  if (r.days > 0) parts.push(`+${r.days} 天`);
  if (r.gb > 0) parts.push(`+${r.gb} GB`);
  return parts.length ? parts.join(" · ") : "空礼包";
}

function audienceLabel(p: PromotionView): string {
  const label = AUDIENCE_OPTIONS.find((a) => a.value === p.audience)?.label ?? "所有人";
  const parts = [p.audience === "expiring" ? `${label}（${p.audience_days ?? 7} 天内）` : label];
  if (p.new_user_within_days !== null) parts.push(`注册 ${p.new_user_within_days} 天内`);
  if (p.cooldown_hours !== null) parts.push(`${p.cooldown_hours}h 冷却`);
  return parts.join(" · ");
}

function scopeLabel(p: PromotionView): string {
  const parts: string[] = [];
  if (p.limit_plan_kinds.length) {
    parts.push(p.limit_plan_kinds.map((k) => PLAN_KINDS.find((x) => x.value === k)?.label ?? k).join("/"));
  }
  if (p.limit_plan_ids.length) parts.push(`${p.limit_plan_ids.length} 个指定套餐`);
  if (p.min_subtotal_minor > 0) parts.push(`满 ¥${yuan(p.min_subtotal_minor)}`);
  return parts.length ? parts.join(" · ") : "全部套餐";
}

function windowLabel(p: PromotionView): string {
  if (!p.starts_at && !p.ends_at) return "长期";
  const d = (iso: string | null) => (iso ? iso.slice(0, 10) : "—");
  return `${d(p.starts_at)} → ${d(p.ends_at)}`;
}

/**
 * 「怎么送出去」：从 auto_apply / 码统计 / 人群 推导，不让用户猜。
 *
 * 两种渠道（契约 §2.9.3）：
 *   - 自动生效 → **站内**：定价页展示（可带角标），结账自动抵扣
 *   - 凭码    → **站外**：博主 / 群 / 实体卡，定价页不出现
 *
 * 码的形态由「每码可用几次」决定，不用再分"主码/批次码"两种概念：
 *   1 个码 + 可用 N 次 = 共享码；N 个码 + 各 1 次 = 一人一码
 */
function deliveryLabel(p: PromotionView): string {
  const ways: string[] = [];
  // 礼包是**货架上的一条活动**：用户自己来领，不预先发出去
  if (p.kind === "gift") {
    ways.push(p.visible ? "货架可见" : "定向可见");
    const stats = p.code_stats;
    if (stats && stats.codes > 0) ways.push(`${stats.codes} 个码`);
    return ways.join(" / ");
  }
  if (p.auto_apply) {
    ways.push(p.visible ? "站内展示" : "站内自动抵扣");
  } else {
    const stats = p.code_stats;
    if (stats && stats.codes > 0) {
      if (stats.codes === 1) ways.push(`站外共享码（${stats.capacity ?? "不限"} 人）`);
      else ways.push(`站外 ${stats.codes} 个码（一码一人）`);
    } else {
      ways.push("站外（未发码）");
    }
  }
  if (p.audience === "expiring") ways.push("到期自动");
  return ways.join(" / ");
}

const STATUS_TAG: Record<string, string> = { draft: "tag-draft", active: "tag-active", ended: "tag-retired" };
const STATUS_LABEL: Record<string, string> = { draft: "草稿", active: "进行中", ended: "已结束" };

const TITLES: Record<PromotionKind, string> = { coupon: "优惠券", gift: "礼包", referral: "邀请返利" };
const INTROS: Record<PromotionKind, string> = {
  coupon: "让这一单少付钱。自动生效不用发码；凭码用于渠道投放与归因。",
  gift: "白送天数 / 流量。上线后出现在用户的「我的礼包」里，先到先得；也可配兑换码。",
  referral: "唯一的「谁拉来的」来源。邀请码永远选填，奖励只给权益。",
};

export default function Promotions({ kind }: { kind: PromotionKind }) {
  const [items, setItems] = useState<PromotionView[]>([]);
  const [draft, setDraft] = useState<PromotionDraft | null>(null);
  const [editingId, setEditingId] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const isGift = kind === "gift";

  const reload = useCallback(async () => {
    try {
      const r = await api.promotions();
      setItems(r.promotions.filter((p) => p.kind === kind));
    } catch (e) {
      setError(e instanceof ApiError ? e.message : "加载失败");
    }
  }, [kind]);

  useEffect(() => {
    setDraft(null);
    setEditingId(null);
    void reload();
  }, [reload]);

  async function run(action: () => Promise<unknown>, okMessage: string) {
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      await action();
      setNotice(okMessage);
      await reload();
      return true;
    } catch (e) {
      setError(e instanceof ApiError ? e.message : String(e));
      return false;
    } finally {
      setBusy(false);
    }
  }

  async function save(codes: { mode: CodeMode; count: number }) {
    if (!draft) return;

    // 新建：先建活动拿到 id，再按选择生成码（码要挂在 promotions.id 上）
    if (editingId === null) {
      const ok = await run(async () => {
        const created = await api.createPromotion(draft);
        if (codes.mode !== "none" && codes.count > 0) {
          // 共享码 = 1 个码 + 可用 N 次；一人一码 = N 个码 + 各 1 次
          await api.generatePromotionCodes(created.promotion.id, {
            count: codes.mode === "shared" ? 1 : codes.count,
            max_uses: codes.mode === "shared" ? codes.count : 1,
          });
        }
      }, codes.mode === "none" ? "已创建草稿（上线后才会生效）" : "已创建草稿并生成码（上线后生效）");
      if (ok) {
        setDraft(null);
        setEditingId(null);
      }
      return;
    }

    const ok = await run(() => api.updatePromotion(editingId, draft), "已保存");
    if (ok) {
      setDraft(null);
      setEditingId(null);
    }
  }

  const codeStatsOf = (id: number) => items.find((x) => x.id === id)?.code_stats ?? null;

  function edit(p: PromotionView) {
    const { id: _id, status: _s, uses: _u, ...rest } = p;
    setDraft({ ...rest, badge_label: rest.badge_label ?? "" });
    setEditingId(p.id);
  }

  return (
    <div className="stack">
      <div className="card">
        <div className="row between">
          <div>
            <h3>{TITLES[kind]}</h3>
            <p className="hint">{INTROS[kind]}</p>
          </div>
          <button
            className="primary"
            disabled={busy}
            onClick={() => {
              setEditingId(null);
              setDraft(emptyDraft(kind));
            }}
          >
            新建{TITLES[kind].replace("返利", "活动")}
          </button>
        </div>

        {error && <div className="notice error">{error}</div>}
        {notice && <div className="notice ok">{notice}</div>}

        {items.length === 0 ? (
          <div className="empty">
            <span className="ico">◈</span>还没有活动。先建一个草稿，点「上线」后立刻生效（不用发版）。
          </div>
        ) : (
          <div className="table-wrap">
            <table className="table">
              <thead>
                <tr>
                  <th>名称</th>
                  <th>怎么送</th>
                  <th>{isGift ? "送什么" : "力度"}</th>
                  <th>人群</th>
                  <th>范围</th>
                  <th>核销 / 名额</th>
                  <th>有效期</th>
                  <th>状态</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {items.map((p) => (
                  <tr key={p.id}>
                    <td className="wrap">
                      <strong>{p.name}</strong>
                      {/* 用户在定价页真正看到的那句话（含系统人群前缀） */}
                      {p.visible && p.badge_label_full ? (
                        <div className="mono">角标：{p.badge_label_full}</div>
                      ) : null}
                    </td>
                    <td>{deliveryLabel(p)}</td>
                    <td>{isGift ? rewardsLabel(p.rewards) : benefitLabel(p)}</td>
                    <td>{audienceLabel(p)}</td>
                    <td>{scopeLabel(p)}</td>
                    <td>
                      {p.uses ?? 0} / {p.code_stats?.capacity ?? p.max_uses ?? "不限"}
                      <div className="mono">
                        {p.code_stats && p.code_stats.codes > 0 ? `${p.code_stats.codes} 个码` : "无码"}
                      </div>
                    </td>
                    <td>{windowLabel(p)}</td>
                    <td>
                      <span className={`tag ${STATUS_TAG[p.status] ?? "tag-dim"}`}>
                        {STATUS_LABEL[p.status] ?? p.status}
                      </span>
                    </td>
                    <td className="actions">
                      <button disabled={busy} onClick={() => edit(p)}>
                        编辑
                      </button>
                      {p.status === "draft" && (
                        <button className="primary" disabled={busy} onClick={() => void run(() => api.publishPromotion(p.id), "已上线")}>
                          上线
                        </button>
                      )}
                      {p.status === "active" && (
                        <button className="danger" disabled={busy} onClick={() => void run(() => api.endPromotion(p.id), "已结束")}>
                          结束
                        </button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

        <p className="hint" style={{ marginTop: 12 }}>
          {isGift
            ? "礼包只改权益：不改金额、不改残值，也不产生订单。凭证是核销行（含活动快照），历史在订阅变更里。入口只有货架 —— 用户在 App 里自己点领取，后台不代领。"
            : "规则：一次下单最多生效一个折扣（多个命中取更优，不叠加）；核销在支付成功后才记录。"}
        </p>
      </div>

      {draft && (
        <PromotionForm
          draft={draft}
          promotionId={editingId}
          codeStats={editingId === null ? null : codeStatsOf(editingId)}
          busy={busy}
          isNew={editingId === null}
          onChange={setDraft}
          onClose={() => {
            setDraft(null);
            setEditingId(null);
          }}
          onSave={save}
          onCodesChanged={() => void reload()}
        />
      )}
    </div>
  );
}
