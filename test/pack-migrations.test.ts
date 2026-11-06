import { describe, it, expect } from "vitest";
import { buildBundle, splitStatements } from "../scripts/pack-migrations.mjs";

describe("迁移打包（release asset）", () => {
  it("按 statement-breakpoint 拆，不吃字符串里的分号", () => {
    const sql = "CREATE TABLE a (x text DEFAULT 'a;b');--> statement-breakpoint\nCREATE INDEX i ON a (x);";
    const out = splitStatements(sql);
    expect(out).toHaveLength(2);
    expect(out[0]).toContain("'a;b'"); // 分号还在语句里，没被切开
  });

  it("丢了空块（结尾多余的 breakpoint）", () => {
    expect(splitStatements("SELECT 1;--> statement-breakpoint\n\n")).toHaveLength(1);
  });

  it("schema_version 是内容哈希：内容一样就一样，改一个字就变", () => {
    const a = buildBundle([{ name: "0000.sql", sql: "CREATE TABLE t (x);" }], { tag: "v1" });
    const b = buildBundle([{ name: "0000.sql", sql: "CREATE TABLE t (x);" }], { tag: "v2" });
    const c = buildBundle([{ name: "0000.sql", sql: "CREATE TABLE t (y);" }], { tag: "v1" });
    expect(a.schema_version).toBe(b.schema_version); // tag 不影响
    expect(a.schema_version).not.toBe(c.schema_version);
    expect(a.schema_version).toMatch(/^sha256:[0-9a-f]{16}$/);
  });

  it("文件按名字排序 + 语句计数", () => {
    const b = buildBundle(
      [
        { name: "0001_b.sql", sql: "SELECT 1;--> statement-breakpoint" },
        { name: "0000_a.sql", sql: "SELECT 0;" },
      ],
      { tag: "v1" },
    );
    expect(b.files.map((f) => f.name)).toEqual(["0000_a.sql", "0001_b.sql"]);
    expect(b.statement_count).toBe(2);
    expect(b.files[0].sha256).toMatch(/^[0-9a-f]{64}$/);
  });
});
