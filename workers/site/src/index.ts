/**
 * site-serve：客户站点的出口 Worker（契约 `contracts/cf-api-hosting.md`）。
 *
 * 链路只有一条：
 *   Host → KV[host:{host}] → tenant → KV[site:{tenant}:active] → R2 取文件
 *
 * 三条纪律：
 *  1. **零 D1**：最轻的路径不背包袱；要不要"哪个库"是 CRM 的事。
 *  2. **缓存分层**：host 60 s、版本指针 5 s、未知域负缓存 5 s；内存缓存只是优化，
 *     冷启动必然 miss 一次 KV。
 *  3. **一律 must-revalidate + ETag**：我们的资产文件名没有内容哈希，给 immutable
 *     等于"改一次 CSS，老访客一年看不到"（实测踩过）。资产加内容哈希后才谈 immutable。
 *
 * single / multi 两种部署跑的是**同一份代码**：它只读 KV，不区分模式。
 */

import { RETURN_HTML, SDK_JS } from "./sdk";

export interface SiteEnv {
  HOSTS: KVNamespace;
  SITES: R2Bucket;
  /** 租户后台域名的父域：`{tenant}.<ADMIN_ZONE>` */
  ADMIN_ZONE?: string;
  PLATFORM_VERSION?: string;
}

interface HostMap {
  tenant_id: string;
  status?: "active" | "suspended";
  admin_host?: string;
}

const HOST_TTL = 60_000;
const ACTIVE_TTL = 5_000;
const NEGATIVE_TTL = 5_000;

const memo = new Map<string, { value: unknown; expires: number }>();

async function remembered<T>(key: string, ttl: number, load: () => Promise<T>): Promise<T> {
  const now = Date.now();
  const hit = memo.get(key);
  if (hit && hit.expires > now) return hit.value as T;
  const value = await load();
  memo.set(key, { value, expires: now + ttl });
  return value;
}

const MIME: Record<string, string> = {
  html: "text/html; charset=utf-8",
  css: "text/css; charset=utf-8",
  js: "text/javascript; charset=utf-8",
  json: "application/json; charset=utf-8",
  svg: "image/svg+xml",
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  webp: "image/webp",
  ico: "image/x-icon",
  txt: "text/plain; charset=utf-8",
  xml: "application/xml; charset=utf-8",
  woff2: "font/woff2",
};

function mimeOf(path: string): string {
  const dot = path.lastIndexOf(".");
  const ext = dot === -1 ? "" : path.slice(dot + 1).toLowerCase();
  return MIME[ext] ?? "application/octet-stream";
}

/** 路径安全：拒绝越界与协议相对的写法 */
function safePath(raw: string): string | null {
  let p = raw;
  try {
    p = decodeURIComponent(raw);
  } catch {
    return null;
  }
  if (p.includes("..") || p.includes("\\") || p.startsWith("//")) return null;
  if (p === "" || p === "/") return "index.html";
  if (p.endsWith("/")) return p.slice(1) + "index.html";
  return p.slice(1);
}

function resolveHost(env: SiteEnv, host: string): Promise<HostMap | null> {
  const key = `host:${host}`;
  const hit = memo.get(key);
  if (hit && hit.expires > Date.now()) return Promise.resolve(hit.value as HostMap | null);
  return env.HOSTS.get(key, "json")
    .then((value) => {
      const map = value as HostMap | null;
      memo.set(key, { value: map, expires: Date.now() + (map ? HOST_TTL : NEGATIVE_TTL) });
      return map;
    })
    .catch(() => {
      memo.set(key, { value: null, expires: Date.now() + NEGATIVE_TTL });
      return null;
    });
}

function activeVersion(env: SiteEnv, tenant: string): Promise<{ n: number } | null> {
  return remembered<{ n: number } | null>(`active:${tenant}`, ACTIVE_TTL, async () => {
    try {
      return (await env.HOSTS.get(`site:${tenant}:active`, "json")) as { n: number } | null;
    } catch {
      return null;
    }
  });
}

/** 平台文件：不落租户 R2，由这里直接送（发版后 purge 即可更新） */
function platformFile(path: string, map: HostMap, env: SiteEnv): Response | null {
  if (path === "/_crm/config.js") {
    const base = map.admin_host ?? `${map.tenant_id}.${env.ADMIN_ZONE ?? "app.example.com"}`;
    return new Response(`window.CRM_API_BASE = ${JSON.stringify("https://" + base)};\n`, {
      headers: { "content-type": MIME.js!, "cache-control": "public, max-age=300" },
    });
  }
  if (path === "/_crm/sdk.js") {
    return new Response(SDK_JS, {
      headers: { "content-type": MIME.js!, "cache-control": "public, max-age=300" },
    });
  }
  if (path === "/_crm/return") {
    return new Response(RETURN_HTML, {
      headers: { "content-type": MIME.html!, "cache-control": "no-store" },
    });
  }
  // 老页面还在引它：留一版空壳，避免 404（下一版删除）
  if (path === "/_crm/api.js") {
    return new Response(SHIM_JS, {
      headers: { "content-type": MIME.js!, "cache-control": "public, max-age=300" },
    });
  }
  return null;
}

/**
 * 兼容壳：`/_crm/api.js` 只保留"什么都没做"的空实现。
 *
 * 旧版本会 patch `window.fetch` 补 Authorization、并暴露 `window.CRM.token`——
 * 那等于把长期凭证交给页面脚本。现在凭证只存在 `/_crm/sdk.js` 的闭包里。
 */
const SHIM_JS = `(function () {
  if (!window.CRM_API_BASE && window.console) { console.warn("[crm] CRM_API_BASE 未配置"); }
  window.CRM = window.CRM || {};
})();
`;

function notFound(why?: string): Response {
  return new Response(why ?? "not found", {
    status: 404,
    headers: { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" },
  });
}

export default {
  async fetch(request: Request, env: SiteEnv): Promise<Response> {
    const url = new URL(request.url);
    const host = url.hostname.toLowerCase();

    if (url.pathname === "/__site/version") {
      const map = await resolveHost(env, host);
      const active = map ? await activeVersion(env, map.tenant_id) : null;
      return Response.json(
        { host, tenant: map?.tenant_id ?? null, active: active?.n ?? null, platform: env.PLATFORM_VERSION },
        { headers: { "cache-control": "no-store" } },
      );
    }

    const map = await resolveHost(env, host);
    // 未知 host 一律 404，**绝不回落默认租户**（contracts/cf-api-hosting.md §8）
    if (!map) return notFound(`unknown host: ${host}`);
    if (map.status === "suspended") {
      return new Response("站点已暂停", {
        status: 410,
        headers: { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" },
      });
    }

    if (url.pathname.startsWith("/_crm/")) {
      return platformFile(url.pathname, map, env) ?? notFound("no such platform file");
    }

    const active = await activeVersion(env, map.tenant_id);
    if (!active || !active.n) return notFound("站点尚未发布");

    const rel = safePath(url.pathname);
    if (!rel) return new Response("bad path", { status: 400 });

    const key = `sites/${map.tenant_id}/versions/${active.n}/public/${rel}`;

    const headersFor = (meta: R2Object): Headers => {
      const headers = new Headers({
        "content-type": meta.httpMetadata?.contentType ?? mimeOf(rel),
        // 见文件头第 3 条：没有内容哈希之前，一律回源校验
        "cache-control": "public, max-age=0, must-revalidate",
        "cache-tag": `site:${map.tenant_id}`,
        "x-site-version": String(active.n),
      });
      if (meta.httpEtag) headers.set("etag", meta.httpEtag);
      return headers;
    };

    if (request.method === "HEAD") {
      const meta = await env.SITES.head(key);
      if (!meta) return notFound("not found");
      return new Response(null, { headers: headersFor(meta) });
    }

    const obj = await env.SITES.get(key);
    if (!obj) return notFound("not found");
    const headers = headersFor(obj);
    const inm = request.headers.get("if-none-match");
    if (inm && obj.httpEtag && inm === obj.httpEtag) {
      return new Response(null, { status: 304, headers });
    }
    return new Response(obj.body, { headers });
  },
};
