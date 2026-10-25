/**
 * 营销 · 优惠券 / 邀请返利 —— 「让一单少付钱」与「谁拉了谁」的唯一写入口
 *
 * 契约：`clever-vpn-docs` `app-crm.md` §2.9；设计依据：`docs/promotion.md`。
 *
 * 这个页面**不含任何价格计算**：折扣怎么算、能不能叠加，全在服务端
 * （`src/promotions/*`），这里只负责收集输入与展示结果。所以后台看到的
 * 与 App / 官网看到的**必然一致**。
 *
 * 两种 `kind` 共用一张表与一个表单：
 *   coupon   —— 优惠券：改订单金额（自动生效 或 凭码）
 *   referral —— 邀请返利：改人际关系 + 被邀请人首单权益 + 邀请人奖励
 *
 * 刻意不做的事（见 `docs/promotion.md` §5）：券包、盲盒、库存限量、多级分销。
 */

import { useCallback, useEffect, useState } from "react";

import { api, ApiError, type PlanKind, type PromotionDraft, type PromotionKind, type PromotionView } from "../api";

const PLAN_KINDS: { value: PlanKind; label: string }[] = [
  { value: "period", label: "周期套餐" },
  { value: "traffic", label: "流量套餐" },
  { value: "addon", label: "加购包" },
];

const emptyDraft = (kind: PromotionKind): PromotionDraft => ({
  code: null,
  name: "",
  kind,
  benefit_type: "amount",
  benefit_value: kind === "gift" ? 0 : 300,
  min_subtotal_minor: 0,
  limit_plan_kinds: [],
  limit_plan_ids: [],
  rewards: kind === "gift" ? { days: 7, gb: 0, reset_month: false } : { days: 0, gb: 0, reset_month: false },
  audience: kind === "referral" || kind === "gift" ? "new" : "all",
  audience_days: null,
  cooldown_hours: null,
  plan_id: null,
  new_user_within_days: null,
  starts_at: null,
  ends_at: null,
  max_uses: null,
  max_uses_per_customer: 1,
  badge_label: "",
  visible: true,
  referrer_reward_type: kind === "referral" ? "days" : null,
  referrer_reward_value: kind === "referral" ? 7 : null,
});

const yuan = (minor: number): string => (minor / 100).toFixed(2);
/** 「元」输入框 → 分。空值与小数都按 0 处理，真正的校验在服务端 */
const toMinor = (text: string): number => Math.round((Number.parseFloat(text) || 0) * 100);

/** `datetime-local` 的值本地时区没带 Z，统一转成 ISO（UTC）再提交 */
function toIso(local: string): string | null {
  return local ? new Date(local).toISOString() : null;
}
/** ISO → `datetime-local` 需要的 `YYYY-MM-DDTHH:mm` */
function toLocalInput(iso: string | null): string {
  if (!iso) return "";
  const d = new Date(iso);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function benefitLabel(p: { benefit_type: string; benefit_value: number }): string {
  return p.benefit_type === "percent" ? `减 ${p.benefit_value}%` : `立减 ¥${yuan(p.benefit_value)}`;
}

/** 礼包的“力度”：送多少天 / 多少 GB / 是否清零本月已用 */
function rewardsLabel(r: { days: number; gb: number; reset_month: boolean }): string {
  const parts: string[] = [];
  if (r.days > 0) parts.push(`+${r.days} 天`);
  if (r.gb > 0) parts.push(`+${r.gb} GB`);
  if (r.reset_month) parts.push("重置本月");
  return parts.length ? parts.join(" · ") : "空礼包";
}

/** 人群的六个取值 —— 与契约 §2.9.6 一一对应 */
export const AUDIENCE_OPTIONS: { value: PromotionView["audience"]; label: string; hint: string }[] = [
  { value: "all", label: "所有人", hint: "不看新老，谁都能用" },
  { value: "new", label: "新客（首单）", hint: "付过钱就不是新客了" },
  { value: "existing", label: "老客续费", hint: "当前有生效中的订阅" },
  { value: "expiring", label: "快到期", hint: "N 天内到期（挽回）" },
  { value: "expired", label: "已过期", hint: "订阅已经结束（召回）" },
  { value: "specific", label: "指定客户", hint: "只有点名名单里的人能用" },
];

function audienceLabel(p: PromotionView): string {
  const label = AUDIENCE_OPTIONS.find((a) => a.value === p.audience)?.label ?? "所有人";
  const parts: string[] = [];
  if (p.audience === "expiring") parts.push(`${label}（${p.audience_days ?? 7} 天内）`);
  else parts.push(label);
  if (p.new_user_within_days !== null) parts.push(`注册 ${p.new_user_within_days} 天内`);
  if (p.cooldown_hours !== null) parts.push(`${p.cooldown_hours} 小时冷却`);
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

const STATUS_TAG: Record<string, string> = {
  draft: "tag-draft",
  active: "tag-active",
  ended: "tag-retired",
};
const STATUS_LABEL: Record<string, string> = {
  draft: "草稿",
  active: "进行中",
  ended: "已结束",
};

export default function Promotions({ kind }: { kind: PromotionKind }) {
  const isReferral = kind === "referral";
  const isGift = kind === "gift";
  const [items, setItems] = useState<PromotionView[]>([]);
  const [draft, setDraft] = useState<PromotionDraft | null>(null);
  const [editingId, setEditingId] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  /** 正在发放在哪个礼包上（null = 没有） */
  const [granting, setGranting] = useState<number | null>(null);
  const [grantIds, setGrantIds] = useState("");

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
    } catch (e) {
      setError(e instanceof ApiError ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  async function save() {
    if (!draft) return;
    await run(
      () =>
        editingId === null
          ? api.createPromotion(draft)
          : api.updatePromotion(editingId, draft),
      editingId === null ? "已创建草稿（上线后才会生效）" : "已保存",
    );
    setDraft(null);
    setEditingId(null);
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
            <h3>{isReferral ? "邀请返利" : isGift ? "礼包" : "优惠券"}</h3>
            <p className="hint">
              {isReferral
                ? "唯一的「谁拉来的」来源。邀请码永远选填 —— 用户刚装完 App，没有义务输码。"
                : isGift
                  ? "送天数 / 送流量 / 重置本月。发放后会生成一张 0 元订单留痕，用户在自己的权益里看得见。"
                  : "自动生效不用发码（打开 App 就看见）；凭码用于渠道投放；人群决定谁能用。"}
            </p>
          </div>
          <button
            disabled={busy}
            onClick={() => {
              setEditingId(null);
              setDraft(emptyDraft(kind));
            }}
          >
            {isReferral ? "新建邀请活动" : isGift ? "新建礼包" : "新建优惠券"}
          </button>
        </div>

        {error && <div className="notice error">{error}</div>}
        {notice && <div className="notice ok">{notice}</div>}

        {items.length === 0 ? (
          <div className="empty">
            <span className="ico">◈</span>
            {isReferral
              ? "还没有邀请活动。建一个就能让老用户带新用户，双方拿权益。"
              : "还没有优惠券。先建一个草稿，上线后 App 与官网立刻生效（不用发版）。"}
          </div>
        ) : (
          <div className="table-wrap">
            <table className="table">
              <thead>
                <tr>
                  <th>名称</th>
                  <th>生效方式</th>
                  <th>力度</th>
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
                    <td>{p.code ? <span className="mono">{p.code}</span> : isGift ? "手动 / 到期自动" : "自动生效"}</td>
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
                          {granting === p.id ? "取消发放" : "发放"}
                        </button>
                      )}
                      {p.status === "draft" && (
                        <button
                          disabled={busy}
                          onClick={() => void run(() => api.publishPromotion(p.id), "已上线")}
                        >
                          上线
                        </button>
                      )}
                      {p.status === "active" && (
                        <button disabled={busy} onClick={() => void run(() => api.endPromotion(p.id), "已结束")}>
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
              <strong>发放礼包</strong>
              <span className="hint">客户 ID 逗号分隔；没有订阅的人会被跳过并说明原因</span>
            </div>
            <div className="row" style={{ gap: 8, marginTop: 8 }}>
              <input
                value={grantIds}
                onChange={(e) => setGrantIds(e.target.value)}
                placeholder="12, 34"
                style={{ flex: 1 }}
              />
              <button
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
                  setGranting(null);
                  setGrantIds("");
                }}
              >
                确认发放
              </button>
            </div>
          </div>
        )}

        <p className="hint" style={{ marginTop: 12 }}>
          规则：一次下单<b>最多生效一个</b>折扣（多个命中时取更优，不叠加）；折扣只压应付金额，
          不改变「能不能升级」的判断；核销在<b>支付成功后</b>才记录，下单不扣名额。
        </p>
      </div>

      {draft && (
        <PromotionForm
          draft={draft}
          busy={busy}
          isNew={editingId === null}
          onChange={setDraft}
          onCancel={() => {
            setDraft(null);
            setEditingId(null);
          }}
          onSave={save}
        />
      )}
    </div>
  );
}

function PromotionForm({
  draft,
  busy,
  isNew,
  onChange,
  onCancel,
  onSave,
}: {
  draft: PromotionDraft;
  busy: boolean;
  isNew: boolean;
  onChange: (next: PromotionDraft) => void;
  onCancel: () => void;
  onSave: () => Promise<void>;
}) {
  const isReferral = draft.kind === "referral";
  const isGift = draft.kind === "gift";
  const [codeMode, setCodeMode] = useState<"auto" | "code">(draft.code ? "code" : "auto");
  const [amountText, setAmountText] = useState(
    draft.benefit_type === "amount" ? yuan(draft.benefit_value) : String(draft.benefit_value),
  );
  const [minText, setMinText] = useState(yuan(draft.min_subtotal_minor));
  const [planIdsText, setPlanIdsText] = useState(draft.limit_plan_ids.join(", "));

  const set = <K extends keyof PromotionDraft>(key: K, value: PromotionDraft[K]) =>
    onChange({ ...draft, [key]: value });

  function setBenefitType(type: PromotionDraft["benefit_type"]) {
    // 换单位时把当前数值带到新单位，避免"10 元"变成"10%"这种误会。
    // 注意：必须**一次 onChange 改完**——连着调两次 `set()` 时两次都基于
    // 同一份旧 draft，后一次会把前一次的改动覆盖掉（踩过）。
    if (type === draft.benefit_type) return;
    if (type === "percent") {
      setAmountText("20");
      onChange({ ...draft, benefit_type: "percent", benefit_value: 20 });
    } else {
      setAmountText("3.00");
      onChange({ ...draft, benefit_type: "amount", benefit_value: 300 });
    }
  }

  return (
    <div className="card">
      <div className="row between">
        <h3>{isNew ? (isReferral ? "新建邀请活动" : isGift ? "新建礼包" : "新建优惠券") : "编辑"}</h3>
        <span className="hint">保存为草稿；点「上线」后才对用户生效</span>
      </div>

      <div className="grid">
        <label>
          名称（只有后台可见）
          <input
            value={draft.name}
            onChange={(e) => set("name", e.target.value)}
            placeholder={isReferral ? "邀请返利" : "新人首单立减 3 元"}
          />
        </label>

        {!isReferral && !isGift && (
          <>
            <label>
              生效方式
              <select
                value={codeMode}
                onChange={(e) => {
                  const mode = e.target.value as "auto" | "code";
                  setCodeMode(mode);
                  if (mode === "auto") set("code", null);
                }}
              >
                <option value="auto">自动生效（打开就看见，不用码）</option>
                <option value="code">凭码使用（投放给渠道 / 群 / 博主）</option>
              </select>
              <small className="hint">
                {codeMode === "auto"
                  ? "转化最好：用户不需要拿到任何码"
                  : "用户要在结账页输入这串码，可统计这个渠道带来多少单"}
              </small>
            </label>

            <label>
              优惠码
              <input
                value={draft.code ?? ""}
                disabled={codeMode === "auto"}
                onChange={(e) => set("code", e.target.value.trim().toUpperCase() || null)}
                placeholder={codeMode === "auto" ? "（自动生效，无需填）" : "NEW2026"}
              />
              <small className="hint">A-Z / 0-9 / _ / -，2–32 位，大小写不敏感</small>
            </label>
          </>
        )}

        {isGift && (
          <>
            <label>
              兑换码（留空 = 只能后台／系统发放）
              <input
                value={draft.code ?? ""}
                onChange={(e) => set("code", e.target.value.trim().toUpperCase() || null)}
                placeholder="GUOQING7"
              />
              <small className="hint">
                A-Z / 0-9 / _ / -，至少 6 位（太短的码等于送）。用户登录后在账户页 / App 里输它
              </small>
            </label>

            <label>
              体验套餐（客户还没有订阅时用它 0 元开户）
              <input
                value={draft.plan_id ?? ""}
                onChange={(e) => set("plan_id", e.target.value.trim() || null)}
                placeholder="trial_7d"
              />
              <small className="hint">
                必须是「隐藏」套餐；有订阅的客户会忽略它，只加天数/流量
              </small>
            </label>
          </>
        )}

        <label>
          力度
          <select value={draft.benefit_type} onChange={(e) => setBenefitType(e.target.value as "amount" | "percent")} disabled={isGift}>
            <option value="amount">立减金额（元）</option>
            <option value="percent">按比例减（%）</option>
          </select>
          {isGift && <small className="hint">礼包不改金额，只改权益</small>}
        </label>

        {!isGift && (
          <>
            <label>
              {draft.benefit_type === "amount" ? "减多少（元）" : "减百分之几"}
              <input
                value={amountText}
                onChange={(e) => {
                  setAmountText(e.target.value);
                  set(
                    "benefit_value",
                    draft.benefit_type === "amount" ? toMinor(e.target.value) : Math.round(Number(e.target.value) || 0),
                  );
                }}
              />
              <small className="hint">
                {draft.benefit_type === "amount"
                  ? `用户少付 ¥${amountText || "0"}`
                  : `按标价算，向下取整到分；1–100`}
              </small>
            </label>

            <label>
              最低消费（元，0 = 不限）
              <input
                value={minText}
                onChange={(e) => {
                  setMinText(e.target.value);
                  set("min_subtotal_minor", toMinor(e.target.value));
                }}
              />
              <small className="hint">必须有：百分比折扣会把低价套餐打到接近 0</small>
            </label>
          </>
        )}

        {isGift && (
          <label>
            送多少天（0 = 不送）
            <input
              value={draft.rewards.days}
              onChange={(e) => set("rewards", { ...draft.rewards, days: Number(e.target.value) || 0 })}
              placeholder="7"
            />
            <small className="hint">直接延长有效期；永久套餐不受影响</small>
          </label>
        )}

        {isGift && (
          <label>
            送多少 GB（0 = 不送）
            <input
              value={draft.rewards.gb}
              onChange={(e) => set("rewards", { ...draft.rewards, gb: Number(e.target.value) || 0 })}
              placeholder="5"
            />
            <small className="hint">进加购余额，跨期不清零</small>
          </label>
        )}

        {isGift && (
          <label className="checkbox">
            <input
              type="checkbox"
              checked={draft.rewards.reset_month}
              onChange={(e) => set("rewards", { ...draft.rewards, reset_month: e.target.checked })}
            />
            额外把本月已用流量清零（补偿用）
          </label>
        )}

        <label>
          角标文案（给用户看，留空 = 不公开宣传）
          <input
            value={draft.badge_label ?? ""}
            onChange={(e) => set("badge_label", e.target.value)}
            placeholder={isReferral ? "" : "限时 8 折"}
          />
        </label>

        <label>
          总名额（留空 = 不限）
          <input
            value={draft.max_uses ?? ""}
            onChange={(e) => set("max_uses", e.target.value ? Number(e.target.value) : null)}
            placeholder="200"
          />
        </label>

        <label>
          每人可用次数
          <input
            value={draft.max_uses_per_customer}
            onChange={(e) => set("max_uses_per_customer", Number(e.target.value) || 0)}
          />
          <small className="hint">0 = 谁都不能用（等于下线）</small>
        </label>
      </div>

      {!isReferral && (
        <>
          <h4 style={{ marginBottom: 4 }}>人群</h4>
          <div className="grid">
            <label>
              谁能用
              <select
                value={draft.audience}
                onChange={(e) => {
                  const audience = e.target.value as PromotionDraft["audience"];
                  set("audience", audience);
                  // 只有「快到期」需要天数；切走就清掉，免得留下看不懂的残值
                  if (audience !== "expiring") set("audience_days", null);
                  else if (draft.audience_days === null) set("audience_days", 7);
                }}
              >
                {AUDIENCE_OPTIONS.map((a) => (
                  <option key={a.value} value={a.value}>
                    {a.label}
                  </option>
                ))}
              </select>
              <small className="hint">
                {AUDIENCE_OPTIONS.find((a) => a.value === draft.audience)?.hint}
              </small>
            </label>

            {draft.audience === "expiring" && (
              <label>
                N 天内到期
                <input
                  value={draft.audience_days ?? ""}
                  onChange={(e) => set("audience_days", e.target.value ? Number(e.target.value) : null)}
                  placeholder="7"
                />
                <small className="hint">定时任务每天扫一次，符合条件的人自动收到</small>
              </label>
            )}

            <label>
              注册 N 天内可用（留空 = 不限）
              <input
                value={draft.new_user_within_days ?? ""}
                onChange={(e) => set("new_user_within_days", e.target.value ? Number(e.target.value) : null)}
                placeholder="7"
              />
            </label>

            <label>
              冷却小时数（留空 = 不限）
              <input
                value={draft.cooldown_hours ?? ""}
                onChange={(e) => set("cooldown_hours", e.target.value ? Number(e.target.value) : null)}
                placeholder="24"
              />
              <small className="hint">同一客户两次核销之间的最小间隔；防连点、防刷</small>
            </label>
          </div>

          <h4 style={{ marginBottom: 4 }}>适用范围</h4>
          <div className="grid">
            {PLAN_KINDS.map((k) => (
              <label className="checkbox" key={k.value}>
                <input
                  type="checkbox"
                  checked={draft.limit_plan_kinds.includes(k.value)}
                  onChange={(e) =>
                    set(
                      "limit_plan_kinds",
                      e.target.checked
                        ? [...draft.limit_plan_kinds, k.value]
                        : draft.limit_plan_kinds.filter((x) => x !== k.value),
                    )
                  }
                />
                只适用于{k.label}
              </label>
            ))}
            <label>
              指定套餐 ID（逗号分隔，留空 = 不限）
              <input
                value={planIdsText}
                onChange={(e) => {
                  setPlanIdsText(e.target.value);
                  set(
                    "limit_plan_ids",
                    e.target.value
                      .split(",")
                      .map((s) => s.trim())
                      .filter(Boolean),
                  );
                }}
                placeholder="dev_period_100g"
              />
            </label>
          </div>
        </>
      )}

      {isReferral && (
        <>
          <h4 style={{ marginBottom: 4 }}>邀请人奖励（被邀请人首单支付后发放）</h4>
          <div className="grid">
            <label>
              奖励类型
              <select
                value={draft.referrer_reward_type ?? "days"}
                onChange={(e) => set("referrer_reward_type", e.target.value as "days" | "gb" | "none")}
              >
                <option value="days">送天数</option>
                <option value="gb">送流量（GB）</option>
                <option value="none">不给推荐人奖励</option>
              </select>
            </label>
            <label>
              奖励数值
              <input
                value={draft.referrer_reward_value ?? ""}
                disabled={(draft.referrer_reward_type ?? "days") === "none"}
                onChange={(e) => set("referrer_reward_value", Number(e.target.value) || 0)}
                placeholder="7"
              />
              <small className="hint">只发权益（天数 / 流量），不发现金</small>
            </label>
          </div>
        </>
      )}

      <h4 style={{ marginBottom: 4 }}>有效期（留空 = 长期）</h4>
      <div className="grid">
        <label>
          开始
          <input
            type="datetime-local"
            value={toLocalInput(draft.starts_at)}
            onChange={(e) => set("starts_at", toIso(e.target.value))}
          />
        </label>
        <label>
          结束
          <input
            type="datetime-local"
            value={toLocalInput(draft.ends_at)}
            onChange={(e) => set("ends_at", toIso(e.target.value))}
          />
        </label>
        <label className="checkbox">
          <input type="checkbox" checked={draft.visible} onChange={(e) => set("visible", e.target.checked)} />
          在套餐页公开展示角标
        </label>
      </div>

      <div className="actions" style={{ marginTop: 12 }}>
        <button disabled={busy} onClick={() => void onSave()}>
          保存
        </button>
        <button disabled={busy} onClick={onCancel}>
          取消
        </button>
      </div>
    </div>
  );
}
