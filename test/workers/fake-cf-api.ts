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
  _is_deleted: number;
}

export interface FakeCfApi {
  base: string;
  token: string;
  customers: Map<number, FakeCustomer>;
  /** 记录每次落账写的控制参数，便于断言"字节而不是 GB" */
  patches: { id: number; body: Record<string, unknown> }[];
  restore: () => void;
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

/** 装上假的 cf-api，返回句柄；`restore()` 还原全局 fetch */
export function installFakeCfApi(base = "https://api.cf.test"): FakeCfApi {
  const customers = new Map<number, FakeCustomer>();
  const patches: { id: number; body: Record<string, unknown> }[] = [];
  let idSeq = 4200;
  let codeSeq = 7391048261558200;

  const realFetch = globalThis.fetch;

  const fake = (async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
    if (!url.href.startsWith(base)) return realFetch(input as RequestInfo, init);

    const method = (init?.method ?? "GET").toUpperCase();
    const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : {};
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
      // licence_limit 不可改：平台静默丢弃（crm-api.md §3.2）
      const next: FakeCustomer = {
        ...current,
        frozen: Number(body.frozen ?? current.frozen),
        expire_date: (body.expire_date as string | null) ?? null,
        traffic_balance: (body.traffic_balance as number | null) ?? null,
        quota: (body.quota as number | null) ?? null,
      };
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
    restore: () => {
      globalThis.fetch = realFetch;
    },
  };
}
