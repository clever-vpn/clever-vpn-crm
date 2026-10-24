/** Worker 运行时绑定与变量。集中放这里，避免 router 与入口互相 import。 */
export interface Env {
  DB: D1Database;
  /** 静态资源（web/dist，含管理后台 SPA） */
  ASSETS: Fetcher;

  /** cf-api 租户 ID */
  CRM_TENANT_ID?: string;
  /** cf-api 基址（自托管/托管一致） */
  CF_API_BASE?: string;
  /** 租户 API Token（wrangler secret put CF_API_TOKEN） */
  CF_API_TOKEN?: string;
  /** 会话签名密钥（wrangler secret put SESSION_SECRET） */
  SESSION_SECRET?: string;
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
  /**
   * App 端跨域白名单（逗号分隔，精确匹配 Origin）：
   * 例如 `https://app-web.clever-vpn.org,http://localhost:5180`。
   * 为空时**不返回任何 CORS 头**（同源部署不需要）。
   */
  APP_ORIGINS?: string;
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
   * 支付网关密钥的**主密钥**（`wrangler secret put PAYMENT_SECRET_KEY`）。
   *
   * 用于 AES-GCM 加解密 `payment_gateways.secret_enc`。**没配就不能保存/使用
   * 真实网关密钥**（mock 除外，它用 `SESSION_SECRET` 派生）。
   * 换掉它会导致已有密文全部解不开 —— 因为密文只存了 `v1:` 前缀，没有其他依赖。
   */
  PAYMENT_SECRET_KEY?: string;

  /**
   * **测试网关（`driver = 'mock'`）的总开关**，默认关闭（`docs/payments.md` §5.3）。
   *
   * 为 `"true"` 时，mock 网关才能创建/发布并参与路由。
   * **租户业务正式上线时改回 false** —— 这是防止"上线后还能免费开通"的第一道闸门
   * （第二道是网关自身的 `allowed_emails` 白名单）。
   */
  ALLOW_MOCK_PAYMENTS?: string;
}
