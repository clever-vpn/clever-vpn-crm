/** `/api/admin` 的极薄封装：统一错误形状 + CSRF 头。 */

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message?: string,
    /** 原始响应体：L0 闸门之类的失败会带 `issues[]`，页面要逐条展示 */
    readonly body?: Record<string, unknown>,
  ) {
    super(message ?? code);
  }
}

/**
 * `absolute` 用于**不在 `/api/admin` 下**的端点（比如换 studio 票据走的
 * `/api/studio/ticket`）—— 路径是契约里定死的，不能跟着后台前缀跑。
 */
async function call<T>(
  method: string,
  path: string,
  body?: unknown,
  absolute = false,
): Promise<T> {
  const res = await fetch(absolute ? path : `/api/admin${path}`, {
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
      data,
    );
  }
  return data as T;
}

/**
 * 运行期设置。**邮件配额是软上限**：`quota × ratio`（默认 90%），
 * 剩下的留给验证码 —— App 是无密码登录，礼包邮件吃干净配额 = 登录挂掉。
 */
export interface AdminSettings {
  mail: {
    daily_quota: number;
    soft_ratio: number;
    sent_today: number;
    quota_left: number;
    ready: boolean;
    defaults: { daily_quota: number; soft_ratio: number };
  };
}

export interface Me {
  email: string;
  totp_enabled: boolean;
  /** 服务端是否真的配好了发信（EMAIL/RESEND_API_KEY + EMAIL_FROM） */
  mail_ready: boolean;
}

export interface Bootstrap {
  needs_setup: boolean;
  /** true = SaaS 分片：没有"首次初始化"，管理员由平台开通时种 */
  multi?: boolean;
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
  line_ids: number[];
  speed: { up_mbps: number | null; down_mbps: number | null } | null;
  sales_channels: PlanChannel[];
  store_product_id: { apple?: string; google?: string };
  status: PlanStatus;
  /** public = 上架可见；hidden = 仅系统可用（免费试用套餐，不对外出售） */
  visibility: "public" | "hidden";
  /** 免费试用套餐（全库最多一个）：0 元 + hidden，注册后自动开通，不能被购买 */
  trial: boolean;
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
  line_ids: number[];
  up_mbps: number | null;
  down_mbps: number | null;
  sales_channels: PlanChannel[];
  store_product_id: { apple?: string; google?: string };
  visibility: "public" | "hidden";
  /** 免费试用套餐：服务端会强制 price=0 + hidden + period */
  trial: boolean;
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

/**
 * 发布记录（`site_releases`，append-only）。
 *
 * 与 `src/site/publish.ts` 的 `SiteState.releases` 逐字段一致 —— 那边是唯一权威形状，
 * 这里只做类型镜像。**镜像不同步 `typecheck` 照样过**（它只检查我们这边自洽），
 * 所以界面对不对得上只有浏览器能抓：`clever-vpn-site-studio/e2e/panel.spec.ts`。
 */
export interface SiteRelease {
  seq: number;
  source_sha: string;
  artifact_sha: string;
  files: number;
  bytes: number;
  created_at: string;
}

/** 线上正在跑的产物 + 它是什么时候、用哪版设置烘出来的 */
export interface SiteLive {
  artifactSha: string;
  bakedAt: string;
  settingsRev: number;
}

export interface SiteStateView {
  active: number | null;
  /** 源包从哪来：`release:v7` = 线上那一版；`seed` = 还没在设计器里发布过 */
  sourceFrom: string;
  /**
   * 线上正在服务的**产物**（`art/<sha>/`）。设计与产物是两件事：保存设置只换产物、
   * 不换版本号（契约 `site-studio-crm.md` §0.1.3）。
   */
  live?: SiteLive | null;
  /** 最近若干版，最新在前 */
  releases: SiteRelease[];
}

export interface SitePublishResult {
  ok: true;
  version: number;
  files: number;
  bytes: number;
  /** 这次发布的源包 / 渲染后的产物 / 血缘种子 */
  sourceSha: string;
  artifactSha: string;
  seedSha: string;
  /** 同内容重复发布 ⇒ true（返回的是已有版本） */
  idempotent: boolean;
}

/**
 * 站点设置 = **单行 JSON**，键就是模板里写的路径（`site.name`）。
 *
 * 形状**不在这里声明**：字段清单的唯一权威是 CRM 的 `/api/site/meta`
 * （`capabilities`，标准 `site-template.md` §3）。手写一份镜像就是第二份清单 ——
 * 它和真清单不同步时，`typecheck` 照样过。
 */
export type SiteValues = Record<string, unknown>;

/** `/api/site/meta` 的一条能力（表单按它生成，见 `site-fields.ts`） */
export type SiteCapability = import("./site-fields").SiteCapability;
export type SitePalette = import("./site-fields").SitePalette;

export interface SiteMeta {
  contract: number;
  engine: string;
  sdk_version: string;
  capabilities: SiteCapability[];
  /** 成套配色建议：只给表单用，**不落库** */
  palettes: SitePalette[];
  /** 体积上限（整版字节）：studio 与 CRM 同一个口径 */
  limits: { fileBytes: number; totalBytes: number; files: number };
}

/** 一条下载入口：platform / kind 是封闭集合（与后端校验一致） */
export interface DownloadItem {
  platform: string;
  kind: string;
  label: string;
  url: string;
}

export interface SiteCollections {
  downloads: DownloadItem[];
}

export interface SiteSettingsView {
  /** 乐观锁；保存时回传，冲突返 409 */
  rev: number;
  values: SiteValues;
  collections: SiteCollections;
  updatedAt: string | null;
}

export type DomainKind = "site" | "crm";
export type DomainState = "pending" | "active" | "failed";

export interface DomainDnsRecord {
  type: "TXT" | "CNAME";
  name: string;
  value: string;
  status?: string;
}

export interface DomainDns {
  target: string;
  ownership: DomainDnsRecord | null;
  validation: DomainDnsRecord[];
  dcv: DomainDnsRecord[];
}

/** 与 cf-api `/api/v2/crms/domains` 的 `DomainView` 一致 */
export interface DomainView {
  hostname: string;
  kind: DomainKind | string;
  state: DomainState;
  enabled: boolean;
  hostname_status: string | null;
  cert_status: string | null;
  cf_hostname_id: string | null;
  created_at: string | null;
  verified_at: string | null;
  last_checked_at: string | null;
  last_error: string | null;
  dns: DomainDns | null;
}

export interface DomainsView {
  /** multi（SaaS）才有托管绑定；自部署为 false */
  supported: boolean;
  mode: string;
  reason?: string;
  slug?: string;
  defaults?: { crm: string; site: string };
  target?: string;
  domains?: DomainView[];
}

/** cf-api 对接状态（**不含明文 token**） */
export interface PlatformCredsView {
  base_url: string;
  effective_base: string;
  has_token: boolean;
  token_storage: "encrypted" | "plaintext" | "none";
  verified_at: string | null;
  last_error: string | null;
  cipher_ready: boolean;
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
  /** 站点：状态 / 发布 / 回滚（产物在 R2，指针在 KV，见 contracts/site-studio-crm.md §6） */
  site: () => call<SiteStateView>("GET", "/site"),
  sitePublish: () => call<SitePublishResult>("POST", "/site/publish", {}),
  /**
   * 换一张进设计器的票据（一次性，60 秒）。
   *
   * **地址由 CRM 后端拼**：studio 的 origin 只从服务端配置来（契约
   * `studio-identity.md` §2.1）—— 前端把 `aud` 递上去，拿到 `url` 就跳过去。
   */
  studioTicket: () =>
    call<{ url: string }>("POST", "/api/studio/ticket", { aud: "site-studio" }, true),
  /**
   * 数据契约（字段清单 / 配色建议 / 体积上限）。
   *
   * **不在 `/api/admin` 下**：它是公开端点，不带租户数据，所以走 `absolute`。
   */
  siteMeta: () => call<SiteMeta>("GET", "/api/site/meta", undefined, true),
  /** `scope` 是**当前生效**的渲染作用域（颜色留空时是跟随主题的值） */
  siteSettings: () =>
    call<{ settings: SiteSettingsView; scope?: Record<string, unknown> }>("GET", "/site/settings"),
  /** `collections` 不传就不动（只改设置时别把下载入口清空） */
  saveSiteSettings: (input: {
    if_rev?: number;
    values: SiteValues;
    collections?: SiteCollections;
  }) =>
    call<
      { ok: true } & SiteSettingsView & {
          live?: SiteLive | null;
          bake_error?: { code: string; message: string; issues?: string[] };
          /** S2：设了值但这版模板没用到（改了不会生效） */
          unused_settings?: string[];
        }
    >("PUT", "/site/settings", input),
  /** 自定义域名：`refresh=true` 会让 cf-api 回源 Cloudflare 刷新状态 */
  domains: (refresh = true) =>
    call<DomainsView>("GET", `/domains${refresh ? "?refresh=1" : ""}`),
  addDomain: (input: { hostname: string; kind: DomainKind }) =>
    call<{ supported: true; domain: DomainView }>("POST", "/domains", input),
  retryDomain: (hostname: string) =>
    call<{ supported: true; domain: DomainView }>(
      "POST",
      `/domains/${encodeURIComponent(hostname)}/retry`,
      {},
    ),
  removeDomain: (hostname: string) =>
    call<{ supported: true; ok: true; deleted: boolean }>(
      "DELETE",
      `/domains/${encodeURIComponent(hostname)}`,
    ),
  siteRollback: (version: number) =>
    call<{ ok: true; active: number }>("POST", "/site/rollback", { version }),
  me: () => call<Me>("GET", "/me"),
  changePassword: (current: string, next: string) =>
    call<{ ok: true }>("POST", "/password", { current, next }),
  /** 改密的第二种再认证：给当前邮箱发码 */
  sendPasswordCode: () =>
    call<{ ok: true; cooldown: number; code?: string; dev?: boolean }>("POST", "/password/send-code"),
  changePasswordWithCode: (code: string, next: string) =>
    call<{ ok: true }>("POST", "/password", { code, next }),
  /** 忘记密码（未登录）：第一步，给管理员邮箱发重置码 */
  passwordForgot: (email: string, turnstileToken?: string) =>
    call<{ ok: true; cooldown: number; code?: string; dev?: boolean }>(
      "POST",
      "/password/forgot",
      { email, turnstile_token: turnstileToken },
    ),
  /** 忘记密码（未登录）：第二步，用码设新密码（会踢掉所有会话） */
  passwordReset: (email: string, code: string, next: string) =>
    call<{ ok: true }>("POST", "/password/reset", { email, code, next }),
  /** 发一封测试邮件：验证「配了」≠「能发」 */
  testMail: () => call<{ ok: true; dev: boolean }>("POST", "/mail/test"),
  // ── cf-api 对接（基址 / token / 连通性 / 重试落账）──
  platform: () => call<PlatformCredsView>("GET", "/platform"),
  /** `token` 不传 = 不改；传 `null` = 清空；换 token 才需要填 */
  savePlatform: (input: { base_url?: string; token?: string | null }) =>
    call<{ ok: true } & PlatformCredsView>("PUT", "/platform", input),
  testPlatform: () => call<{ ok: true; status: number }>("POST", "/platform/test"),
  retryProvisioning: () =>
    call<{ ok: true; retried: number; failed: number }>("POST", "/platform/provision"),
  /** 运行期设置（目前只有发信配额） */
  settings: () => call<AdminSettings>("GET", "/settings"),
  saveMailSettings: (input: { daily_quota?: number; soft_ratio?: number }) =>
    call<AdminSettings>("PUT", "/settings/mail", input),
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
  /** 人工退款：钱在网关侧退，这里只记账 + 按残值调权益 */
  refundOrder: (
    code: string,
    input: { amount_minor: number; reason: string; gateway_ref?: string },
  ) =>
    call<{
      ok: true;
      refundedMinor: number;
      totalRefundedMinor: number;
      remaining: { days: number } | { gb: number } | null;
      voided: boolean;
      platformSynced: boolean;
    }>("POST", `/orders/${encodeURIComponent(code)}/refund`, input),
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
  /** **直接调整权益**（特殊补偿通道）：在现有订阅上加天数 / 加流量，必须写原因 */
  adjustSubscription: (input: {
    customer_id: number;
    days?: number;
    gb?: number;
    reason: string;
  }) =>
    call<{
      subscription: { expires_at: string | null; remaining_gb: number | null };
      applied: { days: number; gb: number };
      platform_synced: boolean;
    }>("POST", "/subscriptions/adjust", input),

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
  /** 测试支付：只验"这条网关能不能收钱"，不产生订阅（`source='test'` 的测试单） */
  testGateway: (id: number, input: { method?: string; amount_minor?: number } = {}) =>
    call<{ order_code: string; pay_url: string; amount_minor: number; currency: string }>(
      "POST",
      `/gateways/${id}/test`,
      input,
    ),

  /** 临时冻结 / 解冻（停服务，不减权益）：两处一起动，见契约 §2.6 ⑦ */
  setCustomerHold: (id: number, input: { frozen: boolean; reason: string }) =>
    call<{ ok: true; hold: string; platform_synced: boolean }>(
      "POST",
      `/customers/${id}/hold`,
      input,
    ),

  // ── 商店渠道（内购凭证；不是网关，见契约 §2.4.3.1）──
  storeChannels: () => call<StoreChannelsResponse>("GET", "/store-channels"),
  saveStoreChannel: (
    platform: string,
    input: {
      identifier: string;
      environment?: string;
      endpoint?: string;
      status?: string;
      secret?: string;
    },
  ) => call<{ channel: StoreChannelView }>("PUT", `/store-channels/${platform}`, input),

  // ── 营销 / 促销（`docs/promotion.md`）──
  promotions: () => call<{ promotions: PromotionView[] }>("GET", "/promotions"),
  createPromotion: (input: PromotionDraft) =>
    call<{ promotion: PromotionView }>("POST", "/promotions", input),
  updatePromotion: (id: number, input: Partial<PromotionDraft>) =>
    call<{ promotion: PromotionView }>("PATCH", `/promotions/${id}`, input),
  publishPromotion: (id: number) => call<{ ok: true }>("POST", `/promotions/${id}/publish`),
  endPromotion: (id: number) => call<{ ok: true }>("POST", `/promotions/${id}/end`),
  /** 只有「草稿 + 无码 + 无核销」能删 */
  deletePromotion: (id: number) => call<{ ok: true }>("DELETE", `/promotions/${id}`),
  /** 用户侧兑换（官网账户页用；App 走同一个端点） */
  redeem: (code: string) =>
    call<{
      ok: boolean;
      promotion_name?: string;
      applied?: GiftRewards;
      opened?: boolean;
      expires_at?: string | null;
      remaining_gb?: number | null;
      reason?: string;
    }>("POST", "/redeem", { code }),
  /** 批次码：生成一批同规则的码（一码一人），并看每个码的用量 */
  promotionCodes: (id: number) =>
    call<{ codes: PromotionCodeView[] }>("GET", `/promotions/${id}/codes`),
  generatePromotionCodes: (
    id: number,
    input: { count: number; max_uses?: number; prefix?: string | null; note?: string | null },
  ) => call<{ batch_id: string; codes: { id: number; code: string }[]; requested: number }>(
    "POST",
    `/promotions/${id}/codes`,
    input,
  ),
  revokePromotionCode: (id: number, codeId: number) =>
    call<{ ok: true }>("DELETE", `/promotions/${id}/codes/${codeId}`),
  promotionTargets: (id: number) =>
    call<{ customers: { id: number; email: string; display_name: string | null }[] }>(
      "GET",
      `/promotions/${id}/targets`,
    ),
  setPromotionTargets: (id: number, customerIds: number[]) =>
    call<{ ok: true; count: number }>("PUT", `/promotions/${id}/targets`, {
      customer_ids: customerIds,
    }),
};

// ── 营销 / 促销 ──

/** coupon = 优惠券（改订单金额）；gift = 礼包（改权益）；referral = 邀请返利（关系 + 双方奖励） */
export type PromotionKind = "coupon" | "gift" | "referral";
/** 人群（契约 §2.9.6）：全员 / 新客 / 老客 / 快到期 / 已过期 / 点名 */
export type Audience = "all" | "new" | "existing" | "expiring" | "expired" | "specific";
/** 礼包奖励项：只改权益，不改金额。两个维度互相独立，不适用于当前套餐的会被忽略 */
export interface GiftRewards {
  days: number;
  gb: number;
}
export interface PromotionCodeView {
  id: number;
  code: string;
  batch_id: string | null;
  max_uses: number;
  used: number;
  status: string;
  expires_at: string | null;
  note: string | null;
  created_at: string;
}
export type PromotionStatus = "draft" | "active" | "ended";
export type BenefitType = "amount" | "percent";
export type RewardType = "days" | "gb" | "none";

/**
 * 后台视图。`code` 为 null 表示**自动生效**（用户不需要输入任何码）。
 * 与 `src/admin/promotions.ts` 的 `view()` 一一对应。
 */
export interface PromotionView {
  id: number;
  /** 优惠券是否「不用码就生效」（礼包 / 邀请恒为 false） */
  auto_apply: boolean;
  name: string;
  kind: PromotionKind;
  benefit_type: BenefitType;
  /** amount = 分；percent = 1–100 */
  benefit_value: number;
  min_subtotal_minor: number;
  limit_plan_kinds: PlanKind[];
  limit_plan_ids: string[];
  /** 礼包奖励项（kind=gift 才有意义） */
  rewards: GiftRewards;
  /** 领取成功后是否发**收据**邮件（默认 false：结果已经同步显示在页面上） */
  notify: boolean;
  audience: Audience;
  /** audience=expiring 时必填（N 天内到期） */
  audience_days: number | null;
  cooldown_hours: number | null;
  new_user_within_days: number | null;
  starts_at: string | null;
  ends_at: string | null;
  max_uses: number | null;
  max_uses_per_customer: number;
  badge_label: string | null;
  /** 定价页上用户真正看到的那句话（含系统生成的人群前缀），只读 */
  badge_label_full: string | null;
  visible: boolean;
  referrer_reward_type: RewardType | null;
  referrer_reward_value: number | null;
  referee_reward_type: RewardType | null;
  referee_reward_value: number | null;
  status: PromotionStatus;
  /** 已核销次数 */
  uses?: number;
  /** 码统计：个数 / 可用个数 / 总容量（null = 有不限量的码） */
  code_stats?: { codes: number; active: number; capacity: number | null };
}

export type PromotionDraft = Omit<
  PromotionView,
  "id" | "status" | "uses" | "badge_label_full" | "code_stats"
>;


// ── 客户与订单 ──

export type SubscriptionStatus = "active" | "inactive";
/** 不可用的原因（CRM 对外只给这三种；撤销/退款也归 frozen） */
export type InactiveReason = "expired" | "exhausted" | "frozen";

export interface AdminSubscriptionSummary {
  plan_id: string;
  kind: "period" | "traffic" | "addon";
  expires_at: string | null;
  licence_limit: number | null;
  /** period 专有：每月额度 */
  period_quota_gb: number | null;
  /** period 专有：额外流量池（加量包 + 赠送 + 邀请），不随月度重置清零 */
  period_extra_gb: number | null;
  /** traffic 包的整包容量（period 为 null） */
  traffic_total_gb: number | null;
  /** 平台真实剩余（缓存，TTL 15 分钟；null = 还没同步过） */
  traffic_remaining_gb: number | null;
  paid_minor: number | null;
  status: SubscriptionStatus;
  /** 不可用的原因（expired / exhausted / frozen）；`active` 时为 null */
  status_reason: InactiveReason | null;
  /** 用户可见的整句文案，后台直接展示 */
  status_text: string | null;
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
  /** 已退金额（分）；**累计**，可多次部分退款 */
  refunded_minor: number;
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

export interface StoreChannelView {
  platform: string;
  endpoint: string;
  identifier: string;
  environment: string;
  /** `unset` = 还没配置过 */
  status: string;
  has_secret: boolean;
  last_ok_at: string | null;
  last_error: string | null;
}

export interface StoreChannelsResponse {
  channels: StoreChannelView[];
  secret_key_ready: boolean;
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
}
