import { beforeEach, describe, expect, it } from "vitest";
import {
  TenantResolveError,
  __clearScopeCache,
  modeOf,
  scopeToTenant,
} from "../src/tenant/scope";

/** 极简 KV 替身：只实现 get(key, 'json') */
function kvOf(entries: Record<string, unknown>): KVNamespace {
  return {
    get: async (key: string) => (key in entries ? entries[key] : null),
  } as unknown as KVNamespace;
}

const DB_A = { name: "DB_A" } as unknown as D1Database;
const DB_B = { name: "DB_B" } as unknown as D1Database;

const req = (url: string) => new Request(url);

beforeEach(() => __clearScopeCache());

describe("modeOf", () => {
  it("默认 single，只有显式 multi 才是多租户", () => {
    expect(modeOf({})).toBe("single");
    expect(modeOf({ MODE: "single" })).toBe("single");
    expect(modeOf({ MODE: "multi" })).toBe("multi");
    expect(modeOf({ MODE: "MULTI" })).toBe("single"); // 大小写不宽容，宁可不生效
  });
});

describe("scopeToTenant · single（自部署）", () => {
  it("原样使用 env.DB，行为与多租户改造前一致", async () => {
    const env = { DB: DB_A, CRM_TENANT_ID: "42" };
    const scoped = await scopeToTenant(req("https://crm.example.com/api/app/v1/me"), env);
    expect(scoped.env.DB).toBe(DB_A);
    expect(scoped.tenantId).toBe("42");
    expect(scoped.slot).toBe(0);
  });

  it("没有 DB 绑定时给出明确错误，而不是运行期随机崩", async () => {
    await expect(scopeToTenant(req("https://crm.example.com/"), {})).rejects.toMatchObject({
      code: "not_configured",
    });
  });
});

describe("scopeToTenant · multi（SaaS 分片）", () => {
  const env = { MODE: "multi", DB_0: DB_A, DB_7: DB_B } as Record<string, unknown>;

  it("host → KV → slot → env['DB_<slot>']", async () => {
    const e = { ...env, HOSTS: kvOf({ "host:acme.app.example.com": { tenant_id: "t_acme", slot: 7 } }) };
    const scoped = await scopeToTenant(req("https://acme.app.example.com/admin"), e);
    expect(scoped.env.DB).toBe(DB_B);
    expect(scoped.tenantId).toBe("t_acme");
    expect(scoped.slot).toBe(7);
  });

  it("其余绑定（secret/vars）仍然看得见：只盖 DB，不重造 env", async () => {
    const e = {
      ...env,
      SESSION_SECRET: "shh",
      HOSTS: kvOf({ "host:acme.app.example.com": { tenant_id: "t_acme", slot: 7 } }),
    };
    const scoped = await scopeToTenant(req("https://acme.app.example.com/"), e);
    expect((scoped.env as Record<string, unknown>).SESSION_SECRET).toBe("shh");
    expect(scoped.env.DB).toBe(DB_B);
    // 原 env 不被污染
    expect((e as Record<string, unknown>).DB).toBeUndefined();
  });

  it("未知 host 一律报错，绝不回落默认租户", async () => {
    const e = { ...env, HOSTS: kvOf({}) };
    await expect(
      scopeToTenant(req("https://nobody.app.example.com/"), e),
    ).rejects.toMatchObject({ code: "unknown_host" });
  });

  it("暂停的租户直接拒", async () => {
    const e = {
      ...env,
      HOSTS: kvOf({ "host:old.app.example.com": { tenant_id: "t_old", slot: 0, status: "suspended" } }),
    };
    await expect(
      scopeToTenant(req("https://old.app.example.com/"), e),
    ).rejects.toMatchObject({ code: "suspended" });
  });

  it("绑定漏了要立刻炸，并说清是哪个 slot", async () => {
    const e = { ...env, HOSTS: kvOf({ "host:acme.app.example.com": { tenant_id: "t_acme", slot: 999 } }) };
    await expect(
      scopeToTenant(req("https://acme.app.example.com/"), e),
    ).rejects.toBeInstanceOf(TenantResolveError);
    await expect(
      scopeToTenant(req("https://acme.app.example.com/"), e),
    ).rejects.toMatchObject({ code: "missing_db" });
  });

  it("缺 HOSTS 绑定时明确报错（启动自检）", async () => {
    await expect(scopeToTenant(req("https://x.app.example.com/"), env)).rejects.toMatchObject({
      code: "not_configured",
    });
  });

  it("KV 结果在 isolate 内缓存：同一 host 第二次不再读 KV", async () => {
    let reads = 0;
    const kv = {
      get: async () => {
        reads += 1;
        return { tenant_id: "t_acme", slot: 7 };
      },
    } as unknown as KVNamespace;
    const e = { ...env, HOSTS: kv };
    await scopeToTenant(req("https://acme.app.example.com/"), e);
    await scopeToTenant(req("https://acme.app.example.com/other"), e);
    expect(reads).toBe(1);
  });
});
