import { defineConfig } from "vitest/config";

/**
 * 纯函数单测（Node 环境）：报价、校验、加解密、邮件模板。
 *
 * 需要真 D1 / 真路由的用例在 `vitest.workers.config.ts`（workerd + Miniflare），
 * 两边必须分开：Workers 集成不允许自定义 environment/runner。
 */
export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    exclude: ["test/workers/**"],
    environment: "node",
  },
});
