/**
 * 管理后台：App（设计器入口）
 *
 * 读：**仓库列表** + 每个仓库的两个时间戳。CRM 不复制 GitHub 的任何状态
 * （分支 / 版本 / 发布记录都在 studio 与 GitHub 上）。
 *
 * 写只有一条，在这里：**从面板移除**（`DELETE /api/admin/app?repo=`）。
 * 它只改 CRM 的列表 —— GitHub 上的项目、设计器里的草稿都不动（用户明确要求）。
 *
 * 另外两条写不在这里：
 *   · 绑定（studio 绑定成功后 `POST /api/studio/app-bind`，凭 `aacc_` 借据）；
 *   · 打开设计器（`POST /api/studio/ticket {aud:"app-studio", repo?}`）。
 */
import type { Env } from "../env";
import { readAppRepos, removeAppRepo } from "../app/binding";

/** `owner/name`：与绑定那边同一张（这里只做形状校验） */
const REPO_RE = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})\/[A-Za-z0-9._-]{1,100}$/;

const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
  });

/**
 * `GET /api/admin/app`   → `{repos:[{repo,bound_at,last_used_at}]}`（按最近使用排序）
 * `DELETE /api/admin/app?repo=owner/name` → 只从面板移除
 */
export async function handleAdminApp(request: Request, env: Env): Promise<Response | null> {
  const url = new URL(request.url);
  if (url.pathname !== "/api/admin/app") return null;

  if (request.method === "GET") {
    const repos = await readAppRepos(env);
    return json({ repos });
  }

  if (request.method === "DELETE") {
    const repo = String(url.searchParams.get("repo") ?? "").trim();
    if (!REPO_RE.test(repo)) {
      return json({ error: "invalid_repo", message: "仓库必须是 owner/name" }, 400);
    }
    const removed = await removeAppRepo(env, repo);
    if (!removed) {
      return json({ error: "app_not_found", message: `列表里没有这间：${repo}` }, 404);
    }
    return json({ ok: true, repo });
  }

  return json({ error: "method_not_allowed" }, 405);
}
