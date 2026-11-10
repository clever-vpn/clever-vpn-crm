#!/usr/bin/env node
/**
 * 从 `STUDIO_TICKET_MASTER` 派生出两个 studio 各自的签名密钥。
 *
 *   K_site = HMAC-SHA256(K_master, "studio-ticket:site-studio")
 *   K_app  = HMAC-SHA256(K_master, "studio-ticket:app-studio")
 *
 * 契约：`clever-vpn-docs/docs/contracts/studio-identity.md` §3.2。
 *
 * 为什么派生而不是"三个仓共用一把"：一个 studio 的密钥泄漏只能伪造它自己那个产品的
 * 会话。CRM 不需要把 K_master 交给任何人。
 *
 * 用法（**在本机跑，输出不要贴到聊天/Issue 里**）：
 *
 *   STUDIO_TICKET_MASTER="$(bws secret get <uuid> --output json | jq -r .value)" \
 *     node scripts/studio-key.mjs
 *
 * 输出两行 hex，分别填到两个 studio 的 `STUDIO_TICKET_KEY` secret。
 */
import { createHmac } from "node:crypto";

const master = String(process.env.STUDIO_TICKET_MASTER ?? "").trim();
if (!master) {
  console.error("缺少 STUDIO_TICKET_MASTER（CRM 的 secret 值，见 docs/self-host.md）");
  process.exit(1);
}
if (master.length < 16) {
  console.error("STUDIO_TICKET_MASTER 太短（<16 字符）。用 `openssl rand -hex 32` 生成。");
  process.exit(1);
}

const derive = (aud) =>
  createHmac("sha256", master).update(`studio-ticket:${aud}`).digest("hex");

console.log(`# 直接填进对应 studio 的 secret：wrangler secret put STUDIO_TICKET_KEY`);
console.log(`STUDIO_TICKET_KEY(site-studio)=${derive("site-studio")}`);
console.log(`STUDIO_TICKET_KEY(app-studio) =${derive("app-studio")}`);
