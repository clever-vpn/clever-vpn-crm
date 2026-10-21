/**
 * Clever VPN CRM — Worker 入口
 *
 * 当前是**骨架**：只提供 `/health` 与 `/__version`，其余路径返回 501。
 * 业务接口（注册/登录/下单/发激活码）按 docs/contract.md 逐个落地。
 */

import { ensureSchema } from "./db";

export interface Env {
  DB: D1Database;
  /** cf-api 租户 ID */
  CRM_TENANT_ID?: string;
  /** cf-api 基址（自托管/托管一致） */
  CF_API_BASE?: string;
  /** 租户 API Token（wrangler secret put CF_API_TOKEN） */
  CF_API_TOKEN?: string;
  /** 会话签名密钥（wrangler secret put SESSION_SECRET） */
  SESSION_SECRET?: string;
  /** 代码版本（发布时注入，用于 /__version 与托管侧版本核对） */
  CRM_CODE_VERSION?: string;
  /** 契约版本（与 cf-api 对齐的接口版本） */
  CRM_CONTRACT_VERSION?: string;
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8" },
  });
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === "/health") {
      return json({ status: "ok" });
    }

    if (url.pathname === "/__version") {
      return json({
        code: env.CRM_CODE_VERSION ?? "dev",
        contract: env.CRM_CONTRACT_VERSION ?? "1",
        tenant: env.CRM_TENANT_ID ?? null,
      });
    }

    // 任何业务路径都先确保库结构就绪（自迁移）
    await ensureSchema(env.DB);

    return json(
      {
        error: "not_implemented",
        path: url.pathname,
        hint: "按 docs/contract.md 实现（注册/登录/下单/激活码）",
      },
      501,
    );
  },
} satisfies ExportedHandler<Env>;
