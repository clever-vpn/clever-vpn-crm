/**
 * 多租户取库：**唯一**一条链路 —— `host → KV → slot → env['DB_' + slot]`。
 *
 * 两个模式共用同一份实现（ADR 0004、contracts/site-hosting.md §2.2）：
 *   single（默认，自部署）：直接用 `env.DB`，行为与之前完全一致；
 *   multi（SaaS 分片）    ：KV 里查 host 对应的 slot，再从绑定里取库。
 *
 * 为什么不在业务代码里判别模式：一旦出现第二处 `if (multi)`，两套行为必然漂移。
 * 业务层只拿 `env.DB`，不知道它是怎么来的。
 */

export type Mode = "single" | "multi";

/** KV 里 `host:*` 的值（契约 §2.1） */
export interface HostMap {
  tenant_id: string;
  slot: number;
  shard?: number;
  status?: "active" | "suspended";
}

/** 多租户绑定：由 shard 的 wrangler 配置程序化生成（`DB_0`…`DB_1999`） */
type MultiEnv = { HOSTS?: KVNamespace } & Record<string, unknown>;

const HOST_TTL_MS = 60_000;
const memo = new Map<string, { value: HostMap | null; expires: number }>();

export function modeOf(env: { MODE?: string }): Mode {
  return env.MODE === "multi" ? "multi" : "single";
}

/** isolate 内缓存：KV 里的值几乎不变，60 s 足够（契约 §3） */
async function hostMapOf(kv: KVNamespace, host: string): Promise<HostMap | null> {
  const key = `host:${host}`;
  const hit = memo.get(key);
  const now = Date.now();
  if (hit && hit.expires > now) return hit.value;
  let value: HostMap | null = null;
  try {
    value = (await kv.get(key, "json")) as HostMap | null;
  } catch {
    value = null;
  }
  memo.set(key, { value, expires: now + HOST_TTL_MS });
  return value;
}

export interface Scoped {
  env: { DB: D1Database } & Record<string, unknown>;
  tenantId: string;
  slot: number;
}

export class TenantResolveError extends Error {
  constructor(
    readonly code: "unknown_host" | "not_configured" | "missing_db" | "suspended",
    message: string,
  ) {
    super(message);
  }
}

/**
 * 把请求绑定到某个租户的库。
 *
 * single：`env.DB` 原样传出（**零行为变化**）。
 * multi ：`host → KV[host:*] → slot → env['DB_'+slot]`；任何一步缺失都抛
 * `TenantResolveError`，由入口翻译成明确的 5xx/4xx —— **绝不回落到默认租户**
 * （contracts/site-hosting.md §8）。
 */
export async function scopeToTenant(
  request: Request,
  env: MultiEnv & { DB?: D1Database; MODE?: string; CRM_TENANT_ID?: string },
): Promise<Scoped> {
  const mode = modeOf(env);

  if (mode === "single") {
    if (!env.DB) {
      throw new TenantResolveError(
        "not_configured",
        "MODE=single 但没有绑定 DB：请检查 wrangler 的 d1_databases",
      );
    }
    return { env: env as Scoped["env"], tenantId: String(env.CRM_TENANT_ID ?? ""), slot: 0 };
  }

  if (!env.HOSTS) {
    throw new TenantResolveError(
      "not_configured",
      "MODE=multi 但没有绑定 HOSTS(KV)：多租户解析无从进行",
    );
  }

  const host = new URL(request.url).hostname.toLowerCase();
  const map = await hostMapOf(env.HOSTS, host);
  if (!map) {
    throw new TenantResolveError("unknown_host", `未知域名：${host}`);
  }
  if (map.status === "suspended") {
    throw new TenantResolveError("suspended", `租户已暂停：${map.tenant_id}`);
  }

  const db = env[`DB_${map.slot}`] as D1Database | undefined;
  if (!db) {
    // 启动自检的另一半：绑定漏了要立刻炸，而不是让每个请求 500 得莫名其妙
    throw new TenantResolveError(
      "missing_db",
      `绑定缺失：host 解析到 slot=${map.slot}，但没有 env.DB_${map.slot}`,
    );
  }

  // 不用 `{...env}`：一个 shard 的绑定可能有上千条（DB_0…DB_N + secret + KV），
  // 每个请求复制一遍是纯浪费。用原型链把 DB 盖在上面，其余绑定原样穿透。
  const scoped = Object.create(env) as Scoped["env"];
  scoped.DB = db;

  return { env: scoped, tenantId: map.tenant_id, slot: map.slot };
}

/**
 * 启动自检（每个 isolate 只跑一次，见 `ensureConfig`）。
 *
 * 多租户最容易踩的坑不是逻辑错，而是**绑定漏了**：KV 指向一个 slot，wrangler 里却
 * 少一条 `DB_<slot>`。这种错不会在部署时报，只会在某个租户第一次请求时炸，而且
 * 报得像业务 bug。所以启动就把话说清楚，并让 `/__version` 能查到。
 */
export interface ConfigCheck {
  ok: boolean;
  mode: Mode;
  problems: string[];
  /** multi 下本 shard 实际绑了几个库 */
  dbs: number;
}

export function selfCheck(env: { MODE?: string; DB?: unknown } & Record<string, unknown>): ConfigCheck {
  const mode = modeOf(env);
  const problems: string[] = [];
  const dbs = Object.keys(env).filter((k) => /^DB_\d+$/.test(k)).length;

  if (mode === "single") {
    if (!env.DB) problems.push("MODE=single 但没绑定 DB（d1_databases）");
  } else {
    if (!env.HOSTS) problems.push("MODE=multi 但没绑定 HOSTS（kv_namespaces）");
    if (dbs === 0) problems.push("MODE=multi 但没有任何 DB_<slot> 绑定");
    if (env.DB) problems.push("MODE=multi 却仍绑着 DB：请求不会用到它，容易误判");
  }

  return { ok: problems.length === 0, mode, problems, dbs };
}

let checked = false;

/** 每个 isolate 首次请求时跑一次自检；问题只记日志，不改变请求结果 */
export function ensureConfig(env: Record<string, unknown>): ConfigCheck {
  const result = selfCheck(env);
  if (!checked) {
    checked = true;
    if (!result.ok) {
      console.error(`[tenant] 配置自检失败（mode=${result.mode}）：${result.problems.join("；")}`);
    }
  }
  return result;
}

/** 仅供测试：清掉 isolate 缓存 */
export function __clearScopeCache(): void {
  memo.clear();
}

/** 仅供测试：重置自检的一次性标记 */
export function __resetSelfCheck(): void {
  checked = false;
}
