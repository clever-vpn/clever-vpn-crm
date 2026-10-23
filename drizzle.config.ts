import { defineConfig } from "drizzle-kit";

/**
 * drizzle-kit 配置（与 cf-api `packages/platform` 一致）
 *
 * 只负责**生成 SQL**：`npm run db:generate` → `migrations/*.sql`。
 * 应用迁移不靠 CLI（托管模式下 Worker 是按字节上传的，跑不了 wrangler），
 * 而是由 Worker 启动时自迁移（见 `src/db.ts`）。
 */
export default defineConfig({
  dialect: "sqlite",
  schema: "./src/db/schema.ts",
  out: "./migrations",
});
