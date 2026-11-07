#!/usr/bin/env node
/**
 * 用 cf-api 给的**绑定清单**渲染 SaaS 分片的部署配置。
 *
 * 为什么需要：`wrangler.jsonc` 不支持占位符，而分片的 `DB_<slot>` 只能从 registry
 * 算出来（契约 `site-hosting` §4.5.1 —— 清单必须程序生成，漏一条就是静默解绑）。
 *
 * 输入：`GET /api/v2/platform/shards/{n}/manifest` 的原样 JSON
 * 输出（一个文件，gitignore）：
 *   wrangler.shard.jsonc  —— 给 `wrangler deploy --config`
 *
 * ⚠️ 不再产出 `settings.json`（曾用于部署后 `PATCH …/settings` 刷新绑定），原因：
 * Workers 里 **`vars` 就是 `plain_text` 类型的 binding**，而 PATCH settings 的
 * `bindings` 是**整体替换** —— 只提交 KV+D1，会把 MODE / SHARD 等 vars 全部删掉，
 * 于是 worker 退回 `MODE=single` 且没有 `DB`，第一次请求就 500。实测踩过。
 * 刷新绑定改用"拿最新清单再 `wrangler deploy` 一次"：同一条代码路径、保留 secrets、
 * 也保留 vars。
 *
 * 用法（由 `.github/workflows/deploy-saas.yml` 调用）：
 *   node scripts/render-shard-config.mjs --manifest manifest.json
 *
 * 必需环境变量：
 *   HOSTS_KV_ID       站内 KV（与 site-serve 共用同一个命名空间）
 * 可选：
 *   CRM_CONTRACT_VERSION（默认与 wrangler.jsonc 同步维护）、
 *   APP_ORIGINS、SITE_URL、EMAIL_FROM（默认 noreply@clever-vpn.org）
 *
 * ⚠️ **邮件必须在分片里可用**：后台的「邮箱验证码登录」和「忘记密码」都靠它
 * （契约 `site-hosting` §4.8.3）。以前这份配置没带 `send_email`，分片上的
 * `emailCodeAvailable()` 恒为 false —— 表现为登录页只剩密码一条路，
 * 密码一丢就没有任何自助恢复入口。
 */
import { readFileSync, writeFileSync } from "node:fs";

const arg = (name, fallback) => {
  const i = process.argv.indexOf(`--${name}`);
  if (i === -1) return fallback;
  const v = process.argv[i + 1];
  return v && !v.startsWith("--") ? v : true;
};

const manifestPath = arg("manifest", "manifest.json");
const manifest = JSON.parse(readFileSync(String(manifestPath), "utf8"));

const needs = ["worker", "shard", "bindings"];
const missing = needs.filter((k) => manifest[k] === undefined);
if (missing.length) {
  console.error(`✘ manifest 缺字段：${missing.join(", ")}`);
  process.exit(1);
}

const hostsKvId = process.env.HOSTS_KV_ID ?? "";
if (!hostsKvId) {
  console.error("✘ 缺 HOSTS_KV_ID（站内 KV 命名空间 id）");
  process.exit(1);
}

/** 非 D1 绑定：必须与 D1 一起提交，因为 PATCH settings 是**全量替换** */
const kvBindings = [
  { type: "kv_namespace", name: "HOSTS", namespace_id: hostsKvId },
];
const d1Bindings = manifest.bindings.map((b) => ({
  type: "d1",
  name: b.binding,
  id: b.database_id,
}));

const vars = {
  MODE: "multi",
  SHARD: String(manifest.shard),
  CF_API_BASE: process.env.CF_API_BASE ?? "https://api.clever-vpn.org",
  CRM_CODE_VERSION: process.env.CRM_CODE_VERSION ?? "dev",
  CRM_CONTRACT_VERSION: process.env.CRM_CONTRACT_VERSION ?? "19",
  ENVIRONMENT: "production",
  APP_ORIGINS: process.env.APP_ORIGINS ?? "",
  SITE_URL: process.env.SITE_URL ?? "",
  // 发信人：域名须已在本账号完成 Email Sending 验证（与 cf-api 用同一个）
  EMAIL_FROM: process.env.EMAIL_FROM ?? "noreply@clever-vpn.org",
};

/** wrangler 配置：代码 + 资源 + 绑定（首次部署与升级都用它） */
const config = `// ⚠️ 自动生成，不要提交（.gitignore 已排除）。来源：cf-api 的 shard manifest
{
  "name": ${JSON.stringify(manifest.worker)},
  "main": "src/index.ts",
  "compatibility_date": "2026-10-01",
  "assets": {
    "directory": "./web/dist",
    "binding": "ASSETS",
    "not_found_handling": "none",
    "html_handling": "none"
  },
  "observability": { "enabled": true },
  "send_email": [{ "name": "EMAIL" }],
  "kv_namespaces": [{ "binding": "HOSTS", "id": ${JSON.stringify(hostsKvId)} }],
  "d1_databases": ${JSON.stringify(
    manifest.bindings.map((b) => ({
      binding: b.binding,
      database_name: b.database_name,
      database_id: b.database_id,
    })),
    null,
    2,
  )},
  "vars": ${JSON.stringify(vars, null, 2)}
}
`;

writeFileSync("wrangler.shard.jsonc", config);

console.error(`✔ ${manifest.worker}：shard=${manifest.shard}`);
console.error(`  D1 绑定 ${manifest.bindings.length} 条（已分配 ${manifest.slots?.length ?? 0} + 池中 ${manifest.pooled?.length ?? 0}）`);
console.error(`  → wrangler.shard.jsonc（含 vars：MODE/SHARD/…）`);
if (kvBindings.length + d1Bindings.length !== 1 + manifest.bindings.length) {
  console.error("✘ 内部不一致：KV 与 D1 绑定数量对不上");
  process.exit(1);
}
