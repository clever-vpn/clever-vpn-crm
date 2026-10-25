/**
 * cf-api 客户端 —— 契约见 `clever-vpn-docs` `crm-api.md`
 *
 * 只做三件事：按 `auth_id` 找客户、建客户、改控制参数。
 * **没有第四个概念**：激活码不是独立资源，建客户就带出来了（`crm-api.md` §4）。
 *
 * 认证只有一个租户 Token（`CF_API_TOKEN`），它**绝不下发**给 App 或浏览器。
 */

import type { Env } from "../env";

export interface PlatformCustomer {
  id: number;
  code: string;
  name: string | null;
  email: string | null;
  auth_id: string | null;
  /** 创建后不可改；变了只能删旧建新（`crm-api.md` §3.4） */
  licence_limit: number | null;
  frozen: number;
  /** `YYYY-MM-DD`；null = 永久 */
  expire_date: string | null;
  /** **字节**（1 GiB = 1024³），不是 GB */
  traffic_balance: number | null;
  quota: number | null;
  up_mbps: number | null;
  down_mbps: number | null;
}

export interface CreateCustomerInput {
  name: string;
  email?: string | null;
  auth_id: string;
  licence_limit: number;
  [key: string]: unknown;
}

/** 平台调用错误；`status === 0` 表示网络/超时（可重试） */
export class PlatformError extends Error {
  readonly status: number;

  constructor(message: string, status: number) {
    super(message);
    this.name = "PlatformError";
    this.status = status;
  }

  /** 网络、超时、限流、平台 5xx 都值得重试；4xx 不重试 */
  get retryable(): boolean {
    return this.status === 0 || this.status === 429 || this.status >= 500;
  }
}

const TIMEOUT_MS = 10_000;

function baseUrl(env: Env): string {
  const base = (env.CF_API_BASE ?? "").trim().replace(/\/+$/, "");
  if (!base) throw new PlatformError("CF_API_BASE 未配置", 0);
  return base;
}

async function call(env: Env, path: string, init: RequestInit = {}): Promise<Response> {
  const token = (env.CF_API_TOKEN ?? "").trim();
  if (!token) throw new PlatformError("CF_API_TOKEN 未配置", 0);

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    return await fetch(`${baseUrl(env)}${path}`, {
      ...init,
      signal: controller.signal,
      headers: {
        authorization: `Bearer ${token}`,
        ...(init.body ? { "content-type": "application/json" } : {}),
        ...(init.headers as Record<string, string> | undefined),
      },
    });
  } catch (e) {
    throw new PlatformError(e instanceof Error ? e.message : String(e), 0);
  } finally {
    clearTimeout(timer);
  }
}

async function expectJson<T>(res: Response): Promise<T> {
  const text = await res.text();
  if (!res.ok) {
    let message = text;
    try {
      message = (JSON.parse(text) as { error?: string }).error ?? text;
    } catch {
      /* 非 JSON 响应（网关错误页等） */
    }
    throw new PlatformError((message || `HTTP ${res.status}`).slice(0, 300), res.status);
  }
  return (text ? JSON.parse(text) : {}) as T;
}

/** 按 `auth_id` 查（CRM 的幂等键）；查不到返回 null */
export async function findCustomerByAuthId(env: Env, authId: string): Promise<PlatformCustomer | null> {
  const qs = new URLSearchParams();
  qs.set("filters[auth_id][$eq]", authId);
  qs.set("pagination[limit]", "1");
  const res = await call(env, `/api/v1/customers?${qs.toString()}`);
  const data = await expectJson<{ items?: PlatformCustomer[] } | PlatformCustomer[]>(res);
  const items = Array.isArray(data) ? data : (data.items ?? []);
  return items[0] ?? null;
}

export async function getCustomer(env: Env, id: number): Promise<PlatformCustomer> {
  const res = await call(env, `/api/v1/customers/${id}`);
  return expectJson<PlatformCustomer>(res);
}

export async function createCustomer(env: Env, input: CreateCustomerInput): Promise<PlatformCustomer> {
  const res = await call(env, "/api/v1/customers", {
    method: "POST",
    body: JSON.stringify(input),
  });
  return expectJson<PlatformCustomer>(res);
}

/** 只改控制参数。`licence_limit` 不在此列（平台会静默丢弃，见 `crm-api.md` §3.2） */
export async function updateCustomer(
  env: Env,
  id: number,
  patch: Record<string, unknown>,
): Promise<PlatformCustomer> {
  const res = await call(env, `/api/v1/customers/${id}`, {
    method: "PATCH",
    body: JSON.stringify(patch),
  });
  return expectJson<PlatformCustomer>(res);
}

/** 软删；旧 `code` 立即失效，其 licences 被级联软删（`crm-api.md` §5.1） */
export async function deleteCustomer(env: Env, id: number): Promise<void> {
  const res = await call(env, `/api/v1/customers/${id}`, { method: "DELETE" });
  if (!res.ok) await expectJson<unknown>(res);
}
