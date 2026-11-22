/**
 * cf-api 自定义域名接口的薄封装（`hosting.md` §5.6）。
 *
 * 与 `client.ts` 的分工：这里只做路径 / 类型；token、基址、超时、错误类型
 * 全部复用 `platformRequest` / `platformJson`，不建第二套 cf-api 客户端。
 *
 * 注意：cf-api 的路径带版本段（`/api/v2/...`），且这是**租户面**接口 —— 用
 * 本租户的 API token 就够，不需要面板会话。
 */
import { platformJson, platformRequest } from "./client";

import type { Env } from "../env";

export type DomainKind = "site" | "crm";
export type DomainState = "pending" | "active" | "failed";

export interface DomainDnsRecord {
  type: "TXT" | "CNAME";
  name: string;
  value: string;
  status?: string;
}

export interface DomainDns {
  /** 租户 DNS 里的 CNAME 目标（apex 用 A 192.0.2.1 的说明在前端） */
  target: string;
  /** 归属验证 TXT；只在 Hostname 还没 active 时作为 HTTP 失败后的备用 */
  ownership: DomainDnsRecord | null;
  /** 证书验证：只走 DCV CNAME（产品策略，不暴露手动 TXT） */
  dcv: DomainDnsRecord[];
}

export interface DomainView {
  hostname: string;
  kind: DomainKind | string;
  state: DomainState;
  enabled: boolean;
  hostname_status: string | null;
  cert_status: string | null;
  /** 当前证书到期时间；缓存列表未回源时为 null */
  cert_expires_at: string | null;
  /** 是否拿到了 DCV 委派记录 */
  dcv_available: boolean;
  cf_hostname_id: string | null;
  created_at: string | null;
  verified_at: string | null;
  last_checked_at: string | null;
  last_error: string | null;
  dns: DomainDns | null;
}

export interface DomainsOverview {
  slug: string;
  defaults: { crm: string; site: string };
  target: string;
  domains: DomainView[];
}

export async function listDomains(env: Env): Promise<DomainsOverview> {
  const res = await platformRequest(env, "/api/v2/crms/domains");
  return platformJson<DomainsOverview>(res);
}

export async function getDomain(
  env: Env,
  hostname: string,
  refresh: boolean,
): Promise<{ domain: DomainView }> {
  const res = await platformRequest(
    env,
    `/api/v2/crms/domains/${encodeURIComponent(hostname)}${refresh ? "?refresh=1" : ""}`,
  );
  return platformJson<{ domain: DomainView }>(res);
}

export async function createDomain(
  env: Env,
  input: { hostname: string; kind: DomainKind },
): Promise<{ domain: DomainView }> {
  const res = await platformRequest(env, "/api/v2/crms/domains", {
    method: "POST",
    body: JSON.stringify(input),
  });
  return platformJson<{ domain: DomainView }>(res);
}

export async function removeDomain(
  env: Env,
  hostname: string,
): Promise<{ ok: true; deleted: boolean }> {
  const res = await platformRequest(
    env,
    `/api/v2/crms/domains/${encodeURIComponent(hostname)}`,
    { method: "DELETE" },
  );
  return platformJson<{ ok: true; deleted: boolean }>(res);
}
