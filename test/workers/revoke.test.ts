/**
 * 撤销权益（退款 / 吊销）：**两处必须同时动**。
 *
 * 这条曾经漏了：`refundIapOrder` 只改 CRM 的 `hold='revoked'`，没推 cf-api，
 * 结果是 App 里显示"权益已撤销"、VPN 却能照常连到自然到期。这里钉三件事：
 *
 *   1. 平台侧真的收到 `frozen=1`（生效点在平台，不在 CRM）；
 *   2. 平台推失败也要落本地账（钱已经退出去是事实），并如实标记 `platform_synced`；
 *   3. 重复撤销幂等，且撤销后**不能**被 `setCustomerHold` 解冻复活。
 */
import { beforeEach, describe, expect, it } from "vitest";

import { env } from "./apply-migrations";
import { installFakeCfApi, seedPlatformCreds } from "./fake-cf-api";
import { revokeEntitlement, setCustomerHold } from "../../src/subscriptions/hold";

const CUSTOMER = 1;
const PLATFORM_ID = 9001;

async function seed() {
  await env.DB.prepare(
    `INSERT INTO customers (id, uuid, email, status, created_at)
     VALUES (?, lower(hex(randomblob(16))), 'revoke@test.com', 'active', ?)`,
  )
    .bind(CUSTOMER, new Date().toISOString())
    .run();
  const iso = new Date().toISOString();
  await env.DB.prepare(
    `INSERT INTO platform_subscriptions
       (customer_id, plan_id, kind, paid_minor, currency, licence_limit,
        period_term_days, platform_customer_id, expires_at, started_at, hold,
        created_at, updated_at)
     VALUES (?, 'p_30d', 'period', 1500, 'CNY', 1, 30, ?, ?, ?, 'none', ?, ?)`,
  )
    .bind(
      CUSTOMER,
      PLATFORM_ID,
      new Date(Date.now() + 20 * 86400_000).toISOString(),
      iso,
      iso,
      iso,
    )
    .run();
}

beforeEach(async () => {
  await env.DB.prepare("DELETE FROM customers").run();
  await env.DB.prepare("DELETE FROM platform_subscriptions").run();
  await seed();
});

describe("revokeEntitlement", () => {
  it("停服推到平台：frozen=1，且本地转 revoked", async () => {
    const cf = installFakeCfApi();
    await seedPlatformCreds(env.DB, cf);
    cf.customers.set(PLATFORM_ID, {
      id: PLATFORM_ID,
      code: "C9001",
      name: "revoke",
      email: "revoke@test.com",
      auth_id: "a9001",
      licence_limit: 1,
      frozen: 0,
      expire_date: null,
      traffic_balance: null,
      quota: null,
      _is_deleted: 0,
    });
    try {
      const r = await revokeEntitlement(env, {
        customerId: CUSTOMER,
        reason: "退款：网关侧已人工退回",
      });
      expect(r).toMatchObject({ ok: true, platform_synced: true, already: false });

      // ① 平台侧：这条是生效点，没有它等于没撤销
      const patch = cf.patches.find((p) => p.id === PLATFORM_ID);
      expect(patch?.body).toMatchObject({ frozen: 1 });

      // ② 本地
      const sub = await env.DB.prepare(
        `SELECT hold, hold_reason FROM platform_subscriptions WHERE customer_id = ?`,
      )
        .bind(CUSTOMER)
        .first<{ hold: string; hold_reason: string }>();
      expect(sub?.hold).toBe("revoked");
      expect(sub?.hold_reason).toContain("退款");
    } finally {
      cf.restore();
    }
  });

  it("平台推失败：本地照样撤销，并标记 platform_synced=false", async () => {
    // 指向一个不存在的主机：模拟平台故障/网络抖动
    await seedPlatformCreds(env.DB, { base: "https://api.cf-unreachable.test", token: "t" });
    const r = await revokeEntitlement(env, {
      customerId: CUSTOMER,
      reason: "退款：平台暂时不可用",
    });
    expect(r).toMatchObject({ ok: true, platform_synced: false, already: false });

    const sub = await env.DB.prepare(
      `SELECT hold FROM platform_subscriptions WHERE customer_id = ?`,
    )
      .bind(CUSTOMER)
      .first<{ hold: string }>();
    expect(sub?.hold).toBe("revoked");
  });

  it("重复撤销幂等；撤销后不能解冻复活", async () => {
    const cf = installFakeCfApi();
    await seedPlatformCreds(env.DB, cf);
    try {
      await revokeEntitlement(env, { customerId: CUSTOMER, reason: "退款" });
      const again = await revokeEntitlement(env, { customerId: CUSTOMER, reason: "退款" });
      expect(again).toMatchObject({ ok: true, already: true });

      // 解冻只对 frozen 生效，revoked 不能借这个口子回来
      expect(
        await setCustomerHold(env, { customerId: CUSTOMER, frozen: false, reason: "想恢复" }),
      ).toMatchObject({ ok: false, code: "invalid_state" });
    } finally {
      cf.restore();
    }
  });

  it("必须写原因", async () => {
    expect(
      await revokeEntitlement(env, { customerId: CUSTOMER, reason: "  " }),
    ).toMatchObject({ ok: false, code: "invalid" });
  });
});
