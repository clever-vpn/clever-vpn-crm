#!/usr/bin/env node
/**
 * 用 cf-api 的分片列表渲染 **router** 的部署配置。
 *
 * service binding 是部署期静态的 ⇒ 片数变了必须重新部署 router 才会多一条
 * `SHARD_<n>`。清单来源与 shard 部署同一个端点（`GET /platform/shards`），
 * 两份规则不存在。
 *
 * 输入：`GET /api/v2/platform/shards` 的原样 JSON（`shards[].deployed` 为真才绑）
 * 输出：`wrangler.router.jsonc`（gitignore）
 *
 * 必需环境变量：
 *   HOSTS_KV_ID   与 site-serve / shard 共用同一个 KV 命名空间
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
if (!hostsKvId) {
  console.error("✘ 缺 HOSTS_KV_ID");
  process.exit(1);
}

// 只绑「已部署」的片：没部署过的片绑上去，请求会被打到不存在的 service
const deployed = shards.filter((s) => s.deployed).map((s) => s.shard).sort((a, b) => a - b);

const config = {
  name: "clever-vpn-crm-router",
  main: "src/index.ts",
  compatibility_date: "2026-10-01",
  observability: { enabled: true },
  kv_namespaces: [{ binding: "HOSTS", id: hostsKvId }],
  services: deployed.map((n) => ({
    binding: `SHARD_${n}`,
    service: `clever-vpn-crm-saas-shard-${n}`,
  })),
};

writeFileSync(
  "wrangler.router.jsonc",
  `// ⚠️ 自动生成，不要提交。来源：cf-api 的 GET /platform/shards\n${JSON.stringify(config, null, 2)}\n`,
);

console.error(`✔ router：绑定 ${deployed.length} 个分片（${deployed.join(", ") || "无"}）`);
if (deployed.length === 0) {
  console.error("⚠️ 一个片都没有 ⇒ router 会把所有后台域返回 404（先部署 shard-0）");
}
