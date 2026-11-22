import { describe, expect, it } from "vitest";

import { runDomainCheck } from "../../src/domains/check";

import type { DomainView as RawDomainView } from "../../src/platform/domains";

const DNS_TYPE = { A: 1, NS: 2, CNAME: 5, TXT: 16, AAAA: 28 } as const;

interface Answer {
  name: string;
  type: number;
  data: string;
}

function raw(overrides: Partial<RawDomainView> = {}): RawDomainView {
  return {
    hostname: "www.brand.com",
    kind: "site",
    state: "active",
    enabled: true,
    hostname_status: "active",
    cert_status: "active",
    cert_expires_at: "2027-02-20T00:00:00Z",
    dcv_available: true,
    cf_hostname_id: "cf-1",
    created_at: "2026-11-22T00:00:00Z",
    verified_at: "2026-11-22T00:00:00Z",
    last_checked_at: "2026-11-22T00:00:00Z",
    last_error: null,
    dns: {
      target: "origin-site.clever-vpn.org",
      ownership: null,
      dcv: [
        {
          type: "CNAME",
          name: "_acme-challenge.www.brand.com",
          value: "www.brand.com.abc.dcv.cloudflare.com",
        },
      ],
    },
    ...overrides,
  };
}

function answer(name: string, type: keyof typeof DNS_TYPE, data: string): Answer {
  return { name, type: DNS_TYPE[type], data };
}

function fakeFetch(opts: {
  dns?: Answer[];
  head?: number;
  fail?: boolean;
}): typeof fetch {
  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    if (opts.fail) throw new Error("network down");
    const url = new URL(String(input));
    const host = url.hostname;
    if (host === "cloudflare-dns.com" || host === "dns.google") {
      const name = url.searchParams.get("name") ?? "";
      const typeName = (url.searchParams.get("type") ?? "") as keyof typeof DNS_TYPE;
      const type = DNS_TYPE[typeName];
      const answers = (opts.dns ?? []).filter((a) => a.type === type && a.name === name);
      return new Response(JSON.stringify({ Status: 0, Answer: answers }), {
        status: 200,
        headers: { "content-type": "application/dns-json" },
      });
    }
    if (init?.method === "HEAD") {
      return new Response(null, { status: opts.head ?? 200 });
    }
    return new Response("not found", { status: 404 });
  }) as typeof fetch;
}

describe("runDomainCheck", () => {
  it("全部完成 ⇒ ready", async () => {
    const check = await runDomainCheck(
      raw(),
      {
        fetch: fakeFetch({
          head: 200,
          dns: [
            answer("www.brand.com", "NS", "ada.ns.cloudflare.com"),
            answer("www.brand.com", "CNAME", "origin-site.clever-vpn.org"),
            answer("_acme-challenge.www.brand.com", "CNAME", "www.brand.com.abc.dcv.cloudflare.com"),
          ],
        }),
      },
    );
    expect(check.status).toBe("ready");
    expect(check.provider).toBe("cloudflare");
    expect(check.steps.map((s) => s.status)).toEqual(["done", "done"]);
  });

  it("记录都没加 ⇒ needs_action，并给出添加指令", async () => {
    const check = await runDomainCheck(
      raw({
        state: "pending",
        hostname_status: "pending",
        cert_status: "pending_validation",
        dns: {
          target: "origin-site.clever-vpn.org",
          ownership: {
            type: "TXT",
            name: "_cf-custom-hostname.www.brand.com",
            value: "token-1",
          },
          dcv: [
            {
              type: "CNAME",
              name: "_acme-challenge.www.brand.com",
              value: "www.brand.com.abc.dcv.cloudflare.com",
            },
          ],
        },
      }),
      {
        fetch: fakeFetch({
          head: 522,
          dns: [answer("www.brand.com", "NS", "ns1.example.net")],
        }),
      },
    );
    expect(check.status).toBe("needs_action");
    expect(check.provider).toBe("other");
    expect(check.steps.map((s) => s.status)).toEqual(["todo", "todo", "todo"]);
    expect(check.steps[0]?.fix).toContain("添加 CNAME");
    expect(check.steps[1]?.fix).toContain("CNAME");
    expect(check.steps[2]?.fix).toContain("TXT");
  });

  it("流量 CNAME 指向错 ⇒ wrong_target", async () => {
    const check = await runDomainCheck(
      raw({
        state: "pending",
        hostname_status: "pending",
        cert_status: "pending_validation",
      }),
      {
        fetch: fakeFetch({
          head: 522,
          dns: [
            answer("www.brand.com", "NS", "ns1.example.net"),
            answer("www.brand.com", "CNAME", "old.example.com"),
          ],
        }),
      },
    );
    expect(check.steps[0]?.problem).toBe("wrong_target");
    expect(check.steps[0]?.fix).toContain("old.example.com");
    expect(check.steps[0]?.fix).toContain("origin-site.clever-vpn.org");
  });

  it("CNAME 指向错、但网站有响应 ⇒ 仍判 wrong_target", async () => {
    const check = await runDomainCheck(
      raw({ state: "pending", hostname_status: "pending", cert_status: "pending_validation" }),
      {
        fetch: fakeFetch({
          head: 200,
          dns: [
            answer("www.brand.com", "NS", "ns1.example.net"),
            answer("www.brand.com", "CNAME", "old.example.com"),
          ],
        }),
      },
    );
    expect(check.steps[0]?.problem).toBe("wrong_target");
    expect(check.steps[0]?.status).toBe("todo");
  });

  it("CNAME 对但网站 522 ⇒ proxy，提示橙云", async () => {
    const check = await runDomainCheck(
      raw({ state: "pending", hostname_status: "pending", cert_status: "pending_validation" }),
      {
        fetch: fakeFetch({
          head: 522,
          dns: [
            answer("www.brand.com", "NS", "ada.ns.cloudflare.com"),
            answer("www.brand.com", "CNAME", "origin-site.clever-vpn.org"),
          ],
        }),
      },
    );
    expect(check.steps[0]?.problem).toBe("proxy");
    expect(check.steps[0]?.fix).toContain("橙云");
  });

  it("续期记录是 TXT ⇒ wrong_type，提示改成 CNAME", async () => {
    const check = await runDomainCheck(
      raw({ state: "pending", hostname_status: "pending", cert_status: "pending_validation" }),
      {
        fetch: fakeFetch({
          head: 200,
          dns: [
            answer("www.brand.com", "NS", "ns1.example.net"),
            answer("www.brand.com", "CNAME", "origin-site.clever-vpn.org"),
            answer("_acme-challenge.www.brand.com", "TXT", "some-token"),
          ],
        }),
      },
    );
    expect(check.steps[1]?.problem).toBe("wrong_type");
    expect(check.steps[1]?.fix).toContain("CNAME 和 TXT 不能同名共存");
  });

  it("DNS/HEAD 全失败 ⇒ unknown，不误报", async () => {
    const check = await runDomainCheck(raw(), { fetch: fakeFetch({ fail: true }) });
    expect(check.status).toBe("unknown");
    expect(check.steps.every((s) => s.status === "unknown")).toBe(true);
  });
});
