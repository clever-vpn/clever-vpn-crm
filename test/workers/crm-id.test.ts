/**
 * 实例 UUID（`crm_id`）：首次读取生成、此后稳定、坏值可修复。
 *
 * 它只有一个用途：App 构建期比对 `app.json.crm.id`（`clients.md` §7.1）。
 * 所以"稳定"是硬要求 —— 每次 `GET /meta` 都变，构建门禁就永远对不上。
 */
import { exports as rawExports } from "cloudflare:workers";
import { describe, expect, it } from "vitest";

import { getOrCreateCrmId } from "../../src/settings";
import { env } from "./apply-migrations";

const BASE = "https://crm.test";
const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

const worker = rawExports as unknown as {
  default: { fetch(request: Request): Promise<Response> };
};

const meta = async (): Promise<{ crm_id: string }> => {
  const res = await worker.default.fetch(new Request(`${BASE}/api/app/v1/meta`));
  expect(res.status).toBe(200);
  return (await res.json()) as { crm_id: string };
};

describe("crm_id", () => {
  it("首次生成后稳定，/meta 与 settings 表一致", async () => {
    const a = await getOrCreateCrmId(env);
    const b = await getOrCreateCrmId(env);
    expect(a).toMatch(UUID_RE);
    expect(b).toBe(a);

    expect((await meta()).crm_id).toBe(a);
    expect((await meta()).crm_id).toBe(a);

    const row = await env.DB.prepare(`SELECT value FROM settings WHERE key = 'crm_id'`)
      .first<{ value: string }>();
    expect(row?.value).toBe(a);
  });

  it("库里的坏值会被修复成新的 UUID", async () => {
    await env.DB.prepare(`UPDATE settings SET value = 'not-a-uuid' WHERE key = 'crm_id'`).run();
    const fixed = await getOrCreateCrmId(env);
    expect(fixed).toMatch(UUID_RE);
    expect(fixed).not.toBe("not-a-uuid");
  });
});
