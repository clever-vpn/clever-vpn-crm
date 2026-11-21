import { defineConfig } from "drizzle-kit";

/**
 * drizzle-kit 配置（与 cf-api `packages/platform` 一致）
 *
 * 只负责**生成 SQL**：`npm run db:generate` → `migrations/*.sql`。
 * 应用迁移由 **CI** 在 `wrangler deploy` 之前执行（`wrangler d1 migrations apply`，
 * 见 `docs/schema.md`）；Worker 目前只做只读探测（`src/db.ts`）。
 */
export default defineConfig({
  dialect: "sqlite",
  schema: "./src/db/schema.ts",
  out: "./migrations",
});
