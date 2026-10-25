/**
 * 营销 · 优惠券 / 礼包 / 邀请 —— 列表页
 *
 * 三种物件共用一张列表，但**列和表单都按类型定制**：
 *   优惠券 —— 改订单金额（自动生效 或 凭码）
 *   礼包   —— 改订阅权益（送天数 / 送流量 / 重置本月）
 *   邀请   —— 建关系（唯一能回答"谁拉来的"）
 *
 * 这里**不做任何价格判断**：能不能用、便宜多少，全在服务端
 * （`src/promotions/*`），所以后台看到的与 App / 官网必然一致。
 *
 * 表单是右侧抽屉（`./promotion/Form.tsx`），不是列表下方的内联卡片 ——
 * 内联卡片一长，用户必须滚到底才能找到「取消」。
 */
import { useCallback, useEffect, useState } from "react";

import { api, ApiError, type PromotionDraft, type PromotionKind, type PromotionView } from "../api";
import { AUDIENCE_OPTIONS, PromotionForm, emptyDraft } from "./promotion/Form";

const PLAN_KINDS: { value: string; label: string }[] = [
  { value: "period", label: "周期套餐" },
  { value: "traffic", label: "流量套餐" },
  { value: "addon", label: "加购包" },
];

const yuan = (minor: number): string => (minor / 100).toFixed(2);

function benefitLabel(p: { benefit_type: string; benefit_value: number }): string {
  return p.benefit_type === "percent" ? `减 ${p.benefit_value}%` : `立减 ¥${yuan(p.benefit_value)}`;
}

/** 礼包的内容：送多少天 / 多少 GB / 是否清零本月 */
function rewardsLabel(r: { days: number; gb: number; reset_month: boolean }): string {
  const parts: string[] = [];
  if (r.days > 0) parts.push(`+${r.days} 天`);
  if (r.gb > 0) parts.push(`+${r.gb} GB`);
  if (r.reset_month) parts.push("重置本月");
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
  if (p.plan_id) parts.push(`载体 ${p.plan_id}`);
  return parts.length ? parts.join(" · ") : "全部套餐";
}

function windowLabel(p: PromotionView): string {
  if (!p.starts_at && !p.ends_at) return "长期";
  const d = (iso: string | null) => (iso ? iso.slice(0, 10) : "—");
  return `${d(p.starts_at)} → ${d(p.ends_at)}`;
}

/** 礼包「怎么送出去」：从人群与码推导，不让用户猜 */
function deliveryLabel(p: PromotionView): string {
  const ways: string[] = [];
  if (p.code) ways.push(`码 ${p.code}`);
  if (p.audience === "new") ways.push("首单自动");
  if (p.audience === "expiring") ways.push("到期自动");
  ways.push("后台手动");
  return ways.join(" / ");
}

const STATUS_TAG: Record<string, string> = { draft: "tag-draft", active: "tag-active", ended: "tag-retired" };
const STATUS_LABEL: Record<string, string> = { draft: "草稿", active: "进行中", ended: "已结束" };

const TITLES: Record<PromotionKind, string> = { coupon: "优惠券", gift: "礼包", referral: "邀请返利" };
const INTROS: Record<PromotionKind, string> = {
  coupon: "让这一单少付钱。自动生效不用发码；凭码用于渠道投放与归因。",
  gift: "白送天数 / 流量。可以直接发，也可以设一个兑换码让用户自助领取。",
  referral: "唯一的「谁拉来的」来源。邀请码永远选填，奖励只给权益。",
};

export default function Promotions({ kind }: { kind: PromotionKind }) {
  const [items, setItems] = useState<PromotionView[]>([]);
  const [draft, setDraft] = useState<PromotionDraft | null>(null);
  const [editingId, setEditingId] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [granting, setGranting] = useState<number | null>(null);
  const [grantIds, setGrantIds] = useState("");

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

  async function save() {
    if (!draft) return;
    const ok = await run(
      () => (editingId === null ? api.createPromotion(draft) : api.updatePromotion(editingId, draft)),
      editingId === null ? "已创建草稿（上线后才会生效）" : "已保存",
    );
    if (ok) {
      setDraft(null);
      setEditingId(null);
    }
  }

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
                  <th>{isGift ? "怎么送" : "生效方式"}</th>
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
                      {p.badge_label ? <div className="mono">角标：{p.badge_label}</div> : null}
                    </td>
                    <td className={p.code ? "mono" : ""}>{isGift ? deliveryLabel(p) : p.code ?? "自动生效"}</td>
                    <td>{isGift ? rewardsLabel(p.rewards) : benefitLabel(p)}</td>
                    <td>{audienceLabel(p)}</td>
                    <td>{scopeLabel(p)}</td>
                    <td>
                      {p.uses ?? 0} / {p.max_uses ?? "不限"}
                      <div className="mono">每人 {p.max_uses_per_customer} 次</div>
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
                      {isGift && p.status === "active" && (
                        <button
                          disabled={busy}
                          onClick={() => {
                            setGranting(granting === p.id ? null : p.id);
                            setGrantIds("");
                          }}
                        >
                          {granting === p.id ? "收起" : "发放"}
                        </button>
                      )}
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

        {granting !== null && (
          <div className="notice" style={{ marginTop: 12 }}>
            <div className="row between">
              <strong>手动发放</strong>
              <span className="hint">填客户 ID（逗号分隔）；没有订阅的人会被跳过并说明原因</span>
            </div>
            <div className="row" style={{ gap: 8, marginTop: 8 }}>
              <input
                value={grantIds}
                onChange={(e) => setGrantIds(e.target.value)}
                placeholder="12, 34"
                style={{ flex: 1 }}
              />
              <button
                className="primary"
                disabled={busy || !grantIds.trim()}
                onClick={() => {
                  const ids = grantIds
                    .split(/[,，\s]+/)
                    .map((x) => Number(x))
                    .filter((n) => Number.isInteger(n) && n > 0);
                  if (!ids.length) {
                    setError("请填写至少一个合法客户 ID");
                    return;
                  }
                  void run(async () => {
                    const r = await api.grantPromotion(granting, ids);
                    const skipped = r.results.filter((x) => !x.granted);
                    if (skipped.length) {
                      setError(
                        `已发放 ${r.granted} 人，跳过 ${skipped.length} 人：` +
                          skipped.map((x) => `#${x.customer_id} ${x.skipped}`).join("；"),
                      );
                    }
                  }, "发放完成");
                }}
              >
                确认发放
              </button>
            </div>
          </div>
        )}

        <p className="hint" style={{ marginTop: 12 }}>
          {isGift
            ? "礼包只改权益：不改金额、不改残值。每次发放都会生成一张 0 元已付订单，财务可对账。"
            : "规则：一次下单最多生效一个折扣（多个命中取更优，不叠加）；核销在支付成功后才记录。"}
        </p>
      </div>

      {draft && (
        <PromotionForm
          draft={draft}
          promotionId={editingId}
          busy={busy}
          isNew={editingId === null}
          onChange={setDraft}
          onClose={() => {
            setDraft(null);
            setEditingId(null);
          }}
          onSave={save}
        />
      )}
    </div>
  );
}
