import { describe, expect, it } from "vitest";

import { MIGRATIONS, schemaFingerprint } from "../src/migrations";

describe("migrations", () => {
  it("id 唯一、非空、保持声明顺序", () => {
    const ids = MIGRATIONS.map((m) => m.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids.every((id) => id.trim().length > 0)).toBe(true);
    expect(schemaFingerprint()).toBe(ids.join(","));
  });

  it("每个迁移至少一条语句", () => {
    for (const migration of MIGRATIONS) {
      expect(migration.statements.length).toBeGreaterThan(0);
    }
  });

  it("建表/建索引必须幂等（IF NOT EXISTS）", () => {
    for (const migration of MIGRATIONS) {
      for (const sql of migration.statements) {
        if (/^\s*CREATE\s+(TABLE|INDEX|UNIQUE\s+INDEX)/i.test(sql)) {
          expect(sql.toUpperCase()).toContain("IF NOT EXISTS");
        }
      }
    }
  });
});
