#!/usr/bin/env node
/**
 * 从 **`APP_SECRET`** 派生出两个 studio 各自的签名密钥。
 *
 *   material = `${APP_SECRET}|crm/studio/v1`
 *   K_site   = HMAC-SHA256(material, "studio-ticket:site-studio")
 *   K_app    = HMAC-SHA256(material, "studio-ticket:app-studio")
 *
 * 契约：`clever-vpn-docs/docs/contracts/studio-identity.md` §3.2。
 *
 * **不额外引入 secret**：studio 票据和退订签名（`crm/sign/v1`）、落库加密
 * （`crm/enc/v1`）一样，都从同一把 `APP_SECRET` 按标签派生（见 `src/secrets.ts`）。
 * 第二层再按产品分，是为了让**一个 studio 的密钥泄漏只能伪造它自己那个产品的会话**。
 *
 * 用法（**在本机跑，输出不要贴到聊天/Issue 里**）：
 *
 *   APP_SECRET="$(bws secret get <BW_SECRET_ID_APP_SECRET 的 uuid> --output json | jq -r .value)" \
 *     node scripts/studio-key.mjs
 *
 * 输出两行 hex，分别存进 Bitwarden，再配到两个 studio 的 `STUDIO_TICKET_KEY` secret。
 */
import { createHmac } from "node:crypto";

const appSecret = String(process.env.APP_SECRET ?? "").trim();
if (!appSecret) {
  console.error("缺少 APP_SECRET（CRM 的唯一主密钥，Bitwarden 条目 BW_SECRET_ID_APP_SECRET）");
  process.exit(1);
}
if (appSecret.length < 16) {
  console.error("APP_SECRET 太短（<16 字符）。用 `openssl rand -hex 32` 生成。");
  process.exit(1);
}

/** 第一层：与 sign / enc 并列的用途标签（必须与 `src/secrets.ts` 一致） */
const material = `${appSecret}|crm/studio/v1`;
const derive = (aud) =>
  createHmac("sha256", material).update(`studio-ticket:${aud}`).digest("hex");

console.log(`# 直接填进对应 studio 的 secret：wrangler secret put STUDIO_TICKET_KEY`);
console.log(`STUDIO_TICKET_KEY(site-studio)=${derive("site-studio")}`);
console.log(`STUDIO_TICKET_KEY(app-studio) =${derive("app-studio")}`);
