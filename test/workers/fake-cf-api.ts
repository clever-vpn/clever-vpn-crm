/**
 * 测试用的假 cf-api —— 只实现 CRM 真正会调的那几个端点（`crm-api.md` §3）。
 *
 * 为什么必须假：**落账失败时订单就该停在 `provisioning`**（这是契约行为，
 * 不是 bug）。测试要么给一个平台，要么就只能断言"没通平台"。
 */

export interface FakeCustomer {
  id: number;
  code: string;
  name: string;
  email: string | null;
  auth_id: string;
  licence_limit: number;
  frozen: number;
  expire_date: string | null;
  traffic_balance: number | null;
  quota: number | null;
  /** 线路权益：`null` = 全部线路；数组 = 白名单（与 cf-api `customers.line_ids` 同形） */
  line_ids?: number[] | null;
  _is_deleted: number;
}

/** 假平台线路目录（`GET /api/v1/lines` 的返回；CRM 只读） */
export const FAKE_LINES = [
  { id: 1, label: "HK", icon_kind: "service", icon: "general", is_default: 1, traffic_factor: 1, servers_count: 2, relays_count: 1, licences_count: 0 },
  { id: 2, label: "JP", icon_kind: "service", icon: "general", is_default: 0, traffic_factor: 1.5, servers_count: 1, relays_count: 0, licences_count: 0 },
];

export interface FakeCfApi {
  base: string;
  token: string;
  customers: Map<number, FakeCustomer>;
  /** 记录每次落账写的控制参数，便于断言"字节而不是 GB" */
  patches: { id: number; body: Record<string, unknown> }[];
  /**
   * 测试钩子：让接下来的 N 次请求直接返回 `status`（模拟平台 5xx / 429）。
   * 用来钉住"平台暂时不可用"与"客户被删"必须区分对待。
   */
  failures: { remaining: number; status: number };
  restore: () => void;
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

/** 装上假的 cf-api，返回句柄；`restore()` 还原全局 fetch */
export function installFakeCfApi(
  base = "https://api.cf.test",
  opts: { lines?: unknown[] } = {},
): FakeCfApi {
  const customers = new Map<number, FakeCustomer>();
  const patches: { id: number; body: Record<string, unknown> }[] = [];
  const failures = { remaining: 0, status: 500 };
  let idSeq = 4200;
  let codeSeq = 7391048261558200;

  const realFetch = globalThis.fetch;

  const fake = (async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
    if (!url.href.startsWith(base)) return realFetch(input as RequestInfo, init);

    // 注入的故障（"平台暂时不可用"）——必须在任何业务分支之前生效
    if (failures.remaining > 0) {
      failures.remaining -= 1;
      return json({ error: "internal error" }, failures.status);
    }

    const method = (init?.method ?? "GET").toUpperCase();
    const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : {};

    // 线路目录（只读）
    if (url.pathname === "/api/v1/lines" && method === "GET") {
      return json(opts.lines ?? FAKE_LINES);
    }

    const match = url.pathname.match(/^\/api\/v1\/customers(?:\/(\d+))?$/);
    if (!match) return json({ error: "not found" }, 404);

    const id = match[1] ? Number(match[1]) : null;

    // ── 按 auth_id 查重（CRM 的幂等键）──
    if (method === "GET" && id === null) {
      const authId = url.searchParams.get("filters[auth_id][$eq]");
      const items = [...customers.values()].filter(
        (c) => c._is_deleted === 0 && (authId === null || c.auth_id === authId),
      );
      return json({ items, total: items.length });
    }

    if (method === "POST") {
      const authId = String(body.auth_id ?? "");
      if (authId && [...customers.values()].some((c) => c._is_deleted === 0 && c.auth_id === authId)) {
        return json({ error: `auth_id_conflict: ${authId}` }, 409);
      }
      idSeq += 1;
      codeSeq += 1;
      const created: FakeCustomer = {
        id: idSeq,
        code: String(codeSeq),
        name: String(body.name ?? ""),
        email: (body.email as string | null) ?? null,
        auth_id: authId,
        licence_limit: Number(body.licence_limit ?? 1),
        frozen: Number(body.frozen ?? 0),
        expire_date: (body.expire_date as string | null) ?? null,
        traffic_balance: (body.traffic_balance as number | null) ?? null,
        quota: (body.quota as number | null) ?? null,
        line_ids: (body.line_ids as number[] | null) ?? null,
        _is_deleted: 0,
      };
      customers.set(created.id, created);
      return json(created, 201);
    }

    if (id === null) return json({ error: "not found" }, 404);
    const current = customers.get(id);
    if (!current || current._is_deleted === 1) return json({ error: "not found" }, 404);

    if (method === "GET") return json(current);

    if (method === "PATCH") {
      patches.push({ id, body });
      // 真实 cf-api：只改 allow-list 里**传了的**字段（licence_limit 静默丢弃）
      const next: FakeCustomer = { ...current };
      for (const key of ["frozen", "expire_date", "traffic_balance", "quota", "up_mbps", "down_mbps", "line_ids"] as const) {
        if (Object.prototype.hasOwnProperty.call(body, key)) {
          Object.assign(next, { [key]: body[key] });
        }
      }
      customers.set(id, next);
      return json(next);
    }

    if (method === "DELETE") {
      customers.set(id, { ...current, _is_deleted: 1 });
      return json({ success: true });
    }

    return json({ error: "method not allowed" }, 405);
  }) as typeof fetch;

  globalThis.fetch = fake;

  return {
    base,
    token: "cv_api_test",
    customers,
    patches,
    failures,
    restore: () => {
      globalThis.fetch = realFetch;
    },
  };
}

/**
 * 把假平台的凭据写进租户 D1（`cf_api` 单行）。
 *
 * 凭据**不在 Worker secret 里**：托管分片一个 Worker 服务多个租户，部署级
 * secret 在模型上就是错的。测试因此也必须走"写库"这条路。
 * 传明文即可 —— 读取时会自动加密回写（`src/platform/creds.ts`）。
 */
export async function seedPlatformCreds(
  db: D1Database,
  cf: { base: string; token: string },
): Promise<void> {
  await db
    .prepare(
      `INSERT INTO cf_api (id, base_url, token_enc, _updated_at)
       VALUES (1, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET
         base_url = excluded.base_url,
         token_enc = excluded.token_enc,
         _updated_at = excluded._updated_at`,
    )
    .bind(cf.base, cf.token, new Date().toISOString())
    .run();
}

/** 清空凭据（模拟"没配好"）—— 订单应停在 `provisioning` */
export async function clearPlatformCreds(db: D1Database): Promise<void> {
  await db
    .prepare(
      `INSERT INTO cf_api (id, base_url, token_enc, _updated_at)
       VALUES (1, '', '', ?)
       ON CONFLICT(id) DO UPDATE SET base_url = '', token_enc = '', _updated_at = excluded._updated_at`,
    )
    .bind(new Date().toISOString())
    .run();
}
