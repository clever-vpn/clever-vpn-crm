import { defineConfig } from "vitest/config";

/** 单测只跑 Worker 侧逻辑（Node 环境）；不要继承 vite.config.ts 的 `root: "web"`。 */
export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    environment: "node",
  },
});
