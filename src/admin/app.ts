/**
 * 管理后台：App（设计器入口）
 *
 * 只有读：**仓库列表** + 每个仓库的两个时间戳。CRM 不复制 GitHub 的任何状态
 * （分支 / 版本 / 发布记录都在 studio 与 GitHub 上）。
 *
 * 写只有两条，都不在这里：
 *   · 绑定（studio 绑定成功后 `POST /api/studio/app-bind`，凭 `aacc_` 借据）；
 *   · 打开设计器（`POST /api/studio/ticket {aud:"app-studio", repo?}`）。
 */
import type { Env } from "../env";
import { readAppRepos } from "../app/binding";

const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
  });

/** `GET /api/admin/app` → `{repos:[{repo,bound_at,last_used_at}]}`（按最近使用排序） */
export async function handleAdminApp(request: Request, env: Env): Promise<Response | null> {
  const url = new URL(request.url);
  if (url.pathname !== "/api/admin/app") return null;
  if (request.method !== "GET") return json({ error: "method_not_allowed" }, 405);

  const repos = await readAppRepos(env);
  return json({ repos });
}
