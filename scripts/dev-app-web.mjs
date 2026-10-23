/**
 * 本地模拟 App 的静态服务器（**仅开发用，不进产物、不部署**）
 *
 * 为什么不用 vite：app-web 就是一张页面，用 Node 内置 http 起一个静态服务最省事，
 * 也不会污染 `npm run build:web` 的产物（assets 里不该出现模拟器）。
 *
 *   node scripts/dev-app-web.mjs            # http://127.0.0.1:5180
 *   PORT=5190 node scripts/dev-app-web.mjs
 */

import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { extname, join, normalize, resolve } from "node:path";

const ROOT = resolve(import.meta.dirname, "../app-web");
const PORT = Number(process.env.PORT ?? 5180);
// 明确绑 IPv4：Caddy 里写 127.0.0.1:5180（Node 对 localhost 可能只绑 IPv6）
const HOST = process.env.HOST ?? "127.0.0.1";

const TYPES = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
};

const server = createServer(async (req, res) => {
  const url = new URL(req.url ?? "/", `http://${req.headers.host}`);
  // 防目录穿越：normalize 后必须仍在 ROOT 内
  let path = normalize(decodeURIComponent(url.pathname));
  if (path === "/" || path === "") path = "/index.html";
  const file = join(ROOT, path);
  if (!file.startsWith(ROOT)) {
    res.writeHead(403).end("forbidden");
    return;
  }

  try {
    const body = await readFile(file);
    res.writeHead(200, {
      "Content-Type": TYPES[extname(file)] ?? "application/octet-stream",
      // 本地开发不要缓存，免得改了页面看不到
      "Cache-Control": "no-store",
    });
    res.end(body);
  } catch {
    // SPA 回落
    try {
      const body = await readFile(join(ROOT, "index.html"));
      res.writeHead(200, { "Content-Type": TYPES[".html"], "Cache-Control": "no-store" });
      res.end(body);
    } catch {
      res.writeHead(404).end("not found");
    }
  }
});

server.listen(PORT, HOST, () => {
  console.log(`app-web (本地模拟 App) → http://${HOST}:${PORT}`);
  console.log(`通过 Caddy 访问：https://app-web.clever-vpn.org/`);
});
