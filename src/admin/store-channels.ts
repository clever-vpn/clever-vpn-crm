/**
 * 管理后台：商店渠道 `/api/admin/store-channels*`
 *
 * 与 `/api/admin/gateways` 刻意分开：
 *   - 网关是"钱进租户商户号、CRM 发起支付"；商店是"钱进 Apple/Google、CRM 只能查单"；
 *   - 所以这里没有 `methods` / `priority` / 白名单，只有"每平台一行 + 凭据 + 开关"。
 *
 * 三个硬规则：
 *   1. `platform` 只有 apple / google，每平台最多一行（唯一索引兜底）；
 *   2. 凭据只进不出：写入加密，任何响应只给 `has_secret`；
 *   3. 沙盒环境只在非生产实例可配 —— 生产实例收沙盒凭据一律拒绝（契约 §2.4.3）。
 */
import {
  listStoreChannels,
  storeChannelView,
  upsertStoreChannel,
} from "../payments/store-channels";
import { secretKeyConfigured } from "../payments/secret";
import { DEFAULT_ENDPOINTS, STORE_PLATFORMS } from "../payments/store-channels";

import type { Env } from "../env";

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
  });
}

function fail(status: number, code: string, message?: string): Response {
  return json({ error: { code, message: message ?? code } }, status);
}

async function readBody(request: Request): Promise<Record<string, unknown>> {
  try {
    return (await request.json()) as Record<string, unknown>;
  } catch {
    return {};
  }
}

export async function handleAdminStoreChannels(
  request: Request,
  env: Env,
  actor: string,
): Promise<Response | null> {
  const url = new URL(request.url);
  const path = url.pathname.replace(/^\/api\/admin/, "");
  const method = request.method;

  if (!path.startsWith("/store-channels")) return null;

  // ── 列表（两个平台都返回，未配置的给默认值，前端不用判 null） ──
  if (method === "GET" && path === "/store-channels") {
    const rows = await listStoreChannels(env);
    const byPlatform = new Map(rows.map((r) => [r.platform, r]));
    return json({
      channels: STORE_PLATFORMS.map((platform) => {
        const row = byPlatform.get(platform);
        return row
          ? storeChannelView(row)
          : {
              platform,
              endpoint: DEFAULT_ENDPOINTS[platform],
              identifier: "",
              environment: "production",
              status: "unset",
              has_secret: false,
              last_ok_at: null,
              last_error: null,
            };
      }),
      secret_key_ready: secretKeyConfigured(env),
    });
  }

  // ── 新建 / 更新（每平台一行，`platform` 即主键语义） ──
  const one = /^\/store-channels\/([a-z]+)$/.exec(path);
  if (method === "PUT" && one) {
    const body = await readBody(request);
    const res = await upsertStoreChannel(env, String(one[1]), {
      identifier: typeof body.identifier === "string" ? body.identifier : "",
      environment: typeof body.environment === "string" ? body.environment : undefined,
      endpoint: typeof body.endpoint === "string" ? body.endpoint : undefined,
      secret: typeof body.secret === "string" ? body.secret : undefined,
      clearSecret: body.clear_secret === true,
      status: typeof body.status === "string" ? body.status : undefined,
    });
    if (!res.ok) return fail(400, res.code, res.message);
    return json({ channel: storeChannelView(res.row), actor });
  }

  return fail(404, "not_found");
}
