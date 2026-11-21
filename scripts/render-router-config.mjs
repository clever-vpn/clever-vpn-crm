#!/usr/bin/env node
/**
 * 用 cf-api 的水位概览渲染 **router** 的部署配置。
 *
 * service binding 是部署期静态的 ⇒ 片数变了必须重新部署 router 才会多一条
 * `SHARD_<n>`。片数的唯一来源是 `shards_ready`（cf-api 的 `CONFIG_KV`，
 * 建片 workflow 在"shard 部署完 + router 部署完"之后才写它）。
 *
 * 输入：`GET /api/v2/platform/shards` 的原样 JSON（`{ shards_ready, shards: [...] }`）
 * 输出：`wrangler.router.jsonc`（gitignore）
 *
 * 为什么不再看 `deployed` 标记：**registry 不存分片状态**（代码版本、存在性都在
 * Cloudflare）。`shards_ready = N` 的语义就是"shard-0 .. shard-(N-1) 都已经建好
 * 并且接进了 router"，照着绑就行。
 *
 * 必需环境变量：
 *   HOSTS_KV_ID     与 site-serve / shard 共用同一个 KV 命名空间
 *   REGISTRY_D1_ID  registry 库（`{slug}.<CRM_ROOT>` 按 slug 查 tenants 用）
 *   CRM_ROOT        租户后台域的父域（`clever-panel.win`）
 *   BASE_DOMAIN     回源所在 zone（默认 clever-vpn.org）
 */
import { readFileSync, writeFileSync } from "node:fs";

const arg = (name, fallback) => {
  const i = process.argv.indexOf(`--${name}`);
  if (i === -1) return fallback;
  const v = process.argv[i + 1];
  return v && !v.startsWith("--") ? v : true;
};

const input = String(arg("input", "shards.json"));
const data = JSON.parse(readFileSync(input, "utf8"));
const shards = Array.isArray(data.shards) ? data.shards : [];

const hostsKvId = process.env.HOSTS_KV_ID ?? "";
const registryD1 = process.env.REGISTRY_D1_ID ?? "";
const crmRoot = String(process.env.CRM_ROOT ?? "").trim();
const baseDomain = String(process.env.BASE_DOMAIN ?? "").trim() || "clever-vpn.org";
if (!hostsKvId) {
  console.error("✘ 缺 HOSTS_KV_ID");
  process.exit(1);
}
if (!registryD1) {
  console.error("✘ 缺 REGISTRY_D1_ID（平台子域按 slug 查 tenants 要用）");
  process.exit(1);
}
if (!crmRoot) {
  console.error("✘ 缺 CRM_ROOT（否则认不出 {slug}.<CRM_ROOT>）");
  process.exit(1);
}

// 片数只认 `shards_ready`；`--ready N` 给建片流程用（router 要比 cf-api 先知道新片）
const override = Number(arg("ready", 0));
const ready = Math.max(Number(data.shards_ready ?? 0), Number.isFinite(override) ? override : 0);
if (!Number.isInteger(ready) || ready < 1) {
  console.error(`✘ shards_ready 必须 ≥1（收到 ${JSON.stringify(data.shards_ready)}）`);
  process.exit(1);
}
const deployed = Array.from({ length: ready }, (_, i) => i);

const config = {
  name: "clever-vpn-crm-router",
  // ⚠️ `main` 相对**配置文件**所在目录（这里是仓库根），不是相对本脚本：
  // 写成 "src/index.ts" 会把 CRM 本体部署成 router（实测踩过：router 返回的
  // 是 CRM 的 "MODE=single 但没有绑定 DB"）。
  main: "workers/router/src/index.ts",
  compatibility_date: "2026-10-01",
  observability: { enabled: true },
  kv_namespaces: [{ binding: "HOSTS", id: hostsKvId }],
  // 平台子域（`{slug}.<CRM_ROOT>`）**不在 host: 映射里**：按后缀取 slug 查这张表
  d1_databases: [
    { binding: "REGISTRY", database_name: "clever-vpn-registry-d1", database_id: registryD1 },
  ],
  vars: { ADMIN_ZONE: crmRoot },
  // 两条 route 缺一不可：
  //   · `*.CRM_ROOT/*` 是平台子域（租户后台域）——**曾经漏掉，部署即把整片租户后台解绑**；
  //   · `origin-crm.*` 是 CRM 自定义域的回源（originless 记录 + route）。
  routes: [
    { pattern: `*.${crmRoot}/*`, zone_name: crmRoot },
    { pattern: `origin-crm.${baseDomain}/*`, zone_name: baseDomain },
  ],
  services: deployed.map((n) => ({
    binding: `SHARD_${n}`,
    service: `clever-vpn-crm-saas-shard-${n}`,
  })),
};

writeFileSync(
  "wrangler.router.jsonc",
  `// ⚠️ 自动生成，不要提交。来源：cf-api 的 GET /platform/shards（shards_ready）\n${JSON.stringify(config, null, 2)}\n`,
);

console.error(`✔ router：绑定 ${deployed.length} 个分片（${deployed.join(", ")}）`);
