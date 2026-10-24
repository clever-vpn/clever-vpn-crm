/**
 * 套餐设计器 —— 「卖什么」只有这一个页面
 *
 * 页面本身**不含任何业务计算**：可买性、残值、应付金额都来自 `/api/admin/plans/preview`
 * （与服务端同一份代码），这里只负责渲染与收集输入。
 *
 * `plans` 是可变目录：任何状态都能直接改。改动只影响**之后的新购买**，
 * 已卖出的订阅用的是自己的快照（`platform_subscriptions`），不会被修改。
 */

import { useCallback, useEffect, useState } from "react";

import { api, ApiError, type PlanDraft, type PlanView } from "../api";

const KINDS = [
  { value: "period", label: "周期套餐", hint: "按月/年卖：有到期日，含每月额度" },
  { value: "traffic", label: "流量套餐", hint: "一次性买断：按 GB，可用完为止" },
  { value: "addon", label: "加购包", hint: "只能叠加在生效中的周期套餐上" },
] as const;

const emptyDraft = (): PlanDraft => ({
  id: "",
  name: "",
  kind: "period",
  price_minor: 0,
  currency: "CNY",
  licence_limit: 1,
  term_days: 30,
  monthly_quota_gb: 100,
  traffic_gb: null,
  validity_days: null,
  line_ids: [],
  up_mbps: null,
  down_mbps: null,
  sales_channels: [{ channel: "web_checkout", methods: ["alipay"] }],
  store_product_id: {},
  sort_order: 0,
});

function yuan(minor: number): string {
  return (minor / 100).toFixed(2);
}

function quotaLabel(plan: PlanView): string {
  if (plan.kind === "period") {
    return plan.monthly_quota_gb === null ? "不限量" : `${plan.monthly_quota_gb} GB/月`;
  }
  return `${plan.traffic_gb ?? 0} GB`;
}

function validityLabel(plan: PlanView): string {
  if (plan.kind === "period") return `${plan.term_days} 天`;
  if (plan.kind === "addon") return "随主套餐";
  return plan.validity_days === null ? "永久" : `${plan.validity_days} 天`;
}

export default function Plans() {
  const [plans, setPlans] = useState<PlanView[]>([]);
  const [draft, setDraft] = useState<PlanDraft | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const reload = useCallback(async () => {
    try {
      const r = await api.plans();
      setPlans(r.plans);
    } catch (e) {
      setError(e instanceof ApiError ? e.message : "加载失败");
    }
  }, []);

  useEffect(() => {
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
    const payload = { ...draft };
    // 已存在的套餐（草稿/在售/已下架）一律走 PATCH；只有全新 id 才创建。
    const existing = plans.some((p) => p.plan_id === draft.id);
    await run(
      () => (existing ? api.updatePlan(draft.id, payload) : api.createPlan(payload)),
      existing ? "已保存：只影响之后的新购买，已售订阅按原快照执行" : "已创建草稿（发布后 App 才能看到）",
    );
    setDraft(null);
  }

  function edit(plan: PlanView) {
    setDraft({
      id: plan.plan_id,
      name: plan.name,
      kind: plan.kind,
      price_minor: plan.price_minor,
      currency: plan.currency,
      licence_limit: plan.licence_limit,
      term_days: plan.term_days,
      monthly_quota_gb: plan.monthly_quota_gb,
      traffic_gb: plan.traffic_gb,
      validity_days: plan.validity_days,
      line_ids: plan.line_ids,
      up_mbps: plan.speed?.up_mbps ?? null,
      down_mbps: plan.speed?.down_mbps ?? null,
      sales_channels: plan.sales_channels,
      store_product_id: plan.store_product_id,
      sort_order: plan.sort_order,
    });
  }

  return (
    <div className="stack">
      <div className="card">
        <div className="row between">
          <div>
            <h3>套餐</h3>
            <p className="hint">
              App 里的套餐列表、可买性、升级要补多少钱，全部由这张表决定；改完这里不用发版。
            </p>
          </div>
          <button disabled={busy} onClick={() => setDraft(emptyDraft())}>
            新建套餐
          </button>
        </div>

        {error && <div className="notice error">{error}</div>}
        {notice && <div className="notice ok">{notice}</div>}

        {plans.length === 0 ? (
          <div className="empty">还没有套餐。先建一个草稿，发布后 App 才会展示。</div>
        ) : (
          <div className="table-wrap">
          <table className="table">
            <thead>
              <tr>
                <th>套餐</th>
                <th>类型</th>
                <th>价格</th>
                <th>额度</th>
                <th>有效期</th>
                <th>设备</th>
                <th>状态</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {plans.map((plan) => (
                <tr key={plan.plan_id}>
                  <td className="wrap">
                    <strong>{plan.name}</strong>
                    <div className="mono">{plan.plan_id}</div>
                  </td>
                  <td>{KINDS.find((k) => k.value === plan.kind)?.label ?? plan.kind}</td>
                  <td>
                    ¥{yuan(plan.price_minor)}
                    <div className="mono">{plan.currency}</div>
                  </td>
                  <td>{quotaLabel(plan)}</td>
                  <td>{validityLabel(plan)}</td>
                  <td>{plan.licence_limit}</td>
                  <td>
                    <span className={`tag tag-${plan.status}`}>{plan.status}</span>
                  </td>
                  <td className="actions">
                    {plan.status === "draft" && (
                      <>
                        <button disabled={busy} onClick={() => edit(plan)}>
                          编辑
                        </button>
                        <button disabled={busy} onClick={() => void run(() => api.publishPlan(plan.plan_id), "已发布")}>
                          发布
                        </button>
                      </>
                    )}
                    {plan.status === "active" && (
                      <>
                        <button disabled={busy} onClick={() => edit(plan)}>
                          编辑
                        </button>
                        <button disabled={busy} onClick={() => void run(() => api.retirePlan(plan.plan_id), "已下线")}>
                          下线
                        </button>
                      </>
                    )}
                    {plan.status === "retired" && (
                      <>
                        <button disabled={busy} onClick={() => edit(plan)}>
                          编辑
                        </button>
                        <span className="hint">已下架：只影响能否再卖，已售订阅不受影响</span>
                      </>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          </div>
        )}
      </div>

      {draft && (
        <PlanForm
          draft={draft}
          busy={busy}
          onChange={setDraft}
          onCancel={() => setDraft(null)}
          onSave={save}
        />
      )}
    </div>
  );
}

function PlanForm({
  draft,
  busy,
  onChange,
  onCancel,
  onSave,
}: {
  draft: PlanDraft;
  busy: boolean;
  onChange: (next: PlanDraft) => void;
  onCancel: () => void;
  onSave: () => Promise<void>;
}) {
  const [preview, setPreview] = useState<Record<string, unknown> | null>(null);
  const [previewError, setPreviewError] = useState<string | null>(null);

  const set = <K extends keyof PlanDraft>(key: K, value: PlanDraft[K]) => onChange({ ...draft, [key]: value });

  async function runPreview() {
    setPreviewError(null);
    try {
      const r = await api.previewPlan(draft, null);
      setPreview(r as Record<string, unknown>);
    } catch (e) {
      setPreview(null);
      setPreviewError(e instanceof ApiError ? e.message : String(e));
    }
  }

  const isDraftEditable = true;

  return (
    <div className="card">
      <h3>套餐内容</h3>

      <div className="grid">
        <label>
          ID
          <input value={draft.id} onChange={(e) => set("id", e.target.value)} placeholder="p_30d_100g_1d" />
        </label>
        <label>
          名称
          <input value={draft.name} onChange={(e) => set("name", e.target.value)} placeholder="月付 · 100GB · 1 设备" />
        </label>

        <label>
          类型
          <select
            value={draft.kind}
            onChange={(e) => {
              const kind = e.target.value as PlanDraft["kind"];
              onChange({
                ...draft,
                kind,
                term_days: kind === "period" ? draft.term_days ?? 30 : null,
                monthly_quota_gb: kind === "period" ? draft.monthly_quota_gb ?? 100 : null,
                traffic_gb: kind === "period" ? null : draft.traffic_gb ?? 100,
              });
            }}
          >
            {KINDS.map((k) => (
              <option key={k.value} value={k.value}>
                {k.label}
              </option>
            ))}
          </select>
          <small className="hint">{KINDS.find((k) => k.value === draft.kind)?.hint}</small>
        </label>

        <label>
          价格（元）
          <input
            type="number"
            min={0}
            step="0.01"
            value={(draft.price_minor / 100).toString()}
            onChange={(e) => set("price_minor", Math.round(Number(e.target.value || 0) * 100))}
          />
        </label>

        <label>
          设备数
          <select value={draft.licence_limit} onChange={(e) => set("licence_limit", Number(e.target.value))}>
            <option value={1}>1 台</option>
            <option value={2}>2 台</option>
            <option value={3}>3 台</option>
          </select>
        </label>

        {draft.kind === "period" && (
          <>
            <label>
              周期（天）
              <input
                type="number"
                min={1}
                value={draft.term_days ?? 30}
                onChange={(e) => set("term_days", Number(e.target.value))}
              />
            </label>
            <label>
              每月额度（GB）
              <input
                type="number"
                min={0}
                placeholder="留空 = 不限量"
                value={draft.monthly_quota_gb ?? ""}
                onChange={(e) => set("monthly_quota_gb", e.target.value === "" ? null : Number(e.target.value))}
              />
            </label>
            <small className="hint">
              周期套餐默认支持加购（加量包 = 额外买的流量，不动到期日）；不限量套餐除外。
            </small>
          </>
        )}

        {draft.kind === "traffic" && (
          <>
            <label>
              流量（GB）
              <input
                type="number"
                min={1}
                value={draft.traffic_gb ?? ""}
                onChange={(e) => set("traffic_gb", e.target.value === "" ? null : Number(e.target.value))}
              />
            </label>
            <label>
              有效期（天）
              <input
                type="number"
                min={1}
                placeholder="留空 = 永久"
                value={draft.validity_days ?? ""}
                onChange={(e) => set("validity_days", e.target.value === "" ? null : Number(e.target.value))}
              />
            </label>
          </>
        )}

        {draft.kind === "addon" && (
          <label>
            流量（GB）
            <input
              type="number"
              min={1}
              value={draft.traffic_gb ?? ""}
              onChange={(e) => set("traffic_gb", e.target.value === "" ? null : Number(e.target.value))}
            />
          </label>
        )}

        <label>
          售卖渠道
          <select
            value={draft.sales_channels[0]?.channel ?? "web_checkout"}
            onChange={(e) =>
              set("sales_channels", [{ channel: e.target.value as "web_checkout", methods: ["alipay"] }])
            }
          >
            <option value="web_checkout">网页收银台（支付宝/微信）</option>
            <option value="apple_iap">App Store 内购</option>
            <option value="google_play">Google Play 内购</option>
          </select>
        </label>

        {(draft.sales_channels[0]?.channel === "apple_iap" || draft.sales_channels[0]?.channel === "google_play") && (
          <label>
            商店商品 ID
            <input
              value={
                draft.sales_channels[0]?.channel === "apple_iap"
                  ? draft.store_product_id.apple ?? ""
                  : draft.store_product_id.google ?? ""
              }
              onChange={(e) =>
                set(
                  "store_product_id",
                  draft.sales_channels[0]?.channel === "apple_iap"
                    ? { apple: e.target.value }
                    : { google: e.target.value },
                )
              }
            />
          </label>
        )}

        <label>
          可用线路 ID（逗号分隔，留空 = 全部）
          <input
            value={draft.line_ids.join(",")}
            onChange={(e) =>
              set(
                "line_ids",
                e.target.value
                  .split(",")
                  .map((v) => Number(v.trim()))
                  .filter((v) => Number.isInteger(v) && v > 0),
              )
            }
          />
        </label>
      </div>

      <div className="row between">
        <div className="row">
          <button disabled={busy || !isDraftEditable} onClick={() => void onSave()}>
            {busy ? "保存中…" : "保存草稿"}
          </button>
          <button className="ghost" onClick={onCancel}>
            取消
          </button>
          <button className="ghost" onClick={() => void runPreview()}>
            预览落账参数
          </button>
        </div>
      </div>

      {previewError && <div className="notice error">{previewError}</div>}
      {preview && (
        <pre className="mono preview">{JSON.stringify(preview, null, 2)}</pre>
      )}
      <p className="hint">
        「预览」调的是服务端同一份计算：它会显示这个套餐落到 cf-api 的 `expire_date` / `traffic_balance` / `quota`
        （`quota` 恒为 null —— 额度重置由 CRM 按用户购买锚点结算）。
      </p>
    </div>
  );
}
