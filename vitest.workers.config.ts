/**
 * 集成测试配置 —— 在 **workerd（Miniflare）** 里跑，而不是 Node。
 *
 * 与 `vitest.config.ts`（纯函数单测，Node 环境）分开是**必须**的：
 * Workers 集成不允许自定义 `environment` / `runner`，所以两套只能各用一份 config。
 *
 * 为什么需要它：`/api/admin/*` 这些链路的正确性藏在路由、CSRF、cookie、D1 里，
 * Node 里的假 D1 测不出来（SQL 方言、索引、`ALTER TABLE` 行为都跟线上一致才行）。
 *
 * 注意：插件会自动注入 `nodejs_compat` 等 flag，所以测试里 `import fs` 也能跑通，
 * 但**线上会挂**。集成测试要刻意避免 Node API，才能保持"测得过 = 部署得上"。
 */
import { cloudflareTest, readD1Migrations } from "@cloudflare/vitest-plugin";
import { defineConfig } from "vitest/config";

export default defineConfig({
  plugins: [
    cloudflareTest(async () => ({
      // 和 wrangler 用同一份配置：main / compatibility / bindings 全部一致
      wrangler: { configPath: "./wrangler.jsonc" },
      miniflare: {
        bindings: {
          // ⚠️ 读的是**生产链** `migrations/`（不是 `migrations-dev/`）：
          // 这样测试建表用的就是 CI 真正会 apply 的那套 DDL。
          // `readD1Migrations` 用 fs，只能在 Node 侧执行 —— 所以在这里读、以绑定形式送进 workerd。
          // 路径相对仓库根（vitest 的工作目录），不 import `node:path`：
          // tsconfig 的 types 里只有 workers-types，没有 Node 类型。
          TEST_MIGRATIONS: await readD1Migrations("migrations"),
        },
      },
    })),
  ],
  test: {
    include: ["test/workers/**/*.test.ts"],
    setupFiles: ["./test/workers/apply-migrations.ts"],
  },
});
