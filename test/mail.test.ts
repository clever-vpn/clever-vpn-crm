/**
 * 邮件能力判定 —— 这个函数的返回值直接决定"后台显示哪些登录方式"，
 * 所以把真值表钉死，避免以后改动悄悄把"没配邮件也显示邮箱登录"放回来。
 */

import { describe, it, expect } from "vitest";

import { generateNumericCode } from "../src/admin/crypto";
import { emailCodeAvailable, mailReady, sendMail } from "../src/mail";

const binding = { send: async () => ({ messageId: "x" }) };

describe("mailReady", () => {
  it("有传输 + 有发信人 → 就绪", () => {
    expect(mailReady({ EMAIL: binding, EMAIL_FROM: "noreply@example.com" })).toBe(true);
    expect(mailReady({ RESEND_API_KEY: "re_x", EMAIL_FROM: "noreply@example.com" })).toBe(true);
  });

  it("只有传输没有发信人 → 未就绪（半配置是最坑的状态）", () => {
    expect(mailReady({ EMAIL: binding })).toBe(false);
    expect(mailReady({ RESEND_API_KEY: "re_x" })).toBe(false);
  });

  it("只有发信人没有传输 → 未就绪", () => {
    expect(mailReady({ EMAIL_FROM: "noreply@example.com" })).toBe(false);
  });

  it("全空 → 未就绪", () => {
    expect(mailReady({})).toBe(false);
  });
});

describe("emailCodeAvailable", () => {
  it("开发环境永远可用（验证码直接回显，不需要配邮件）", () => {
    expect(emailCodeAvailable({ ENVIRONMENT: "development" })).toBe(true);
    expect(emailCodeAvailable({})).toBe(true);
  });

  it("生产环境要求真的配好邮件", () => {
    expect(emailCodeAvailable({ ENVIRONMENT: "production" })).toBe(false);
    expect(
      emailCodeAvailable({ ENVIRONMENT: "production", EMAIL: binding, EMAIL_FROM: "a@b.c" }),
    ).toBe(true);
  });
});

describe("sendMail", () => {
  it("开发环境不发信，返回 dev 标记", async () => {
    const r = await sendMail({ ENVIRONMENT: "development" }, { to: "a@b.c", subject: "s", text: "t" });
    expect(r).toEqual({ ok: true, dev: true });
  });

  it("生产环境未配置 → 明确失败，不抛异常", async () => {
    const r = await sendMail({ ENVIRONMENT: "production" }, { to: "a@b.c", subject: "s", text: "t" });
    expect(r.ok).toBe(false);
    expect(r.error).toBe("email_unavailable");
  });

  it("有绑定就走绑定", async () => {
    let called = false;
    const r = await sendMail(
      {
        ENVIRONMENT: "production",
        EMAIL_FROM: "noreply@example.com",
        EMAIL: { send: async () => { called = true; return {}; } },
      },
      { to: "a@b.c", subject: "s", text: "t" },
    );
    expect(r.ok).toBe(true);
    expect(called).toBe(true);
  });
});

describe("generateNumericCode", () => {
  it("恒为 6 位数字（含前导零）", () => {
    for (let i = 0; i < 50; i++) {
      const code = generateNumericCode();
      expect(code).toMatch(/^\d{6}$/);
    }
  });
});
