/**
 * App 的**仓库绑定**：CRM 存一份**仓库列表**（2026-11-27：一个仓库 = 一个 App = 一份草稿）。
 *
 * 契约：`clever-vpn-docs/docs/contracts/services/crm/app-studio.md` §3.2 / §4.0。
 *
 * 为什么是列表：一个租户可以有多间仓库（多个 App），打开设计器时要先"选哪一间"。
 * 绑定就是把一间加进列表（重复绑定 = 更新那一条的时间），**不是覆盖别的**。
 *
 * 为什么只存 `repo` 与两个时间戳：
 *   · `installation id` 会因卸载重装漂移 —— studio 按 repo 反查，这里不存依赖；
 *   · 分支 / 版本 / 发布状态都在 studio 或 GitHub 上，CRM 不复制。
 *
 * 为什么写入口径这么窄：`POST /api/studio/app-bind` 是 CRM 唯一接受 studio 写入的地方，
 * 凭据是 `aacc_…`（只对这个端点有效，见 `app/access.ts`）。
 */

import { getSetting, setSetting } from "../settings";
import { verifyAppAccess } from "./access";

import type { Env } from "../env";

/** `owner/name`：与 studio 侧的 `REPO_RE` 同一张（两边各有一份，避免跨仓依赖） */
const REPO_RE = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})\/[A-Za-z0-9._-]{1,100}$/;

const KEY = "app.repos";

export interface BoundRepo {
  repo: string;
  /** 第一次绑定的时间 */
  bound_at: string;
  /** 最近一次用它打开设计器的时间（排序用） */
  last_used_at: string | null;
}

/** 按"最近使用，其次最近绑定"排序（页面直接用这个顺序） */
const sortByRecent = (list: BoundRepo[]): BoundRepo[] =>
  [...list].sort((a, b) => {
    const at = Date.parse(a.last_used_at ?? a.bound_at ?? "") || 0;
    const bt = Date.parse(b.last_used_at ?? b.bound_at ?? "") || 0;
    return bt - at;
  });

/** 读列表。兼容早期的单仓键 `app.repo`（读一次，之后自然被新写覆盖）。 */
export async function readAppRepos(env: Env): Promise<BoundRepo[]> {
  const raw = await getSetting(env, KEY);
  if (raw) {
    try {
      const parsed = JSON.parse(raw) as unknown;
      if (Array.isArray(parsed)) {
        const list = parsed
          .map((item) => {
            const row = item as Partial<BoundRepo>;
            const repo = String(row?.repo ?? "").trim();
            if (!REPO_RE.test(repo)) return null;
            return {
              repo,
              bound_at: String(row?.bound_at ?? ""),
              last_used_at: row?.last_used_at ? String(row.last_used_at) : null,
            } satisfies BoundRepo;
          })
          .filter((x): x is BoundRepo => x !== null);
        return sortByRecent(list);
      }
    } catch {
      /* 坏值当没有，下一次写入会覆盖 */
    }
  }

  const legacy = String((await getSetting(env, "app.repo")) ?? "").trim();
  if (REPO_RE.test(legacy)) {
    const boundAt = String((await getSetting(env, "app.bound_at")) ?? "").trim();
    return [{ repo: legacy, bound_at: boundAt, last_used_at: null }];
  }
  return [];
}

async function write(env: Env, list: BoundRepo[]): Promise<void> {
  await setSetting(env, KEY, JSON.stringify(sortByRecent(list)));
}

/** 加一间（重复 = 更新 bound_at，保留 last_used_at） */
export async function bindAppRepo(
  env: Env,
  input: { repo: string; installationId: number | null },
  now: Date = new Date(),
): Promise<BoundRepo> {
  const repo = input.repo.trim();
  const list = await readAppRepos(env);
  const existing = list.find((item) => item.repo.toLowerCase() === repo.toLowerCase());
  const at = now.toISOString();

  const next: BoundRepo = existing
    ? { ...existing, repo, bound_at: at }
    : { repo, bound_at: at, last_used_at: null };

  await write(env, [...list.filter((item) => item !== existing), next]);
  // `installation id` 只作展示：不验证、不依赖，也不会进任何票据。
  if (input.installationId && Number.isInteger(input.installationId) && input.installationId > 0) {
    await setSetting(env, `app.installation.${repo}`, String(input.installationId));
  }
  return next;
}

/** 记一次"用这间打开了设计器"（页面按这个排序） */
export async function markAppRepoUsed(env: Env, repo: string, now: Date = new Date()): Promise<void> {
  const list = await readAppRepos(env);
  const index = list.findIndex((item) => item.repo.toLowerCase() === repo.toLowerCase());
  if (index < 0) return;
  list[index] = { ...list[index]!, last_used_at: now.toISOString() };
  await write(env, list);
}

/** 从列表里移除一间（只动面板，不动 GitHub） */
export async function removeAppRepo(env: Env, repo: string): Promise<boolean> {
  const list = await readAppRepos(env);
  const next = list.filter((item) => item.repo.toLowerCase() !== repo.toLowerCase());
  if (next.length === list.length) return false;
  await write(env, next);
  return true;
}

/** 这间是不是已经绑定过（门票只允许打开列表里的仓库） */
export async function isAppRepoBound(env: Env, repo: string): Promise<boolean> {
  const list = await readAppRepos(env);
  return list.some((item) => item.repo.toLowerCase() === repo.toLowerCase());
}

const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
  });

/**
 * `POST /api/studio/app-bind` —— studio 绑定成功后把一间仓库加进列表。
 *
 * 鉴权只有一种：`Authorization: Bearer aacc_…`（CRM 入场时签的，14 天）。
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
    return json({ error: "invalid_repo", message: "仓库必须是 owner/name（例如 acme/my-vpn）" }, 400);
  }

  const raw = Number(body?.installation_id ?? 0);
  const installationId = Number.isInteger(raw) && raw > 0 ? raw : null;

  const saved = await bindAppRepo(env, { repo, installationId }, now);
  return json({ ok: true, repo: saved.repo, bound_at: saved.bound_at });
}
