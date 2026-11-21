/**
 * 库身份自检（`src/db/schema-guard.ts`）—— 真 D1 上验证。
 *
 * 目标：确认 `DB_<slot>` 指向的是"它该服务的那个库"，而不是别的租户的库。
 * 这是运行期唯一能读到**被绑库真实身份**的地方（Worker 拿不到 binding 的 uuid），
 * 所以校验必须发生在迁移之前，且失败时不能写任何东西。
 */
import { beforeEach, describe, expect, it } from "vitest";

import {
  __resetSchemaGuardForTests,
  SchemaGateError,
  ensureTenantSchema,
} from "../../src/db/schema-guard";
import { env } from "./apply-migrations";

const UUID = "b55a1c0e-a77a-46ec-b9a8-72f996d3f27a";

async function setIdentity(uuid: string | null): Promise<void> {
  await env.DB.prepare(`CREATE TABLE IF NOT EXISTS d1_identity (d1_uuid TEXT NOT NULL)`).run();
  await env.DB.prepare(`DELETE FROM d1_identity`).run();
  if (uuid !== null) {
    await env.DB.prepare(`INSERT INTO d1_identity (d1_uuid) VALUES (?)`).bind(uuid).run();
  }
}

beforeEach(async () => {
  __resetSchemaGuardForTests();
  await setIdentity(UUID);
});

describe("schema 门禁 · 库身份自检", () => {
  it("库内身份与期望一致 ⇒ 放行", async () => {
    await expect(ensureTenantSchema(env.DB, 9101, UUID)).resolves.toBeUndefined();
  });

  it("不一致 ⇒ 503 db_binding_mismatch，且不执行迁移", async () => {
    await setIdentity("11111111-2222-3333-4444-555555555555");
    await expect(ensureTenantSchema(env.DB, 9102, UUID)).rejects.toMatchObject({
      code: "db_binding_mismatch",
    });
  });

  it("身份表不存在 ⇒ 也算不一致（strict）", async () => {
    await env.DB.prepare(`DROP TABLE d1_identity`).run();
    await expect(ensureTenantSchema(env.DB, 9103, UUID)).rejects.toMatchObject({
      code: "db_binding_mismatch",
    });
    // 恢复，避免影响后续用例
    await setIdentity(UUID);
  });

  it("没有期望值（single / 旧记录）⇒ 跳过校验", async () => {
    await setIdentity("whatever-else");
    await expect(ensureTenantSchema(env.DB, 9104)).resolves.toBeUndefined();
  });

  it("结论按 slot 缓存：第二次是纯内存命中（零 prepare）", async () => {
    const calls = { prepare: 0 };
    const counted = {
      prepare(sql: string) {
        calls.prepare += 1;
        return env.DB.prepare(sql);
      },
      batch(statements: D1PreparedStatement[]) {
        return env.DB.batch(statements);
      },
    } as unknown as D1Database;

    await ensureTenantSchema(counted, 9105, UUID);
    const afterFirst = calls.prepare;
    expect(afterFirst).toBeGreaterThan(0);

    await ensureTenantSchema(counted, 9105, UUID);
    expect(calls.prepare).toBe(afterFirst);
  });
});
