/**
 * router —— 租户后台域的入口（`{slug}.{CRM_ROOT}` 与 `crm.brand.com`）。
 *
 * 它只做一件事：**Host → KV → 该租户在哪一片 → 把请求原样转给那个 shard 的
 * service binding**。没有业务逻辑，没有 D1，不认识 cookie。
 *
 * 为什么需要它：`*.{CRM_ROOT}/*` 只能指向**一个** worker，而我们有多个 shard。
 * service binding 是部署期静态的，所以片数变化时要重新部署本 worker
 * （`deploy-saas-router.yml`，清单由 cf-api 的 `/platform/shards` 给）。
 *
 * 契约：`clever-vpn-docs/docs/contracts/cf-api-hosting.md` §2、§1.1、§4.4
 *   - 未知 host ⇒ 404（**绝不回落默认租户**）
 *   - `status=suspended` ⇒ 410（域名解析得到、只是停了）
 *   - 片绑定缺失 ⇒ 503（部署事故，不是租户问题）
 */

export interface HostMap {
  tenant_id: string;
  slot: number;
  status?: "active" | "suspended";
  /** 该位号对应的 D1 uuid（shard 用它做运行期自检；router 不读） */
  d1_uuid?: string;
}

export interface RouterEnv {
  /** `host:*` → HostMap（自定义域）与 `slug:*`（平台子域的缓存） */
  HOSTS: KVNamespace;
  /**
   * 每片容量（部署期 var，由 `deploy-saas-router` / `rebalance-shards` 从 cf-api 的
   * `summary.capacity` 渲染进来）。`shard = floor(slot / capacity)`。
   *
   * 为什么是 var 而不是运行时读 KV：改容量时必须与各 shard 的绑定集**同一次渲染**，
   * 否则 router 和 shard 会各用一套容量，路由到没绑定的片。
   */
  CAPACITY?: string;
  /** 租户后台域的父域：`{slug}.<ADMIN_ZONE>` 按 slug 查 registry */
  ADMIN_ZONE?: string;
  /** registry D1（`tenants` 表）。自托管单租户部署不绑。 */
  REGISTRY?: D1Database;
  /** 该 router 部署的版本（tag，见 skill release-crm） */
  PLATFORM_VERSION?: string;
  /** `SHARD_<n>` → 该片 worker 的 service binding */
  [binding: string]: unknown;
}

/** 路由判定结果：要么转发到一个 binding，要么直接返回一个错误响应 */
export type RouteDecision =
  | { kind: "forward"; binding: string; map: HostMap }
  | { kind: "not_found" }
  | { kind: "gone" }
  | { kind: "no_binding"; binding: string; map: HostMap };

/**
 * 纯函数：主机名映射 + "这个片有没有绑定" → 该怎么做。
 * 单独抽出来是为了能单测（不用起 miniflare）。
 */
export const DEFAULT_CAPACITY = 1000;

/** 容量字符串 → 正整数（非法/缺省都退到默认值，router 不做业务校验） */
export function capacityOf(raw: string | undefined): number {
  const n = Number.parseInt(String(raw ?? "").trim(), 10);
  return Number.isFinite(n) && n >= 1 ? n : DEFAULT_CAPACITY;
}

export function decide(
  map: HostMap | null,
  hasBinding: (binding: string) => boolean,
  capacity: number = DEFAULT_CAPACITY,
): RouteDecision {
  if (!map) return { kind: "not_found" };
  if (map.status === "suspended") return { kind: "gone" };
  const binding = `SHARD_${Math.floor(map.slot / capacity)}`;
  if (!hasBinding(binding)) return { kind: "no_binding", binding, map };
  return { kind: "forward", binding, map };
}

/** isolate 内缓存 60 s —— 与 CRM 的 scope.ts 同口径（KV 读按百万次计费） */
const TTL_MS = 60_000;
const memo = new Map<string, { value: HostMap | null; at: number }>();

/** slug 的合法形状（与 cf-api / site-serve 同一口径） */
const SLUG_RE = /^[a-z0-9](?:[a-z0-9-]{0,38}[a-z0-9])?$/;

/** 平台子域 → slug；只认一级 `<slug>.<ADMIN_ZONE>` */
export function platformSlug(host: string, zone: string | undefined): string | null {
  const z = String(zone ?? "").trim().toLowerCase();
  if (!z || !host.endsWith(`.${z}`)) return null;
  const label = host.slice(0, host.length - z.length - 1);
  if (!label || label.includes(".")) return null;
  return SLUG_RE.test(label) ? label : null;
}

/**
 * Host → 该租户在哪一片。顺序（契约 `cf-api-hosting` §2）：
 *   1. `host:<host>` —— 租户自定义域；
 *   2. `<slug>.<ADMIN_ZONE>` —— 平台子域，按 slug 查 registry（内存 → KV → D1）。
 *
 * 平台子域不进 `host:`，所以"绑了自定义域"不会让二级域失效。
 */
async function hostMapOf(env: RouterEnv, host: string): Promise<HostMap | null> {
  const hit = memo.get(host);
  const now = Date.now();
  if (hit && now - hit.at < TTL_MS) return hit.value;

  // 平台子域优先（推导值），自定义域才看 `host:`：旧开通可能还留着平台子域的行
  let value: HostMap | null = null;
  const slug = platformSlug(host, env.ADMIN_ZONE);
  if (slug && env.REGISTRY) value = await platformHostOf(env, slug);
  if (!value) {
    try {
      value = (await env.HOSTS.get(`host:${host}`, "json")) as HostMap | null;
    } catch {
      value = null; // KV 抖动当作"未知 host"，宁可 404 也不要乱转发
    }
  }

  memo.set(host, { value, at: now });
  return value;
}

/** 平台子域：内存 → KV `slug:`（cf-api 写）→ registry D1 */
async function platformHostOf(env: RouterEnv, slug: string): Promise<HostMap | null> {
  const key = `slug:${slug}`;
  const cache = memo.get(key);
  const now = Date.now();
  if (cache && now - cache.at < TTL_MS) return cache.value;

  const toMap = (row: Record<string, unknown> | null): HostMap | null => {
    if (!row) return null;
    const id = row.tenant_id ?? row.id;
    const slot = Number(row.slot);
    if (id === undefined || id === null || !Number.isFinite(slot)) return null;
    const status = String(row.status ?? "active");
    if (status !== "active" && status !== "suspended") return null;
    return {
      tenant_id: String(id),
      slot,
      status,
      ...(typeof row.d1_uuid === "string" ? { d1_uuid: row.d1_uuid } : {}),
    };
  };

  let map: HostMap | null = null;
  try {
    map = toMap((await env.HOSTS.get(key, "json")) as Record<string, unknown> | null);
  } catch {
    map = null;
  }

  if (!map) {
    try {
      const row = await env.REGISTRY!.prepare(
        "SELECT id, slot, shard, status FROM tenants WHERE slug = ? LIMIT 1",
      )
        .bind(slug)
        .first<Record<string, unknown>>();
      map = toMap(row ?? null);
    } catch {
      map = null;
    }
  }

  memo.set(key, { value: map, at: now });
  return map;
}

const text = (body: string, status: number): Response =>
  new Response(body, { status, headers: { "Content-Type": "text/plain; charset=utf-8" } });

export default {
  async fetch(request: Request, env: RouterEnv): Promise<Response> {
    const url = new URL(request.url);
    const host = url.hostname.toLowerCase();

    // 自己的版本（发布后核验"tag == 线上"用，不需要 KV）。
    // 路径必须带 `__router/` 前缀：`/__version` 属于**租户的 shard**，router 不能截胡。
    if (url.pathname === "/__router/version") {
      return new Response(
        JSON.stringify({ service: "clever-vpn-crm-router", version: env.PLATFORM_VERSION ?? "dev" }),
        { headers: { "Content-Type": "application/json" } },
      );
    }

    // 自己的健康检查（部署后核验用，不需要 KV）
    if (url.pathname === "/__router/health") {
      return new Response(JSON.stringify({ ok: true }), {
        headers: { "Content-Type": "application/json" },
      });
    }

    const map = await hostMapOf(env, host);
    const decision = decide(
      map,
      (b) => typeof env[b] === "object" && env[b] !== null,
      capacityOf(env.CAPACITY),
    );

    switch (decision.kind) {
      case "not_found":
        // 不回落任何默认租户：解析不到就是 404
        return text("未知域名", 404);
      case "gone":
        return text("站点已暂停", 410);
      case "no_binding":
        // 部署事故：registry 里有这个片，但本 router 还没绑它
        // （加片后忘了跑 deploy-saas-router.yml 就是这个症状）
        return text(
          `该租户所在分片未接入（${decision.binding}）：请重新部署 router`,
          503,
        );
      case "forward": {
        const shard = env[decision.binding] as { fetch: (r: Request) => Promise<Response> };
        // service binding 会把原始请求（含 Host）转过去，CRM 侧再按 Host 解析一次
        return shard.fetch(request);
      }
    }
  },
};
