#!/usr/bin/env node
/**
 * 渲染 **site-serve** 的部署配置（`wrangler.site.jsonc`，gitignore）。
 *
 * 为什么要渲染：同一个 Worker 在两种部署下绑定不同——
 *   · 自托管：只有 KV + R2，没有 registry（平台子域不适用）；
 *   · SaaS：多一个 `REGISTRY`，用来把 `{slug}.<SITE_ZONE>` 解析成租户。
 * 另外 `routes` 也在这里写死，**路由不再手工加**：`*.SITE_ROOT/*` 是平台子域，
 * `origin-site.<base>` 是自定义域的回源（Cloudflare for SaaS 的 fallback origin）。
 *
 * 必需环境变量（SaaS）：
 *   HOSTS_KV_ID / SITES_BUCKET / REGISTRY_D1_ID / SITE_ZONE / ADMIN_ZONE / SITE_ROOT
 * 可选：
 *   BASE_DOMAIN（默认 clever-vpn.org）—— 只用于 origin-site 这条 custom domain
 *   PLATFORM_VERSION（默认 dev）
 */
import { writeFileSync } from "node:fs";

const env = process.env;
const need = (name) => {
  const v = String(env[name] ?? "").trim();
  if (!v) {
    console.error(`✘ 缺 ${name}`);
    process.exit(1);
  }
  return v;
};

const hostsKvId = need("HOSTS_KV_ID");
const sitesBucket = String(env.SITES_BUCKET ?? "clever-sites").trim();
const registryD1 = need("REGISTRY_D1_ID");
const siteZone = need("SITE_ZONE");
const adminZone = need("ADMIN_ZONE");
const siteRoot = need("SITE_ROOT");
const baseDomain = String(env.BASE_DOMAIN ?? "clever-vpn.org").trim();
const version = String(env.PLATFORM_VERSION ?? "dev").trim();

const config = {
  name: "site-serve",
  // `main` 相对配置文件（仓库根），不是相对脚本
  main: "workers/site/src/index.ts",
  compatibility_date: "2026-10-01",
  observability: { enabled: true },
  workers_dev: false,
  // 路由进配置：平台子域通配 + 自定义域回源（都已存在，声明式重述）
  routes: [
    { pattern: `*.${siteRoot}/*`, zone_name: siteRoot },
    { pattern: `origin-site.${baseDomain}`, custom_domain: true },
  ],
  kv_namespaces: [{ binding: "HOSTS", id: hostsKvId }],
  d1_databases: [
    { binding: "REGISTRY", database_name: "clever-vpn-registry-d1", database_id: registryD1 },
  ],
  r2_buckets: [{ binding: "SITES", bucket_name: sitesBucket }],
  vars: { SITE_ZONE: siteZone, ADMIN_ZONE: adminZone, PLATFORM_VERSION: version },
};

writeFileSync(
  "wrangler.site.jsonc",
  `// ⚠️ 自动生成，不要提交。由 scripts/render-site-config.mjs 产出。\n${JSON.stringify(config, null, 2)}\n`,
);
console.error(
  `✔ site-serve：KV=${hostsKvId.slice(0, 8)}… 桶=${sitesBucket} registry=${registryD1.slice(0, 8)}… ` +
    `zone=${siteZone} root=${siteRoot} version=${version}`,
);
