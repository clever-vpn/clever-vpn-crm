/**
 * site-serve：客户站点的出口 Worker（契约 `contracts/cf-api-hosting.md`）。
 *
 * 链路只有一条：
 *   Host → KV[host:{host}] → tenant → KV[site:{tenant}:active] → R2 `art/<sha>/` 取文件
 *
 * 三条纪律：
 *  1. **D1 只在平台子域 miss 时出现**：自定义域走 `host:`（KV）；`{slug}.<SITE_ZONE>`
 *     才按 slug 查 registry，而且先过内存（60 s）与 KV `slug:`（见 `platformHostOf`）。
 *  2. **缓存分层**：host 60 s、版本指针 5 s、未知域负缓存 5 s；内存缓存只是优化，
 *     冷启动必然 miss 一次 KV。
 *  3. **缓存按"文件名有没有指纹"分两档**：没指纹（`index.html`、`site.css`）一律
 *     `must-revalidate` + ETag —— 给 immutable 等于"改一次 CSS，老访客一年看不到"
 *     （实测踩过）；带指纹（`logo.9f2c1a8b.webp`，发布物化按 asset sha 改名）
 *     内容永不变，给一年 immutable。判据见契约 `site-assets.md` §3。
 *
 * single / multi 两种部署跑的是**同一份代码**：它只读 KV，不区分模式。
 */

export interface SiteEnv {
  HOSTS: KVNamespace;
  SITES: R2Bucket;
  /** 租户后台域名的父域：`{slug}.<ADMIN_ZONE>` */
  ADMIN_ZONE?: string;
  /** 平台站点的父域：`{slug}.<SITE_ZONE>` —— 这个后缀的 host 按 slug 查 registry */
  SITE_ZONE?: string;
  /**
   * registry D1（`tenants` 表）。
   *
   * 平台子域**不写 `host:` 映射**：它是"我们自己的域名"，由 `{slug}.<SITE_ZONE>`
   * 推导出来，去 tenants 表查一次即可（缓存见 `platformHostOf`）。自定义域仍然走
   * `host:`（那是租户的事实，必须登记）。
   *
   * 可选：自托管单租户部署不绑 registry，只走 `host:`。
   */
  REGISTRY?: D1Database;
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

/**
 * 文件名里带内容指纹吗？`assets/logo.9f2c1a8b.webp` → true
 *
 * 判据是「倒数第二段是 8 位以上 hex」——发布物化会按 `asset sha256` 的前 8 位改名
 * （契约 `site-assets.md` §3），所以同一份内容永远得到同一个文件名，可以 immutable。
 * 只是"名字里碰巧有 hex"的文件（如 `page.beefcafe.html`）不会被误判成不可变吗？
 * 会 —— 但那种情况下内容确实由发布流程决定，且只有一个版本目录能命中它，代价可接受。
 */
export function isFingerprinted(path: string): boolean {
  const base = path.slice(path.lastIndexOf("/") + 1);
  const parts = base.split(".");
  if (parts.length < 3) return false;
  return /^[0-9a-f]{8,64}$/i.test(parts[parts.length - 2]!);
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

/** slug 的合法形状：与 cf-api `slugProblem()` 同一口径（一级标签、小写、可带连字符） */
const SLUG_RE = /^[a-z0-9](?:[a-z0-9-]{0,38}[a-z0-9])?$/;

/**
 * 平台子域 → slug。只认**一级** `<slug>.<zone>`；`a.b.clever-link.win` 这种不认
 * （避免"多级子域"被当成租户）。
 */
export function platformSlug(host: string, zone: string | undefined): string | null {
  const z = String(zone ?? "").trim().toLowerCase();
  if (!z || !host.endsWith(`.${z}`)) return null;
  const label = host.slice(0, host.length - z.length - 1);
  if (!label || label.includes(".")) return null;
  return SLUG_RE.test(label) ? label : null;
}

/**
 * 解析 Host。**顺序固定**（契约 `cf-api-hosting` §2）：
 *
 *   1. `host:<host>` —— 租户自定义域，登记过就用它；
 *   2. `<slug>.<SITE_ZONE>` —— 平台子域，按 slug 查 registry（先内存、再 KV
 *      `slug:<slug>`、最后 D1）。
 *
 * 平台子域不进 `host:`：它是派生的，不是租户的事实。这样"绑了自定义域"不会让
 * 二级域失效，租户删掉自定义域也不用清理残留。
 */
async function resolveHost(env: SiteEnv, host: string): Promise<HostMap | null> {
  const exact = `host:${host}`;
  const hit = memo.get(exact);
  if (hit && hit.expires > Date.now()) return hit.value as HostMap | null;

  // ① 平台子域**优先**：它是从 slug 推导出来的，`host:` 里若还留着旧开通写的一行
  //    （没有 admin_host，且把 slug 记成了 tenant_id）会把 `/_crm/config.js` 指错后台。
  const slug = platformSlug(host, env.SITE_ZONE);
  if (slug && env.REGISTRY) {
    const map = await platformHostOf(env, slug);
    if (map) {
      memo.set(exact, { value: map, expires: Date.now() + HOST_TTL });
      return map;
    }
  }

  // ② 自定义域：以 `host:` 为准
  try {
    const value = (await env.HOSTS.get(exact, "json")) as HostMap | null;
    memo.set(exact, { value, expires: Date.now() + (value ? HOST_TTL : NEGATIVE_TTL) });
    return value;
  } catch {
    memo.set(exact, { value: null, expires: Date.now() + NEGATIVE_TTL });
    return null;
  }
}

/** 平台子域的 tenant 查询：内存 60 s → KV `slug:`（由 cf-api 写）→ D1 */
async function platformHostOf(env: SiteEnv, slug: string): Promise<HostMap | null> {
  const key = `slug:${slug}`;
  const hit = memo.get(key);
  if (hit && hit.expires > Date.now()) return hit.value as HostMap | null;

  const admin = env.ADMIN_ZONE ? `${slug}.${env.ADMIN_ZONE}` : undefined;
  const toMap = (row: { tenant_id?: unknown; id?: unknown; status?: unknown } | null): HostMap | null => {
    if (!row) return null;
    const id = row.tenant_id ?? row.id;
    if (id === undefined || id === null) return null;
    const status = String(row.status ?? "active");
    if (status !== "active" && status !== "suspended") return null;
    return { tenant_id: String(id), status, ...(admin ? { admin_host: admin } : {}) };
  };

  try {
    const cached = await env.HOSTS.get(key, "json");
    const map = toMap(cached as never);
    if (map) {
      memo.set(key, { value: map, expires: Date.now() + HOST_TTL });
      return map;
    }
  } catch {
    // KV 抖动：继续问 D1
  }

  let map: HostMap | null = null;
  try {
    const row = await env.REGISTRY!.prepare(
      "SELECT id, status FROM tenants WHERE slug = ? LIMIT 1",
    )
      .bind(slug)
      .first<{ id: number; status: string }>();
    map = toMap(row as never);
  } catch {
    map = null; // D1 抖动：当作未知 host（宁可 404，也不乱发别人的站）
  }
  memo.set(key, { value: map, expires: Date.now() + (map ? HOST_TTL : NEGATIVE_TTL) });
  return map;
}

/**
 * 线上指针：**哪一版设计 + 哪份产物**。
 *
 * `templateSeq` 只用于展示/排障（`x-site-version`）；真正取文件用的是 `artifactSha`
 * —— 产物按内容寻址（`art/<sha>/`），所以"设置改了重新烘焙"不会覆盖任何已有字节。
 */
interface Pointer {
  templateSeq: number | null;
  artifactSha: string;
  bakedAt?: string;
  settingsRev?: number;
}

function activePointer(env: SiteEnv, tenant: string): Promise<Pointer | null> {
  return remembered<Pointer | null>(`active:${tenant}`, ACTIVE_TTL, async () => {
    try {
      const raw = (await env.HOSTS.get(`site:${tenant}:active`, "json")) as Partial<Pointer> | null;
      if (!raw || typeof raw.artifactSha !== "string" || !raw.artifactSha) return null;
      return {
        templateSeq: typeof raw.templateSeq === "number" ? raw.templateSeq : null,
        artifactSha: raw.artifactSha,
      };
    } catch {
      return null;
    }
  });
}

/** `art/<sha-hex>/` —— 与 CRM `src/site/bake.ts` 严格一致 */
export function artPrefix(sha: string): string {
  return `art/${sha.replace(/^sha256:/, "")}/`;
}

/** 平台文件：不落租户 R2，由这里直接送（发版后 purge 即可更新） */
function platformFile(path: string, map: HostMap, env: SiteEnv): Response | null {
  if (path === "/_crm/config.js") {
    const base = map.admin_host ?? `${map.tenant_id}.${env.ADMIN_ZONE ?? "app.example.com"}`;
    return new Response(`window.CRM_API_BASE = ${JSON.stringify("https://" + base)};\n`, {
      headers: { "content-type": MIME.js!, "cache-control": "public, max-age=300" },
    });
  }
  // `/_crm/sdk.js` 与 `/_crm/return.html` 不在这里：它们是**发布产物**的一部分
  // （`src/site/publish.ts` 每次发布写进 R2）。站点出口有两份实现（自部署这份、
  // 托管 `site-serve`），SDK 抄两遍必然漂移。
  //
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
 * 那等于把长期凭证交给页面脚本。现在凭证只存在 `/_crm/sdk.js` 的闭包里
 * （产物里那份，见 `src/site/sdk.ts`）。
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
      const pointer = map ? await activePointer(env, map.tenant_id) : null;
      return Response.json(
        {
          host,
          tenant: map?.tenant_id ?? null,
          active: pointer?.templateSeq ?? null,
          artifact: pointer?.artifactSha ?? null,
          platform: env.PLATFORM_VERSION,
        },
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

    // `/_crm/config.js` 是**算出来的**（跟着域名走），由代码送；
    // `/_crm/sdk.js` 与 `/_crm/return.html` 是**发布产物**，落到下面的 R2 读。
    if (url.pathname.startsWith("/_crm/")) {
      const res = platformFile(url.pathname, map, env);
      if (res) return res;
      // 其余 `/_crm/*` 当成普通产物继续往下走（不再 404）
    }

    const active = await activePointer(env, map.tenant_id);
    if (!active) return notFound("站点尚未发布");

    const rel = safePath(url.pathname);
    if (!rel) return new Response("bad path", { status: 400 });

    const key = `${artPrefix(active.artifactSha)}${rel}`;

    const headersFor = (meta: R2Object): Headers => {
      const headers = new Headers({
        "content-type": meta.httpMetadata?.contentType ?? mimeOf(rel),
        // 见文件头第 3 条：**没有内容哈希**的文件一律回源校验
        // 带指纹（`logo.9f2c1a8b.webp`）的文件内容永远不会变，可以放心 immutable。
        // 契约 `site-assets.md` §3。
        "cache-control": isFingerprinted(rel)
          ? "public, max-age=31536000, immutable"
          : "public, max-age=0, must-revalidate",
        "cache-tag": `site:${map.tenant_id}`,
        "x-site-version": String(active.templateSeq ?? ""),
        "x-site-artifact": active.artifactSha,
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
