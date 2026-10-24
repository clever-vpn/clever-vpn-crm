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
  /** 服务端是否真的配好了发信（EMAIL/RESEND_API_KEY + EMAIL_FROM） */
  mail_ready: boolean;
}

export interface Bootstrap {
  needs_setup: boolean;
  setup_configured: boolean;
  /** 可用的登录方式；没有的能力前端就不显示 */
  methods: Array<"password" | "email">;
  mail_ready: boolean;
  /** 开发环境：验证码直接在响应里回显 */
  dev_email_echo: boolean;
  /** 服务端开了 Turnstile 才下发；null = 不渲染挂件 */
  turnstile_site_key: string | null;
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
  sales_channels: PlanChannel[];
  store_product_id: { apple?: string; google?: string };
  status: PlanStatus;
  sort_order: number;
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
  sales_channels: PlanChannel[];
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
  bootstrap: () => call<Bootstrap>("GET", "/bootstrap"),
  setup: (token: string, email: string, password: string, turnstileToken?: string) =>
    call<{ ok: true; email: string }>("POST", "/setup", {
      token,
      email,
      password,
      turnstile_token: turnstileToken,
    }),
  login: (email: string, password: string, turnstileToken?: string) =>
    call<{ ok?: true; totp_required?: boolean }>("POST", "/login", {
      email,
      password,
      turnstile_token: turnstileToken,
    }),
  loginTotp: (code: string) => call<{ ok: true }>("POST", "/login/totp", { code }),
  /** 邮箱验证码登录：第一步发码（开发环境会把 code 带回来） */
  loginEmailStart: (email: string, turnstileToken?: string) =>
    call<{ ok: true; cooldown: number; code?: string; dev?: boolean }>(
      "POST",
      "/login/email/start",
      { email, turnstile_token: turnstileToken },
    ),
  /** 邮箱验证码登录：第二步换会话 */
  loginEmailVerify: (email: string, code: string) =>
    call<{ ok?: true; totp_required?: boolean }>("POST", "/login/email/verify", { email, code }),
  logout: () => call<{ ok: true }>("POST", "/logout"),
  me: () => call<Me>("GET", "/me"),
  changePassword: (current: string, next: string) =>
    call<{ ok: true }>("POST", "/password", { current, next }),
  /** 改密的第二种再认证：给当前邮箱发码 */
  sendPasswordCode: () =>
    call<{ ok: true; cooldown: number; code?: string; dev?: boolean }>("POST", "/password/send-code"),
  changePasswordWithCode: (code: string, next: string) =>
    call<{ ok: true }>("POST", "/password", { code, next }),
  /** 发一封测试邮件：验证「配了」≠「能发」 */
  testMail: () => call<{ ok: true; dev: boolean }>("POST", "/mail/test"),
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
  /** 干跑：看清落账参数与换购报价，不写库 */
  previewPlan: (plan: Partial<PlanDraft>, current: CurrentSubscriptionInput | null) =>
    call<{ plan: PlanView; control: Record<string, unknown>; quote: Quote }>(
      "POST",
      "/plans/preview",
      { plan, current },
    ),
  // ── 客户与订单 ──
  customers: () => call<{ customers: AdminCustomer[] }>("GET", "/customers"),
  createCustomer: (email: string) =>
    call<{ customer: { id: number; email: string } }>("POST", "/customers", { email }),
  orders: (params: { status?: string; customer_id?: number; limit?: number } = {}) => {
    const q = new URLSearchParams();
    if (params.status) q.set("status", params.status);
    if (params.customer_id) q.set("customer_id", String(params.customer_id));
    if (params.limit) q.set("limit", String(params.limit));
    const qs = q.toString();
    return call<{ orders: AdminOrder[] }>("GET", `/orders${qs ? `?${qs}` : ""}`);
  },
  /** 手工开通 / 覆盖订阅（本地联调、运营补单） */
  grantSubscription: (input: { customer_id: number; plan_id: string; paid_minor?: number }) =>
    call<{ subscription: { id: number } }>("POST", "/subscriptions", input),

  // ── 支付网关 ──
  gateways: () => call<GatewaysResponse>("GET", "/gateways"),
  createGateway: (input: GatewayDraft) =>
    call<{ gateway: GatewayView }>("POST", "/gateways", input),
  updateGateway: (id: number, input: Partial<GatewayDraft>) =>
    call<{ gateway: GatewayView }>("PATCH", `/gateways/${id}`, input),
  publishGateway: (id: number) =>
    call<{ gateway: GatewayView }>("POST", `/gateways/${id}/publish`),
  disableGateway: (id: number) =>
    call<{ gateway: GatewayView }>("POST", `/gateways/${id}/disable`),
};


// ── 客户与订单 ──

export type SubscriptionStatus = "active" | "expired" | "exhausted" | "frozen" | "revoked";

export interface AdminSubscriptionSummary {
  plan_id: string;
  kind: "period" | "traffic" | "addon";
  expires_at: string | null;
  licence_limit: number | null;
  quota_gb: number | null;
  /** traffic 包的整包容量（period 为 null） */
  traffic_total_gb: number | null;
  remaining_gb: number | null;
  balance_gb: number | null;
  paid_minor: number | null;
  status: SubscriptionStatus;
  /** 为什么不能用（到期 / 冻结 / 用完）—— 后台也要看得到 */
  status_reason: string | null;
}

export interface AdminCustomer {
  id: number;
  email: string;
  display_name: string | null;
  created_at: string;
  subscription: AdminSubscriptionSummary | null;
}

export interface AdminOrder {
  id: number;
  code: string;
  customer_id: number;
  email: string | null;
  plan_id: string;
  kind: string;
  amount_minor: number;
  currency: string;
  source: string;
  payment_method: string;
  status: string;
  paid_at: string | null;
  created_at: string;
  provider_trade_no: string | null;
  pay_url: string | null;
}

/** 支付网关（服务端**从不回显密钥**，只回 `has_secret`） */
export interface GatewayView {
  id: number;
  driver: string;
  name: string;
  endpoint: string | null;
  merchant_id: string | null;
  has_secret: boolean;
  methods: string[];
  mapping: unknown;
  priority: number;
  status: "draft" | "live" | "disabled";
  currency: string;
  allowed_emails: string[];
  last_test_order_id: number | null;
  last_ok_at: string | null;
  last_error: string | null;
}

export interface GatewayDraft {
  driver: string;
  name: string;
  endpoint?: string | null;
  merchant_id?: string | null;
  /** 明文密钥：只有传了才会更新；留空 = 不改 */
  secret?: string;
  clear_secret?: boolean;
  methods: string[];
  priority?: number;
  currency?: string;
  allowed_emails?: string[];
  mapping?: unknown;
}

export interface GatewaysResponse {
  gateways: GatewayView[];
  mock_enabled: boolean;
  secret_key_ready: boolean;
  drivers: { driver: string; methods: string[] }[];
  all_methods: string[];
}

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
