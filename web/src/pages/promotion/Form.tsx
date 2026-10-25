/**
 * 促销编辑器（右侧抽屉）
 *
 * 三条设计原则：
 *
 * 1. **按类型只渲染相关字段**。优惠券 / 礼包 / 邀请是三种不同的东西，
 *    共用一张表时礼包用户会看到灰掉的「力度」，只会以为程序坏了。
 *
 * 2. **码不让用户看见、更不让手输**。码没有语义，人记不住也抄不对。
 *    只管两件事：**发不发码**、**发几个 / 多少人可用**，码由系统生成。
 *
 * 3. **已经发出去的码 = 承诺**。编辑时实质字段锁死（服务端也会拒），
 *    只留文案 / 人群 / 冷却 / 结束时间这些"不影响已发出的码"的字段。
 */
import { useCallback, useEffect, useState } from "react";

import { api } from "../../api";

import type { PlanKind, PromotionCodeView, PromotionDraft, PromotionKind, PromotionView } from "../../api";

export const AUDIENCE_OPTIONS: { value: PromotionView["audience"]; label: string; hint: string }[] = [
  { value: "all", label: "所有人", hint: "不看新老，谁都能用" },
  { value: "new", label: "新客（还没付过钱）", hint: "付过一次就不再算新客" },
  { value: "existing", label: "老客（当前有生效订阅）", hint: "续费 / 加购场景" },
  { value: "expiring", label: "快到期（挽回）", hint: "N 天内到期；每天自动扫描" },
  { value: "expired", label: "已过期（召回）", hint: "订阅已经结束" },
  { value: "specific", label: "指定客户", hint: "只有点名名单里的人能用" },
];

const PLAN_KINDS: { value: PlanKind; label: string }[] = [
  { value: "period", label: "周期套餐" },
  { value: "traffic", label: "流量套餐" },
  { value: "addon", label: "加购包" },
];

const yuan = (minor: number): string => (minor / 100).toFixed(2);
const toMinor = (text: string): number => Math.round((Number.parseFloat(text) || 0) * 100);
const toIso = (local: string): string | null => (local ? new Date(local).toISOString() : null);
function toLocalInput(iso: string | null): string {
  if (!iso) return "";
  const d = new Date(iso);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

const TITLES: Record<PromotionKind, string> = {
  coupon: "优惠券",
  gift: "礼包",
  referral: "邀请活动",
};

/**
 * 发码方式（契约 §2.9.7）。**先选类型，再填数字** —— 两种数字的含义不同：
 *
 *   shared  一个码，多少人可用（默认 100）
 *   unique  一码一人，发多少个码（默认 1）
 *   none    不发码
 */
export type CodeMode = "none" | "shared" | "unique";

export const CODE_MODE_DEFAULTS: Record<CodeMode, number> = {
  none: 0,
  shared: 100,
  unique: 1,
};

export function emptyDraft(kind: PromotionKind): PromotionDraft {
  return {
    name: "",
    kind,
    auto_apply: false,
    benefit_type: "amount",
    benefit_value: kind === "gift" ? 0 : 300,
    min_subtotal_minor: 0,
    limit_plan_kinds: [],
    limit_plan_ids: [],
    rewards: { days: kind === "gift" ? 7 : 0, gb: 0, reset_month: false },
    audience: kind === "referral" ? "new" : kind === "gift" ? "new" : "all",
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
  };
}

function Field({
  label,
  hint,
  children,
  locked,
  lockReason,
}: {
  label: string;
  hint?: string;
  children: React.ReactNode;
  locked?: boolean;
  lockReason?: string;
}) {
  return (
    <label style={{ display: "flex", flexDirection: "column", gap: 4, opacity: locked ? 0.75 : 1 }}>
      <span style={{ fontSize: 12, color: "var(--text-dim)" }}>{label}</span>
      {children}
      {locked && lockReason ? (
        <small className="hint" style={{ color: "var(--warn, #b45309)" }}>
          🔒 {lockReason}
        </small>
      ) : hint ? (
        <small className="hint">{hint}</small>
      ) : null}
    </label>
  );
}

function Section({ title, hint, children }: { title: string; hint?: string; children: React.ReactNode }) {
  return (
    <section style={{ marginTop: 20 }}>
      <div style={{ display: "flex", alignItems: "baseline", gap: 8, marginBottom: 8 }}>
        <h4 style={{ margin: 0 }}>{title}</h4>
        {hint ? <span className="hint">{hint}</span> : null}
      </div>
      <div className="grid" style={{ margin: 0 }}>
        {children}
      </div>
    </section>
  );
}

export interface PromotionFormProps {
  draft: PromotionDraft;
  /** 已保存的活动 id；新建时为 null */
  promotionId: number | null;
  /** 已生成的码统计（编辑态）；null = 还没查 */
  codeStats: { codes: number; active: number; capacity: number | null } | null;
  isNew: boolean;
  busy: boolean;
  onChange: (draft: PromotionDraft) => void;
  onClose: () => void;
  /** 保存。`codes` 只在新建时有意义：创建后立刻按它生成码 */
  onSave: (codes: { mode: CodeMode; count: number }) => Promise<void>;
  /** 码发生变化（生成 / 作废）后通知外层刷新统计 */
  onCodesChanged: () => void;
}

export function PromotionForm({
  draft,
  promotionId,
  codeStats,
  isNew,
  busy,
  onChange,
  onClose,
  onSave,
  onCodesChanged,
}: PromotionFormProps) {
  const [amountText, setAmountText] = useState(
    draft.benefit_type === "amount" ? yuan(draft.benefit_value) : String(draft.benefit_value),
  );
  const [minText, setMinText] = useState(yuan(draft.min_subtotal_minor));
  const [planIdsText, setPlanIdsText] = useState(draft.limit_plan_ids.join(", "));

  // 新建时才有意义：发码方式 + 数量
  const [codeMode, setCodeMode] = useState<CodeMode>("none");
  const [codeCount, setCodeCount] = useState(CODE_MODE_DEFAULTS.shared);

  /**
   * 一次改多个字段必须走这个 ——
   * 连着调两次 `set()` 时，第二次拿到的是**旧 draft**，会把第一次的结果覆盖掉
   * （「人群选不动」就是踩了这个坑）。
   */
  const patch = (p: Partial<PromotionDraft>) => onChange({ ...draft, ...p });

  useEffect(() => {
    const onKey = (ev: KeyboardEvent) => {
      if (ev.key === "Escape" && !busy) onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [busy, onClose]);

  const isGift = draft.kind === "gift";
  const isCoupon = draft.kind === "coupon";
  const isReferral = draft.kind === "referral";

  /** 码一旦生成就不再允许改实质内容（服务端也会拒） */
  const codesIssued = !isNew && (codeStats?.codes ?? 0) > 0;
  const lockReason = "已经发出码了，改这个会让已发出的码变成新规则。要改请先作废这些码。";

  const deliveryHints: string[] = [];
  if (isGift) {
    deliveryHints.push("后台可以随时手动发给指定客户");
    if (draft.audience === "new") deliveryHints.push("新客首单开通后自动发");
    if (draft.audience === "expiring") deliveryHints.push(`到期前 ${draft.audience_days ?? 7} 天自动发`);
    if (codesIssued) deliveryHints.push("用户可凭兑换码自助领取");
  }

  return (
    <div
      onClick={(ev) => {
        if (ev.target === ev.currentTarget && !busy) onClose();
      }}
      style={{
        position: "fixed",
        inset: 0,
        background: "rgba(0,0,0,.45)",
        zIndex: 100,
        display: "flex",
        justifyContent: "flex-end",
      }}
    >
      <div
        onClick={(ev) => ev.stopPropagation()}
        style={{
          width: "min(560px, 100%)",
          height: "100%",
          background: "var(--surface, #fff)",
          display: "flex",
          flexDirection: "column",
          boxShadow: "-8px 0 24px rgba(0,0,0,.18)",
        }}
      >
        <div
          style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            padding: "14px 18px",
            borderBottom: "1px solid var(--border, #e5e7eb)",
          }}
        >
          <div>
            <h3 style={{ margin: 0 }}>
              {isNew ? `新建${TITLES[draft.kind]}` : `编辑${TITLES[draft.kind]}`}
            </h3>
            <span className="hint">保存为草稿；点「上线」后才对用户生效</span>
          </div>
          <button className="ghost" disabled={busy} onClick={onClose} aria-label="关闭">
            ✕
          </button>
        </div>

        <div style={{ flex: 1, overflowY: "auto", padding: "4px 18px 24px" }}>
          <Section title="基本信息">
            <Field label="名称（只有后台可见）">
              <input
                value={draft.name}
                onChange={(e) => patch({ name: e.target.value })}
                placeholder={isGift ? "新人 7 天体验" : isReferral ? "邀请返利" : "新人首单立减 3 元"}
              />
            </Field>
          </Section>

          {/* ── 优惠券：怎么生效 ── */}
          {isCoupon && (
            <Section title="怎么生效">
              <Field
                label="生效方式"
                hint={draft.auto_apply ? "用户不需要任何码，打开就看见" : "用户要在结账页输入码"}
              >
                <select
                  value={draft.auto_apply ? "auto" : "code"}
                  disabled={codesIssued}
                  onChange={(e) => patch({ auto_apply: e.target.value === "auto" })}
                >
                  <option value="auto">自动生效（打开就看见，不用码）</option>
                  <option value="code">凭码使用（发到群 / 博主 / 官网）</option>
                </select>
              </Field>
            </Section>
          )}

          {/* ── 发码：先选类型，再填数字 ── */}
          {!isReferral && (
            <Section
              title={isCoupon && draft.auto_apply ? "发码" : "发码方式"}
              hint={isCoupon && draft.auto_apply ? "自动生效的券不需要码；也可以同时发码给渠道" : undefined}
            >
              {isNew ? (
                <>
                  <Field
                    label="类型"
                    hint={
                      codeMode === "shared"
                        ? "一个码，许多人可用（群里发一个码）"
                        : codeMode === "unique"
                          ? "一码一人，每人拿到自己的码（渠道 / 实体卡）"
                          : "不发码，只能后台手动发 / 系统自动发"
                    }
                  >
                    <select
                      value={codeMode}
                      onChange={(e) => {
                        const mode = e.target.value as CodeMode;
                        setCodeMode(mode);
                        // 切换即重置：否则从"共享码 100"切到"一人一码"会变成发 100 个码
                        setCodeCount(CODE_MODE_DEFAULTS[mode]);
                      }}
                    >
                      <option value="none">不发码</option>
                      <option value="shared">共享码（一个码，多少人可用）</option>
                      <option value="unique">一人一码（发 N 个不同的码）</option>
                    </select>
                  </Field>

                  {codeMode !== "none" && (
                    <Field
                      label={codeMode === "shared" ? "多少人可用" : "发多少个码"}
                      hint={codeMode === "shared" ? "即这个码的名额上限" : "每个码只能用一次"}
                    >
                      <input
                        value={codeCount}
                        onChange={(e) => setCodeCount(Math.max(1, Number(e.target.value) || 1))}
                      />
                    </Field>
                  )}
                </>
              ) : (
                <Field label="已生成的码">
                  <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
                    <span>
                      {codeStats === null
                        ? "加载中…"
                        : codeStats.codes === 0
                          ? "还没有码"
                          : `${codeStats.codes} 个码（可用 ${codeStats.active} 个，总容量 ${codeStats.capacity ?? "不限"}）`}
                      {draft.auto_apply ? " · 自动生效不需要码" : ""}
                    </span>
                  </div>
                </Field>
              )}

              {isGift && (
                <Field label="这次会怎么送达">
                  <div className="hint" style={{ lineHeight: 1.7 }}>
                    {deliveryHints.map((h) => (
                      <div key={h}>· {h}</div>
                    ))}
                  </div>
                </Field>
              )}
            </Section>
          )}

          {/* ── 礼包：送什么 ── */}
          {isGift && (
            <Section title="送什么" hint="只改权益，不改金额「少收钱」是优惠券的事">
              <Field
                label="送天数（0 = 不送）"
                hint="直接延长有效期；永久套餐不受影响"
                locked={codesIssued}
                lockReason={lockReason}
              >
                <input
                  value={draft.rewards.days}
                  disabled={codesIssued}
                  onChange={(e) => patch({ rewards: { ...draft.rewards, days: Number(e.target.value) || 0 } })}
                  placeholder="7"
                />
              </Field>
              <Field
                label="送流量 GB（0 = 不送）"
                hint="进加购余额，跨期不清零"
                locked={codesIssued}
                lockReason={lockReason}
              >
                <input
                  value={draft.rewards.gb}
                  disabled={codesIssued}
                  onChange={(e) => patch({ rewards: { ...draft.rewards, gb: Number(e.target.value) || 0 } })}
                  placeholder="5"
                />
              </Field>
              <Field label="重置本月已用" hint="客服补偿场景" locked={codesIssued} lockReason={lockReason}>
                <select
                  value={draft.rewards.reset_month ? "yes" : "no"}
                  disabled={codesIssued}
                  onChange={(e) => patch({ rewards: { ...draft.rewards, reset_month: e.target.value === "yes" } })}
                >
                  <option value="no">不重置</option>
                  <option value="yes">把本月已用流量清零</option>
                </select>
              </Field>
            </Section>
          )}

          {/* ── 优惠力度 ── */}
          {(isCoupon || isReferral) && (
            <Section
              title={isCoupon ? "优惠力度" : "被邀请人拿什么"}
              hint="只压应付金额，不改升级阶梯、不改残值"
            >
              <Field label="方式" locked={codesIssued} lockReason={lockReason}>
                <select
                  value={draft.benefit_type}
                  disabled={codesIssued}
                  onChange={(e) => {
                    const type = e.target.value as "amount" | "percent";
                    patch({ benefit_type: type, benefit_value: type === "amount" ? 300 : 20 });
                    setAmountText(type === "amount" ? "3.00" : "20");
                  }}
                >
                  <option value="amount">立减金额（元）</option>
                  <option value="percent">按比例减（%）</option>
                </select>
              </Field>
              <Field
                label={draft.benefit_type === "amount" ? "减多少（元）" : "减百分之几"}
                hint={draft.benefit_type === "amount" ? `用户少付 ¥${amountText || "0"}` : "按标价算，向下取整到分"}
                locked={codesIssued}
                lockReason={lockReason}
              >
                <input
                  value={amountText}
                  disabled={codesIssued}
                  onChange={(e) => {
                    setAmountText(e.target.value);
                    patch({
                      benefit_value:
                        draft.benefit_type === "amount" ? toMinor(e.target.value) : Math.round(Number(e.target.value) || 0),
                    });
                  }}
                />
              </Field>
              {isCoupon && (
                <Field
                  label="最低消费（元，0 = 不限）"
                  hint="建议设：百分比券会把低价套餐打到接近 0"
                  locked={codesIssued}
                  lockReason={lockReason}
                >
                  <input
                    value={minText}
                    disabled={codesIssued}
                    onChange={(e) => {
                      setMinText(e.target.value);
                      patch({ min_subtotal_minor: toMinor(e.target.value) });
                    }}
                  />
                </Field>
              )}
            </Section>
          )}

          {/* ── 邀请人奖励 ── */}
          {isReferral && (
            <Section title="邀请人拿什么" hint="被邀请人首单支付成功后发放；只给权益，不给现金">
              <Field label="奖励类型">
                <select
                  value={draft.referrer_reward_type ?? "none"}
                  onChange={(e) => {
                    const type = e.target.value as "days" | "gb" | "none";
                    patch({ referrer_reward_type: type, referrer_reward_value: type === "none" ? 0 : 7 });
                  }}
                >
                  <option value="days">送天数</option>
                  <option value="gb">送流量</option>
                  <option value="none">不给奖励</option>
                </select>
              </Field>
              {draft.referrer_reward_type !== "none" && (
                <Field label={draft.referrer_reward_type === "gb" ? "送多少 GB" : "送多少天"}>
                  <input
                    value={draft.referrer_reward_value ?? 0}
                    onChange={(e) => patch({ referrer_reward_value: Number(e.target.value) || 0 })}
                  />
                </Field>
              )}
            </Section>
          )}

          {/* ── 人群 ── */}
          <Section title="发给谁" hint="依赖个人条件；匿名访客一律不适用">
            <Field
              label="人群"
              hint={
                isReferral
                  ? "邀请活动只对「新客」有意义（付过钱就不算被邀请）"
                  : AUDIENCE_OPTIONS.find((a) => a.value === draft.audience)?.hint
              }
            >
              <select
                value={draft.audience}
                disabled={isReferral}
                onChange={(e) => {
                  const audience = e.target.value as PromotionDraft["audience"];
                  patch({
                    audience,
                    audience_days: audience === "expiring" ? (draft.audience_days ?? 7) : null,
                  });
                }}
              >
                {AUDIENCE_OPTIONS.map((a) => (
                  <option key={a.value} value={a.value}>
                    {a.label}
                  </option>
                ))}
              </select>
            </Field>

            {draft.audience === "expiring" && (
              <Field label="N 天内到期" hint="每天扫一次，符合条件的人自动收到">
                <input
                  value={draft.audience_days ?? ""}
                  onChange={(e) => patch({ audience_days: e.target.value ? Number(e.target.value) : null })}
                  placeholder="7"
                />
              </Field>
            )}

            <Field label="注册 N 天内才能用（留空 = 不限）">
              <input
                value={draft.new_user_within_days ?? ""}
                onChange={(e) => patch({ new_user_within_days: e.target.value ? Number(e.target.value) : null })}
                placeholder="7"
              />
            </Field>

            <Field label="同一人两次核销的最小间隔（小时，留空 = 不限）" hint="防连点；每人每活动固定只能领 1 次">
              <input
                value={draft.cooldown_hours ?? ""}
                onChange={(e) => patch({ cooldown_hours: e.target.value ? Number(e.target.value) : null })}
                placeholder="24"
              />
            </Field>
          </Section>

          {isGift && (
            <Section title="没订阅的人怎么办" hint="礼包只能加在订阅上；新客需要一个「载体」">
              <Field
                label="体验套餐（客户没有订阅时，用它 0 元开通）"
                hint="必须是「隐藏」套餐；有订阅的客户会忽略这个字段"
                locked={codesIssued}
                lockReason={lockReason}
              >
                <input
                  value={draft.plan_id ?? ""}
                  disabled={codesIssued}
                  onChange={(e) => patch({ plan_id: e.target.value.trim() || null })}
                  placeholder="trial_7d"
                />
              </Field>
            </Section>
          )}

          <Section title="适用范围" hint="留空 = 全部套餐">
            {PLAN_KINDS.map((k) => (
              <Field key={k.value} label={`只适用于${k.label}`} locked={codesIssued} lockReason={lockReason}>
                <select
                  value={draft.limit_plan_kinds.includes(k.value) ? "yes" : "no"}
                  disabled={codesIssued}
                  onChange={(e) =>
                    patch({
                      limit_plan_kinds:
                        e.target.value === "yes"
                          ? [...draft.limit_plan_kinds, k.value]
                          : draft.limit_plan_kinds.filter((x) => x !== k.value),
                    })
                  }
                >
                  <option value="no">不限</option>
                  <option value="yes">仅{k.label}</option>
                </select>
              </Field>
            ))}
            <Field label="指定套餐 ID（逗号分隔）" locked={codesIssued} lockReason={lockReason}>
              <input
                value={planIdsText}
                disabled={codesIssued}
                onChange={(e) => {
                  setPlanIdsText(e.target.value);
                  patch({
                    limit_plan_ids: e.target.value
                      .split(",")
                      .map((v) => v.trim())
                      .filter(Boolean),
                  });
                }}
                placeholder="p_30d_100g_1d"
              />
            </Field>
          </Section>

          <Section title="展示">
            {isCoupon && (
              <Field label="角标文案（留空 = 不公开宣传）">
                <input
                  value={draft.badge_label ?? ""}
                  onChange={(e) => patch({ badge_label: e.target.value })}
                  placeholder="限时立减 ¥3"
                />
              </Field>
            )}
            <Field label="公开展示">
              <select
                value={draft.visible ? "yes" : "no"}
                onChange={(e) => patch({ visible: e.target.value === "yes" })}
              >
                <option value="yes">公开（列表页显示角标）</option>
                <option value="no">不公开（只靠码命中）</option>
              </select>
            </Field>
            {draft.auto_apply && (
              <Field label="总名额（留空 = 不限，0 = 不限）" hint="只对自动生效的券有意义；凭码的名额在码上">
                <input
                  value={draft.max_uses ?? ""}
                  onChange={(e) => patch({ max_uses: e.target.value ? Number(e.target.value) : null })}
                  placeholder="200"
                />
              </Field>
            )}
          </Section>

          <Section title="有效期" hint="留空 = 长期">
            <Field label="开始时间">
              <input
                type="datetime-local"
                value={toLocalInput(draft.starts_at)}
                onChange={(e) => patch({ starts_at: toIso(e.target.value) })}
              />
            </Field>
            <Field label="结束时间" hint="只能往后延；已过期的活动可以延长">
              <input
                type="datetime-local"
                value={toLocalInput(draft.ends_at)}
                onChange={(e) => patch({ ends_at: toIso(e.target.value) })}
              />
            </Field>
          </Section>

          {/* 编辑态才有：现有码的列表 / 追加 / 作废 / 导出 */}
          {!isNew && <CodeBatch promotionId={promotionId} onChanged={onCodesChanged} />}
        </div>

        <div
          style={{
            display: "flex",
            justifyContent: "flex-end",
            gap: 8,
            padding: "12px 18px",
            borderTop: "1px solid var(--border, #e5e7eb)",
            background: "var(--surface, #fff)",
          }}
        >
          <button className="ghost" disabled={busy} onClick={onClose}>
            取消
          </button>
          <button
            className="primary"
            disabled={busy}
            onClick={() => void onSave({ mode: isNew ? codeMode : "none", count: codeCount })}
          >
            {isNew ? "创建草稿" : "保存"}
          </button>
        </div>
      </div>
    </div>
  );
}

/**
 * 已有码：列表 + 追加生成 + 作废 + 导出。
 *
 * 只在编辑态出现 —— 新建时还没 id，码挂不上去。
 */
function CodeBatch({ promotionId, onChanged }: { promotionId: number | null; onChanged: () => void }) {
  const [codes, setCodes] = useState<PromotionCodeView[]>([]);
  const [appendCount, setAppendCount] = useState(0);
  const [maxUses, setMaxUses] = useState(1);
  const [prefix, setPrefix] = useState("");
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);

  const reload = useCallback(async () => {
    if (promotionId === null) return;
    try {
      const r = await api.promotionCodes(promotionId);
      setCodes(r.codes);
    } catch {
      /* 列表失败不打断编辑 */
    }
  }, [promotionId]);

  useEffect(() => {
    void reload();
  }, [reload]);

  if (promotionId === null) return null;

  async function generate() {
    if (!appendCount || appendCount < 1) return;
    setBusy(true);
    setMsg(null);
    try {
      const r = await api.generatePromotionCodes(promotionId as number, {
        count: appendCount,
        max_uses: maxUses,
        prefix: prefix || null,
        note: note || null,
      });
      setMsg(
        r.codes.length === r.requested
          ? `已追加 ${r.codes.length} 个码`
          : `只生成了 ${r.codes.length}/${r.requested} 个（撞码重试到上限）`,
      );
      setAppendCount(0);
      await reload();
      onChanged();
    } catch (e) {
      setMsg(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  const text = codes.map((c) => c.code).join("\n");

  function download() {
    const csv = [
      "code,状态,已用,上限,备注",
      ...codes.map((c) => `${c.code},${c.status},${c.used},${c.max_uses ?? "不限"},${c.note ?? ""}`),
    ].join("\n");
    const url = URL.createObjectURL(new Blob([`\ufeff${csv}`], { type: "text/csv;charset=utf-8" }));
    const a = document.createElement("a");
    a.href = url;
    a.download = `promo-codes-${promotionId}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  }

  return (
    <Section title="现有的码" hint="码由系统生成，不用手输">
      <Field label="追加生成" hint="留空不生成；一个码能用几次决定它是共享码（多人）还是一人一码（1 次）">
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
          <input
            value={appendCount || ""}
            onChange={(e) => setAppendCount(Number(e.target.value) || 0)}
            placeholder="数量"
            style={{ width: 80 }}
          />
          <input
            value={maxUses}
            onChange={(e) => setMaxUses(Math.max(1, Number(e.target.value) || 1))}
            placeholder="每码可用"
            style={{ width: 90 }}
            title="每个码最多能用几次"
          />
          <input
            value={prefix}
            onChange={(e) => setPrefix(e.target.value.toUpperCase())}
            placeholder="前缀（可空）"
            style={{ width: 100 }}
          />
          <input
            value={note}
            onChange={(e) => setNote(e.target.value)}
            placeholder="备注（发给谁）"
            style={{ flex: 1, minWidth: 120 }}
          />
          <button type="button" className="primary" disabled={busy || !appendCount} onClick={() => void generate()}>
            生成
          </button>
        </div>
      </Field>

      {msg ? <div className="hint">{msg}</div> : null}

      {codes.length > 0 && (
        <>
          <div className="row" style={{ gap: 8 }}>
            <button
              type="button"
              onClick={() => {
                void navigator.clipboard.writeText(text);
                setMsg("已复制全部码");
              }}
            >
              复制全部
            </button>
            <button type="button" onClick={download}>
              导出 CSV
            </button>
            <span className="hint">
              共 {codes.length} 个，已用 {codes.reduce((n, c) => n + c.used, 0)} 次
            </span>
          </div>
          <div style={{ maxHeight: 180, overflowY: "auto" }}>
            <table className="table">
              <thead>
                <tr>
                  <th>码</th>
                  <th>用量</th>
                  <th>状态</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {codes.map((c) => (
                  <tr key={c.id}>
                    <td className="mono">{c.code}</td>
                    <td>
                      {c.used} / {c.max_uses ?? "不限"}
                    </td>
                    <td>{c.status === "active" ? "可用" : "已作废"}</td>
                    <td className="actions">
                      {c.status === "active" && (
                        <button
                          type="button"
                          className="danger"
                          disabled={busy}
                          onClick={async () => {
                            await api.revokePromotionCode(promotionId as number, c.id);
                            await reload();
                            onChanged();
                          }}
                        >
                          作废
                        </button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}
    </Section>
  );
}
