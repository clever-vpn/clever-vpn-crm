/**
 * 多租户 schema 门禁（`src/db/schema-guard.ts`）
 *
 * 这一层只有真跑 D1 才测得出来：`batch` 到底是不是事务、台账读法、`CREATE TABLE
 * IF NOT EXISTS` 是否幂等 —— 假 D1 全都测不到。所以放在 workerd（Miniflare）里跑。
 *
 * 前两个 describe 是**前提**（`batch` 的原子性），后面才是门禁行为本身。
 */
import { describe, expect, it } from "vitest";

import { __resetSchemaGuardForTests, ensureTenantSchema, SchemaGateError } from "../../src/db/schema-guard";
import { MIGRATION_BUNDLE, EXPECTED_NAMES } from "../../src/db/migrations.generated";
import { env } from "./apply-migrations";

const LEDGER = `"d1_migrations"`;
const ALL = MIGRATION_BUNDLE.files.map((file) => file.name);

/** 台账里现在有哪些名字（升序） */
async function ledgerNames(): Promise<string[]> {
  const { results } = await env.DB.prepare(`SELECT "name" FROM ${LEDGER} ORDER BY "id"`).all<{
    name: string;
  }>();
  return results.map((row) => String(row.name));
}

/** 把台账摆成指定状态（不动表） */
async function setLedger(names: string[]): Promise<void> {
  await env.DB.prepare(`DELETE FROM ${LEDGER}`).run();
  for (const name of names) {
    await env.DB.prepare(`INSERT INTO ${LEDGER} ("name") VALUES (?)`).bind(name).run();
  }
}

async function tableExists(name: string): Promise<boolean> {
  const row = await env.DB.prepare(`SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?`)
    .bind(name)
    .first<{ name: string }>();
  return row !== null;
}

/**
 * 计数用的 D1 包装：门禁的"热路径零 I/O"和"单飞只查一次"只有数调用次数才验得出来。
 * 其余成员原样透传给真库。
 */
function countingDb(): { db: D1Database; calls: { prepare: number; batch: number } } {
  const calls = { prepare: 0, batch: 0 };
  const db = {
    prepare(sql: string) {
      calls.prepare++;
      return env.DB.prepare(sql);
    },
    batch(statements: D1PreparedStatement[]) {
      calls.batch++;
      return env.DB.batch(statements);
    },
  } as unknown as D1Database;
  return { db, calls };
}

describe("spike: D1 batch 的事务性（门禁的前提）", () => {
  it("整批成功时 DDL 生效", async () => {
    await env.DB.batch([
      env.DB.prepare("CREATE TABLE spike_ok (x text)"),
      env.DB.prepare("CREATE INDEX idx_spike_ok ON spike_ok (x)"),
    ]);
    expect(await tableExists("spike_ok")).toBe(true);
  });

  it("中途失败 → 前面的 DDL 一起回滚（不会留半迁移）", async () => {
    await expect(
      env.DB.batch([
        env.DB.prepare("CREATE TABLE spike_half (x text)"),
        env.DB.prepare("INSERT INTO spike_half (nope) VALUES (1)"), // 列不存在 → 整批失败
        env.DB.prepare("CREATE TABLE spike_after (x text)"),
      ]),
    ).rejects.toThrow();
    expect(await tableExists("spike_half")).toBe(false);
    expect(await tableExists("spike_after")).toBe(false);
  });

  it("失败批次里的台账 INSERT 也不会留下", async () => {
    await expect(
      env.DB.batch([
        env.DB.prepare("CREATE TABLE spike_ledger (x text)"),
        env.DB.prepare("SELECT * FROM no_such_table"),
        env.DB.prepare(`INSERT INTO ${LEDGER} ("name") VALUES ('9999_spike.sql')`),
      ]),
    ).rejects.toThrow();
    expect(await ledgerNames()).not.toContain("9999_spike.sql");
  });
});

describe("门禁判据（文件名集合）", () => {
  it("内嵌 bundle 与生产链同名（只比集合，不比 tag）", () => {
    expect(MIGRATION_BUNDLE.files.map((file) => file.name)).toEqual(ALL);
    expect(ALL.every((name) => EXPECTED_NAMES.has(name))).toBe(true);
  });

  it("相等：放行，且不写任何东西", async () => {
    __resetSchemaGuardForTests();
    await setLedger(ALL);

    await expect(ensureTenantSchema(env.DB, 11)).resolves.toBeUndefined();
    expect(await ledgerNames()).toEqual(ALL); // 没有 no-op 写
  });

  it("领先：台账里有代码不认识的文件 → schema_ahead（不是跑下去撞表）", async () => {
    __resetSchemaGuardForTests();
    await setLedger([...ALL, "9999_future.sql"]);

    const failure = await ensureTenantSchema(env.DB, 12).catch((e: unknown) => e);
    expect(failure).toBeInstanceOf(SchemaGateError);
    expect((failure as SchemaGateError).code).toBe("schema_ahead");
    expect((failure as SchemaGateError).message).toContain("9999_future.sql");

    await setLedger(ALL); // 还原，后面的用例还要用这个库
  });

  it("热路径：结论缓存 5 分钟，TTL 内零 I/O", async () => {
    __resetSchemaGuardForTests();
    const { db, calls } = countingDb();

    await ensureTenantSchema(db, 13);
    const cold = { ...calls };
    expect(cold.prepare).toBeGreaterThan(0);

    await ensureTenantSchema(db, 13);
    await ensureTenantSchema(db, 13);
    expect(calls).toEqual(cold); // 一次 prepare 都没多
  });

  it("单飞：同一 slot 的并发请求只查一次台账", async () => {
    __resetSchemaGuardForTests();
    const { db, calls } = countingDb();

    await Promise.all([
      ensureTenantSchema(db, 14),
      ensureTenantSchema(db, 14),
      ensureTenantSchema(db, 14),
    ]);
    // 冷路径固定三条 prepare（sqlite_master 探针 + 同一 batch 里的台账/身份两条），
    // 三次调用不叠加
    expect(calls.prepare).toBe(3);
    expect(calls.batch).toBe(0);
  });

  it("不同 slot 各自独立（一个槽的结论不会串到另一个槽）", async () => {
    __resetSchemaGuardForTests();
    const { db, calls } = countingDb();

    await ensureTenantSchema(db, 15);
    expect(calls.prepare).toBe(3);
    await ensureTenantSchema(db, 16);
    expect(calls.prepare).toBe(6); // 换了 slot 就要重新判一次
  });
});

describe("空库 / 整条链（清空重开与池里新建的库）", () => {
  it("台账不存在 → 建台账、一个 batch 跑完全部迁移、再跑一次零动作", async () => {
    __resetSchemaGuardForTests();

    // 摆成"全新库"：表全删（含台账）。这条与 setup 里 apply 过的库等价于清空重开。
    const { results } = await env.DB.prepare(
      `SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '_cf_%'`,
    ).all<{ name: string }>();
    for (const { name } of results) {
      await env.DB.prepare(`DROP TABLE IF EXISTS "${name}"`).run();
    }
    expect(await tableExists("admin_users")).toBe(false);

    await ensureTenantSchema(env.DB, 17);

    // 整条链当场补齐，台账登记全部文件名
    expect(await tableExists("admin_users")).toBe(true);
    expect(await ledgerNames()).toEqual(ALL);

    // 幂等：再跑一次不新增、不报错（"发版不改迁移 = 零动作"）
    __resetSchemaGuardForTests();
    await expect(ensureTenantSchema(env.DB, 17)).resolves.toBeUndefined();
    expect(await ledgerNames()).toEqual(ALL);
  });
});
