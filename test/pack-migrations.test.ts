import { describe, it, expect } from "vitest";
import { buildBundle, normalizeSql, splitStatements } from "../scripts/pack-migrations.mjs";

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
    expect(b.files[0]!.sha256).toMatch(/^[0-9a-f]{64}$/);
  });

  it("每个文件带 sql 原文（执行单位），且不再带 statements 数组", () => {
    const sql = "CREATE TABLE a (x);--> statement-breakpoint\nCREATE INDEX i ON a (x);";
    const b = buildBundle([{ name: "0000_a.sql", sql }], { tag: "v1" });
    const f = b.files[0]!;
    expect(f.sql).toBe(sql); // 原样保留，消费方一次 /query 提交整文件
    expect(f.statement_count).toBe(2);
    expect(f).not.toHaveProperty("statements");
  });

  it("sha256 对的是归一化后的 sql（即真正被执行的文本）", () => {
    const withTx = "BEGIN TRANSACTION;\nCREATE TABLE t (x);\nCOMMIT;\n";
    const a = buildBundle([{ name: "0000_a.sql", sql: withTx }], { tag: "v1" });
    const b = buildBundle([{ name: "0000_a.sql", sql: "CREATE TABLE t (x);\n" }], { tag: "v1" });
    expect(a.files[0]!.sql).toBe("CREATE TABLE t (x);\n");
    expect(a.files[0]!.sha256).toBe(b.files[0]!.sha256);
    expect(a.schema_version).toBe(b.schema_version);
  });

  it("剥掉 BEGIN/COMMIT（D1 自己会套事务）", () => {
    expect(normalizeSql("BEGIN TRANSACTION;\nSELECT 1;\nCOMMIT;\n")).toBe("SELECT 1;\n");
    expect(normalizeSql("  begin transaction ;\nSELECT 1;\n  commit ;\n")).toBe("SELECT 1;\n");
  });

  it("多段事务让打包直接失败（不留到开通时才炸）", () => {
    const multi = "BEGIN TRANSACTION;\nSELECT 1;\nCOMMIT;\nBEGIN TRANSACTION;\nSELECT 2;\nCOMMIT;\n";
    expect(() => buildBundle([{ name: "0000_a.sql", sql: multi }], { tag: "v1" })).toThrow(/多段事务/);
  });

  it("不动 CASE ... END 这种行内关键字", () => {
    const sql = "CREATE TABLE t (x TEXT CHECK (CASE WHEN x = 'a' THEN 1\n  END));\n";
    expect(normalizeSql(sql)).toBe(sql);
  });
});
