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
}
