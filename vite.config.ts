import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

/**
 * 管理后台 SPA（源码在 `web/`）。
 *
 * 两种跑法：
 *   ① **开发（默认）**：`npm run dev:web` 起 Vite dev server（HMR），
 *      Caddy 把 `https://crm.clever-vpn.org/admin*` 直接反代到这里 ⇒
 *      改一行代码浏览器就热更新，不用 `build:web` 再重启 wrangler。
 *      `/api/*` 仍走 Worker（Caddy 按路径分流），所以接口、Cookie、CSRF 都是真环境。
 *   ② **产物**：`npm run build:web` → `web/dist/admin`，由 Worker 的 assets 服务
 *      （`http://127.0.0.1:8788/admin/` 能直接看到编译后的版本）。
 *
 * ⚠️ 端口别用 5273 —— 本机老 www 项目占着它（见 Caddyfile），撞了会串台。
 */
export default defineConfig({
  root: "web",
  base: "/admin/",
  plugins: [react()],
  build: {
    outDir: "dist/admin",
    emptyOutDir: true,
  },
  server: {
    port: 5181,
    strictPort: true,
    // 经 Caddy 时 Host 头是真实域名：Vite 的 host 校验要放行，否则回 "Blocked request"
    allowedHosts: ["crm.clever-vpn.org", "localhost", "127.0.0.1"],
    // 绕开 Caddy 直连 http://localhost:5181/admin/ 时也能调接口（同源代理）
    proxy: { "/api": "http://127.0.0.1:8788" },
    // `npm run build:web` 会重写 web/dist；不忽略的话每次构建都会触发整页 reload，
    // 而且 emptyOutDir 删目录会让 watcher 失准（实测 HMR 就此静默失效）。
    watch: { ignored: ["**/dist/**", "**/node_modules/**"] },
  },
});
