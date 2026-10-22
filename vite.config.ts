import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

/**
 * 管理后台 SPA（源码在 `web/`）。产物写到 `web/dist/admin`，由 Worker 的 assets
 * 直接服务；深链接（/admin/xxx）在 Worker 里回落到 /admin/index.html。
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
    port: 5273,
    proxy: { "/api": "http://127.0.0.1:8788" },
  },
});
