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
 * 契约：`clever-vpn-docs/docs/contracts/site-hosting.md` §2、§1.1、§4.4
 *   - 未知 host ⇒ 404（**绝不回落默认租户**）
 *   - `status=suspended` ⇒ 410（域名解析得到、只是停了）
 *   - 片绑定缺失 ⇒ 503（部署事故，不是租户问题）
 */

export interface HostMap {
  tenant_id: string;
  slot: number;
  shard: number;
  status?: "active" | "suspended";
}

export interface RouterEnv {
  /** `host:*` → HostMap（与 site-serve 共用同一个命名空间） */
  HOSTS: KVNamespace;
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
export function decide(map: HostMap | null, hasBinding: (binding: string) => boolean): RouteDecision {
  if (!map) return { kind: "not_found" };
  if (map.status === "suspended") return { kind: "gone" };
  const binding = `SHARD_${map.shard}`;
  if (!hasBinding(binding)) return { kind: "no_binding", binding, map };
  return { kind: "forward", binding, map };
}

/** isolate 内缓存 60 s —— 与 CRM 的 scope.ts 同口径（KV 读按百万次计费） */
const TTL_MS = 60_000;
const memo = new Map<string, { value: HostMap | null; at: number }>();

async function hostMapOf(env: RouterEnv, host: string): Promise<HostMap | null> {
  const hit = memo.get(host);
  const now = Date.now();
  if (hit && now - hit.at < TTL_MS) return hit.value;

  let value: HostMap | null = null;
  try {
    value = (await env.HOSTS.get(`host:${host}`, "json")) as HostMap | null;
  } catch {
    value = null; // KV 抖动当作"未知 host"，宁可 404 也不要乱转发
  }
  memo.set(host, { value, at: now });
  return value;
}

const text = (body: string, status: number): Response =>
  new Response(body, { status, headers: { "Content-Type": "text/plain; charset=utf-8" } });

export default {
  async fetch(request: Request, env: RouterEnv): Promise<Response> {
    const url = new URL(request.url);
    const host = url.hostname.toLowerCase();

    // 自己的健康检查（部署后核验用，不需要 KV）
    if (url.pathname === "/__router/health") {
      return new Response(JSON.stringify({ ok: true }), {
        headers: { "Content-Type": "application/json" },
      });
    }

    const map = await hostMapOf(env, host);
    const decision = decide(map, (b) => typeof env[b] === "object" && env[b] !== null);

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
