/**
 * `DELETE /api/admin/app?repo=` —— **只从面板移除**。
 *
 * 用户明确要求：删列表项即可，GitHub 项目与设计器草稿都不动。这里钉住三件事：
 *
 *   1. 移除后列表里没有它，别的条目还在；
 *   2. 形状不对 ⇒ 400；不存在 ⇒ 404（不要"静默成功"，否则界面会以为删了）；
 *   3. 只动 `app.repos`，不动 `app.installation.*` / 草稿（草稿不归 CRM 管）。
 */
import { describe, expect, it } from "vitest";

import { handleAdminApp } from "../../src/admin/app";
import { bindAppRepo, readAppRepos } from "../../src/app/binding";
import { env } from "./apply-migrations";

const del = (repo?: string) =>
  handleAdminApp(
    new Request(`https://crm.test/api/admin/app${repo === undefined ? "" : `?repo=${encodeURIComponent(repo)}`}`, {
      method: "DELETE",
    }),
    env,
  );

describe("移除 App（只动列表）", () => {
  it("移除一项 ⇒ 列表里没有它，其它还在", async () => {
    await bindAppRepo(env, { repo: "acme/a", installationId: 11 });
    await bindAppRepo(env, { repo: "acme/b", installationId: 22 });

    const res = await del("acme/a");
    expect(res?.status).toBe(200);
    expect((await res!.json()) as unknown).toEqual({ ok: true, repo: "acme/a" });

    const list = await readAppRepos(env);
    expect(list.map((r) => r.repo)).toEqual(["acme/b"]);
  });

  it("不存在 ⇒ 404（不静默成功）", async () => {
    await bindAppRepo(env, { repo: "acme/c", installationId: null });
    const res = await del("acme/nope");
    expect(res?.status).toBe(404);
    expect(((await res!.json()) as { error: string }).error).toBe("app_not_found");
  });

  it("形状不对 / 没带 repo ⇒ 400", async () => {
    for (const repo of [undefined, "", "not a repo", "a/b/c"]) {
      const res = await del(repo);
      expect(res?.status).toBe(400);
    }
  });

  it("只动 app.repos：installation 展示键保留（用户要求「其它都不动」）", async () => {
    await bindAppRepo(env, { repo: "acme/d", installationId: 33 });
    const before = await env.DB.prepare(`SELECT value FROM settings WHERE key = 'app.installation.acme/d'`)
      .first<{ value: string }>();
    expect(before?.value).toBe("33");

    await del("acme/d");
    const after = await env.DB.prepare(`SELECT value FROM settings WHERE key = 'app.installation.acme/d'`)
      .first<{ value: string }>();
    expect(after?.value).toBe("33");
  });

  it("GET 仍然可用（同一个 handler）", async () => {
    await bindAppRepo(env, { repo: "acme/e", installationId: null });
    const res = await handleAdminApp(
      new Request("https://crm.test/api/admin/app", { method: "GET" }),
      env,
    );
    expect(res?.status).toBe(200);
    expect(((await res!.json()) as { repos: { repo: string }[] }).repos.some((r) => r.repo === "acme/e")).toBe(true);
  });
});
