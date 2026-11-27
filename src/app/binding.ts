/**
 * App 的**仓库绑定**：CRM 只存一个 `owner/name`（2026-11-27 简化）。
 *
 * 契约：`clever-vpn-docs/docs/contracts/services/crm/app-studio.md` §3.2 / §4.0。
 *
 * 为什么只存一个键：绑定回答的是"这个租户的成果仓是哪一间"，重复绑定即覆盖。
 * **不存 installation id 作为依赖**（它会因卸载重装漂移）：studio 按 `repo` 反查，
 * CRM 存的那份只用于展示 / 排障。
 *
 * 为什么写入口径这么窄：`POST /api/studio/app-bind` 是 CRM 唯一接受 studio 写入的地方，
 * 凭据是 `aacc_…`（只对这个端点有效，见 `app/access.ts`）。它只写两个键，不碰任何
 * 计费 / 订阅 / 站点数据。
 */

import { getSetting, setSetting } from "../settings";
import { verifyAppAccess } from "./access";

import type { Env } from "../env";

/** `owner/name`：与 studio 侧的 `REPO_RE` 同一张（两边各有一份，避免跨仓依赖） */
const REPO_RE = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})\/[A-Za-z0-9._-]{1,100}$/;

export interface AppBinding {
  repo: string | null;
  boundAt: string | null;
}

/** 读绑定（没绑过就都是 null） */
export async function readAppBinding(env: Env): Promise<AppBinding> {
  const repo = String((await getSetting(env, "app.repo")) ?? "").trim();
  const boundAt = String((await getSetting(env, "app.bound_at")) ?? "").trim();
  return { repo: repo || null, boundAt: boundAt || null };
}

/** 写绑定（覆盖式）。`installationId` 只作展示，studio 不依赖它。 */
export async function saveAppBinding(
  env: Env,
  input: { repo: string; installationId: number | null },
  now: Date = new Date(),
): Promise<AppBinding> {
  const repo = input.repo.trim();
  await setSetting(env, "app.repo", repo);
  await setSetting(env, "app.bound_at", now.toISOString());
  if (input.installationId && Number.isFinite(input.installationId)) {
    await setSetting(env, "app.installation_id", String(input.installationId));
  }
  return { repo, boundAt: now.toISOString() };
}

const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
  });

/**
 * `POST /api/studio/app-bind` —— studio 绑定成功后把 `repo` 写回面板。
 *
 * 鉴权只有一种：`Authorization: Bearer aacc_…`（CRM 入场时签的，14 天）。
 * `tenant` 必须是本次请求解析出的那个租户（在 `verifyAppAccess` 里比对）。
 */
export async function handleAppBind(
  request: Request,
  env: Env,
  tenantId: string,
  now: Date = new Date(),
): Promise<Response> {
  if (request.method !== "POST") return json({ error: "method_not_allowed" }, 405);

  const access = await verifyAppAccess(request, env, tenantId, Math.floor(now.getTime() / 1000));
  if (!access) return json({ error: "app_access_invalid" }, 401);

  let body: { repo?: unknown; installation_id?: unknown };
  try {
    body = (await request.json()) as typeof body;
  } catch {
    return json({ error: "invalid_body", message: 'body 必须是 JSON：{"repo":"owner/name"}' }, 400);
  }

  const repo = String(body?.repo ?? "").trim();
  if (!REPO_RE.test(repo)) {
    return json(
      { error: "invalid_repo", message: "仓库必须是 owner/name（例如 acme/my-vpn）" },
      400,
    );
  }

  // installation_id 只在它是正整数时才记（其它一律当没给）
  const raw = Number(body?.installation_id ?? 0);
  const installationId = Number.isInteger(raw) && raw > 0 ? raw : null;

  const saved = await saveAppBinding(env, { repo, installationId }, now);
  return json({ ok: true, repo: saved.repo, bound_at: saved.boundAt });
}
