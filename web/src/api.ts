/** `/api/admin` 的极薄封装：统一错误形状 + CSRF 头。 */

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message?: string,
  ) {
    super(message ?? code);
  }
}

async function call<T>(method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(`/api/admin${path}`, {
    method,
    credentials: "same-origin",
    headers: {
      "x-crm-request": "1",
      ...(body === undefined ? {} : { "content-type": "application/json" }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  if (!res.ok) {
    throw new ApiError(
      res.status,
      typeof data.error === "string" ? data.error : "request_failed",
      typeof data.message === "string" ? data.message : undefined,
    );
  }
  return data as T;
}

export interface Me {
  email: string;
  totp_enabled: boolean;
}

export interface SessionInfo {
  sid: string;
  created_at: string;
  last_used_at: string;
  ip: string | null;
  user_agent: string | null;
  current: boolean;
}

export interface AuditEntry {
  at: string;
  actor: string;
  action: string;
  target: string | null;
  detail: string | null;
}

export type PlanKind = "period" | "traffic" | "addon";
export type PlanStatus = "draft" | "active" | "retired";

export interface PlanChannel {
  channel: "web_checkout" | "apple_iap" | "google_play";
  methods?: string[];
}

/** 与 `app-crm.md` §2.4.7 的 Plan 结构一致；后台额外带 status 等字段 */
export interface PlanView {
  plan_id: string;
  name: string;
  kind: PlanKind;
  price_minor: number;
  currency: string;
  licence_limit: number;
  term_days: number | null;
  monthly_quota_gb: number | null;
  traffic_gb: number | null;
  validity_days: number | null;
  allow_addons: boolean;
  line_ids: number[];
  speed: { up_mbps: number | null; down_mbps: number | null } | null;
  channels: PlanChannel[];
  store_product_id: { apple?: string; google?: string };
  status: PlanStatus;
  sort_order: number;
  supersedes_id: string | null;
  retired_at: string | null;
}

/** 提交给 `/api/admin/plans` 的输入（服务端 `validatePlan` 会再校验一遍） */
export interface PlanDraft {
  id: string;
  name: string;
  kind: PlanKind;
  price_minor: number;
  currency: string;
  licence_limit: number;
  term_days: number | null;
  monthly_quota_gb: number | null;
  traffic_gb: number | null;
  validity_days: number | null;
  allow_addons: boolean;
  line_ids: number[];
  up_mbps: number | null;
  down_mbps: number | null;
  channels: PlanChannel[];
  store_product_id: { apple?: string; google?: string };
  sort_order: number;
}

/** 换购报价（`app-crm.md` §2.4.8） */
export interface Quote {
  allowed: boolean;
  reason: string | null;
  settlement: "new" | "residual_trade_in" | "store_proration";
  residual_minor: number | null;
  payable_minor: number | null;
  expires_at: string | null;
}

export const api = {
  bootstrap: () =>
    call<{ needs_setup: boolean; setup_configured: boolean }>("GET", "/bootstrap"),
  setup: (token: string, email: string, password: string) =>
    call<{ ok: true; email: string }>("POST", "/setup", { token, email, password }),
  login: (email: string, password: string) =>
    call<{ ok?: true; totp_required?: boolean }>("POST", "/login", { email, password }),
  loginTotp: (code: string) => call<{ ok: true }>("POST", "/login/totp", { code }),
  logout: () => call<{ ok: true }>("POST", "/logout"),
  me: () => call<Me>("GET", "/me"),
  changePassword: (current: string, next: string) =>
    call<{ ok: true }>("POST", "/password", { current, next }),
  sessions: () => call<{ sessions: SessionInfo[] }>("GET", "/sessions"),
  revokeSession: (sid: string) => call<{ ok: true }>("DELETE", `/sessions/${sid}`),
  enrollTotp: () => call<{ secret: string; uri: string }>("POST", "/2fa/enroll"),
  activateTotp: (code: string) => call<{ ok: true }>("POST", "/2fa/activate", { code }),
  disableTotp: (password: string) =>
    call<{ ok: true }>("POST", "/2fa/disable", { password }),
  audit: (limit = 50) => call<{ entries: AuditEntry[] }>("GET", `/audit?limit=${limit}`),

  // ── 套餐（销售策略的唯一写入口）──
  plans: () => call<{ plans: PlanView[] }>("GET", "/plans"),
  createPlan: (input: PlanDraft) => call<{ plan: PlanView }>("POST", "/plans", input),
  updatePlan: (id: string, input: Partial<PlanDraft>) =>
    call<{ plan: PlanView }>("PATCH", `/plans/${id}`, input),
  publishPlan: (id: string) => call<{ plan: PlanView }>("POST", `/plans/${id}/publish`),
  retirePlan: (id: string) => call<{ plan: PlanView }>("POST", `/plans/${id}/retire`),
  clonePlan: (id: string, input: Partial<PlanDraft>) =>
    call<{ plan: PlanView }>("POST", `/plans/${id}/clone`, input),
  /** 干跑：看清落账参数与换购报价，不写库 */
  previewPlan: (plan: Partial<PlanDraft>, current: CurrentSubscriptionInput | null) =>
    call<{ plan: PlanView; control: Record<string, unknown>; quote: Quote }>(
      "POST",
      "/plans/preview",
      { plan, current },
    ),
};

/** 与服务端 `CurrentSubscription` 对齐（仅预览用） */
export interface CurrentSubscriptionInput {
  plan_id: string;
  kind: "period" | "traffic";
  paid_minor: number;
  term_days: number | null;
  traffic_gb: number | null;
  expires_at: string | null;
  remaining_gb: number | null;
  unlimited: boolean;
  allow_addons: boolean;
}
