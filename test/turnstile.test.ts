import { describe, expect, it, vi } from "vitest";
import { turnstileEnabled, verifyTurnstile } from "../src/turnstile";
import type { Env } from "../src/env";

const env = (over: Partial<Env> = {}): Env => ({ DB: {} as D1Database, ASSETS: {} as Fetcher, ...over });

describe("turnstile", () => {
  it("没配 secret 就是没开：turnstileEnabled=false", () => {
    expect(turnstileEnabled(env())).toBe(false);
    expect(turnstileEnabled(env({ TURNSTILE_SITE_KEY: "site" }))).toBe(false);
  });

  it("没配 secret 时校验直接跳过，不发任何请求", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    const result = await verifyTurnstile(env(), "");
    expect(result).toEqual({ ok: true, skipped: true });
    expect(fetchSpy).not.toHaveBeenCalled();
    fetchSpy.mockRestore();
  });

  it("配了 secret 但 token 为空：本地拒绝，不打远端", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    const result = await verifyTurnstile(env({ TURNSTILE_SECRET: "s" }), "");
    expect(result).toEqual({ ok: false, codes: ["missing-input-response"] });
    expect(fetchSpy).not.toHaveBeenCalled();
    fetchSpy.mockRestore();
  });

  it("远端 success=true 才放行", async () => {
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(new Response(JSON.stringify({ success: true }), { status: 200 }));
    await expect(verifyTurnstile(env({ TURNSTILE_SECRET: "s" }), "tok")).resolves.toEqual({
      ok: true,
      skipped: false,
    });
    fetchSpy.mockRestore();
  });

  it("远端 success=false 带回 error-codes", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ success: false, "error-codes": ["invalid-input-response"] }), {
        status: 200,
      }),
    );
    await expect(verifyTurnstile(env({ TURNSTILE_SECRET: "s" }), "tok")).resolves.toEqual({
      ok: false,
      codes: ["invalid-input-response"],
    });
    fetchSpy.mockRestore();
  });

  it("远端挂了/超时也不静默放行", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("boom"));
    await expect(verifyTurnstile(env({ TURNSTILE_SECRET: "s" }), "tok")).resolves.toEqual({
      ok: false,
      codes: ["verify_failed"],
    });
    fetchSpy.mockRestore();
  });
});
