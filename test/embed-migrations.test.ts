/**
 * 内嵌迁移 bundle 的**一致性**（`src/db/migrations.generated.ts`）
 *
 * 为什么单测也要管这件事：`db:embed:check` 只挂在 CI 的 validate / shard 部署上，
 * 而 `npm test` 是**每条**发布路径都会跑的（release、自部署 deploy）。生成文件落后
 * 一次就意味着线上跑的是"旧 DDL + 新代码"，而且编译期完全看不出来。
 *
 * 这里直接对着 `migrations/` 目录重算一遍，比对三样：文件名集合、每条语句、
 * 内容指纹。任何一项对不上 ⇒ 忘了跑 `npm run db:embed`。
 */
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { buildBundle, splitStatements } from "../scripts/pack-migrations.mjs";
import { EXPECTED_NAMES, MIGRATION_BUNDLE } from "../src/db/migrations.generated";

const DIR = join(process.cwd(), "migrations");
const files = readdirSync(DIR)
  .filter((name) => name.endsWith(".sql"))
  .sort()
  .map((name) => ({ name, sql: readFileSync(join(DIR, name), "utf8") }));

describe("内嵌迁移 bundle", () => {
  it("文件名与 migrations/ 一一对应（期望值就是集合本身）", () => {
    expect(MIGRATION_BUNDLE.files.map((file) => file.name)).toEqual(files.map((file) => file.name));
    expect([...EXPECTED_NAMES].sort()).toEqual(files.map((file) => file.name));
  });

  it("每个文件的语句与拆分结果一致（归一化 + 断点切分都走同一套函数）", () => {
    for (const [index, file] of files.entries()) {
      const embedded = MIGRATION_BUNDLE.files[index]!;
      const normalized = buildBundle([file]).files[0]!;
      expect(embedded.name).toBe(file.name);
      expect(embedded.sha256).toBe(normalized.sha256);
      expect(embedded.statements).toEqual(splitStatements(normalized.sql));
    }
  });

  it("内容指纹与重新打包的结果一致（改了 SQL 却忘了重新生成，这里会红）", () => {
    expect(MIGRATION_BUNDLE.schemaVersion).toBe(buildBundle(files).schema_version);
  });

  it("不含生成时刻这种每次都变的东西（否则 --check 永远漂移）", () => {
    const text = readFileSync(join(process.cwd(), "src/db/migrations.generated.ts"), "utf8");
    expect(text).not.toContain("generated_at");
    expect(text).not.toContain('"tag"');
  });
});
