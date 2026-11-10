/** Worker 运行时绑定与变量。集中放这里，避免 router 与入口互相 import。 */
export interface Env {
  DB: D1Database;
  /**
   * 多租户模式：`single`（默认，自部署）| `multi`（SaaS 分片）。
   * 只有 single 时 `DB` 才是配置里那个绑定；multi 下由 `src/tenant/scope.ts`
   * 按 `host → slot` 从 `DB_<slot>` 里挑一个放进 `env.DB`。
   */
  MODE?: string;
  /** multi 专用：`host:* → { tenant_id, slot, shard, status }`；也存站点指针 `site:<id>:active` */
  HOSTS?: KVNamespace;
  /**
   * 站点产物（R2）。键布局：`g/templates/<模板>/<版本>/…` 与
   * `sites/<租户>/versions/<n>/public/…`，与 `workers/site`（site-serve）严格一致。
   * 未绑定时站点功能整体不可用（发布返回 `r2_not_configured`），其余功能不受影响。
   */
  SITES?: R2Bucket;
  /** 静态资源（web/dist，含管理后台 SPA） */
  ASSETS: Fetcher;

  /** cf-api 租户 ID */
  CRM_TENANT_ID?: string;
  /**
   * cf-api 基址的**缺省值**（自托管/托管一致）。
   * 租户 token 不在这里：它存本租户 D1 的 `cf_api` 单行（加密），
   * 因为托管分片一个 Worker 服务多个租户，部署级 secret 在模型上就是错的。
   */
  CF_API_BASE?: string;
  /**
   * **唯一的主密钥**（`wrangler secret put APP_SECRET`），一把顶两个用途：
   *
   *   1. HMAC 一次性证明：邮件退订链接 `?c=<id>&t=<hmac>`、`mock` 支付回调签名
   *      （与登录态无关；登录态是 `app_sessions` 里的随机 token + 查表）
   *   2. AES-GCM 加密落库：网关商户密钥、商店凭据、cf-api token
   *
   * 两个用途用的是**派生后不同**的字节（`src/secrets.ts` 的标签派生），
   * 不是同一个 key 复用。
   *
   * ⚠️ **定了就别换**：换掉 = 已发出的退订链接失效 + 已存的密钥/token 全部解不开。
   */
  APP_SECRET?: string;
  /**
   * 两个 studio 的对外地址（**服务端配置**，从不接受请求方传入 —— 否则是开放重定向）。
   * 票据 URL 形如 `<origin>/#t=<ticket>`。
   */
  STUDIO_SITE_URL?: string;
  STUDIO_APP_URL?: string;
  /** 首次初始化管理员用的一次性口令（wrangler secret put SETUP_TOKEN） */
  SETUP_TOKEN?: string;
  /** 密码哈希迭代次数；Workers 免费版 CPU 只有 10ms，必要时下调 */
  ADMIN_PBKDF2_ITERATIONS?: string;

  /** 代码版本（发布时注入，用于 /__version 与托管侧版本核对） */
  CRM_CODE_VERSION?: string;
  /** 契约版本（与 cf-api 对齐的接口版本） */
  CRM_CONTRACT_VERSION?: string;

  /**
   * 运行环境。`production` 以外会**把验证码直接回显给客户端**
   * （与 cf-api/cf-dashboard 一致的本地联调做法）；生产环境绝不回显。
   */
  ENVIRONMENT?: string;
  /** 官网地址（独立静态站）。配了以后访问 CRM 根路径会 302 过去 */
  SITE_URL?: string;
  /**
   * 发布站点时写进产物 `config.js` 的 CRM 基址。留空 = 用发布者访问的那个 origin。
   * 只有"后台同时挂多个域名、但站点必须固定打某一个"时才需要显式配。
   */
  SITE_API_BASE?: string;
  /** 可选：Cloudflare Email Service 绑定（未配置时用 RESEND_API_KEY） */
  EMAIL?: { send(options: Record<string, unknown>): Promise<unknown> };
  /** 可选：Resend API key（HTTP 发信，与 EMAIL 绑定二选一） */
  RESEND_API_KEY?: string;
  /** 发信人（域名需已验证）；与上面任一项同时存在才算“邮件已就绪” */
  EMAIL_FROM?: string;

  /**
   * Turnstile site key（公开值，可写在 wrangler vars 里）。
   * 下发到 `/api/admin/bootstrap`，前端据此决定渲染不渲染挂件。
   */
  TURNSTILE_SITE_KEY?: string;
  /**
   * Turnstile secret（`wrangler secret put TURNSTILE_SECRET`）。
   * **未配置 = 不做人机校验**：本地开发和不想开自托管的租户都不受影响。
   */
  TURNSTILE_SECRET?: string;

  /**
   * **测试网关（`driver = 'mock'`）的总开关**，默认关闭（`docs/payments.md` §5.3）。
   *
   * 为 `"true"` 时，mock 网关才能创建/发布并参与路由。
   *
   * **托管分片默认开**（`scripts/render-shard-config.mjs`）：测试网关是租户验证
   * 支付流程的产品能力，用真网关去测既费钱也不可重复。
   *
   * "不对访客开放"由**网关自身的白名单**保证，不是靠这个开关：`driver='mock'`
   * 白名单为空时对**任何人**都不存在（含登录用户），发布/编辑/查询三层都会拦。
   */
  ALLOW_MOCK_PAYMENTS?: string;
}
