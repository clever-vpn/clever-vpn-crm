#!/usr/bin/env node
/**
 * 把仓库里的 `wrangler.jsonc` 渲染成 `wrangler.ci.jsonc`。
 *
 * 为什么需要这一步：`wrangler.jsonc` 不支持环境变量占位符，而 fork 之后
 * D1 的 `database_id` 与租户参数只能来自 GitHub 的 Secrets / Variables。
 * CI 里先渲染一份临时配置再 `wrangler deploy --config wrangler.ci.jsonc`。
 *
 * 用法（通常由 `.github/workflows/deploy.yml` 调用；本地排障也可用）：
 *
 *   D1_DATABASE_ID=xxxx CRM_TENANT_ID=12 \
 *   CLOUDFLARE_API_TOKEN=... npx wrangler deploy --config wrangler.ci.jsonc
 *
 * 必需：`D1_DATABASE_ID`、`CRM_TENANT_ID`
 * 可选：`WORKER_NAME`、`D1_NAME`、`CF_API_BASE`、`CRM_CODE_VERSION`、
 *       `CRM_CONTRACT_VERSION`
 *
 * 这个文件里**没有也不应该有**任何密钥；token 一律走 `wrangler secret put`。
 */
import { readFileSync, writeFileSync, existsSync } from "node:fs";

const TEMPLATES = ["wrangler.jsonc", "wrangler.example.jsonc"];
const OUT = "wrangler.ci.jsonc";

const DEFAULTS = {
  WORKER_NAME: "clever-vpn-crm",
  D1_NAME: "clever-vpn-crm",
  CF_API_BASE: "https://api.clever-vpn.org",
  CRM_CONTRACT_VERSION: "1",
  CRM_CODE_VERSION: (process.env.GITHUB_SHA ?? "").slice(0, 7) || "ci",
};

const REQUIRED = ["D1_DATABASE_ID", "CRM_TENANT_ID"];

const value = (key) => {
  const raw = process.env[key];
  return raw !== undefined && raw !== "" ? raw : DEFAULTS[key];
};

const missing = REQUIRED.filter((key) => !value(key));
if (missing.length > 0) {
  console.error(
    `[render-config] 缺少必需的环境变量：${missing.join(", ")}\n` +
      `  在 GitHub 仓库 Settings → Secrets and variables → Actions 里配置：\n` +
      `    Variables: CRM_TENANT_ID, CLOUDFLARE_ACCOUNT_ID, D1_NAME(可选), WORKER_NAME(可选)\n` +
      `  其中 D1_DATABASE_ID 由部署工作流自动解析/创建后注入。`,
  );
  process.exit(1);
}

const template = TEMPLATES.find((file) => existsSync(file));
if (!template) {
  console.error(`[render-config] 找不到配置模板：${TEMPLATES.join(" / ")}`);
  process.exit(1);
}

let source = readFileSync(template, "utf8");

/** 只替换同名键的字符串值，避免误伤注释里的同名文字。 */
function setString(jsKey, replacement) {
  const re = new RegExp(`("${jsKey}"\\s*:\\s*)"[^"]*"`);
  if (!re.test(source)) {
    console.warn(`[render-config] 模板里没有键 ${jsKey}，已跳过`);
    return;
  }
  source = source.replace(re, `$1${JSON.stringify(replacement)}`);
}

setString("name", value("WORKER_NAME"));
setString("database_name", value("D1_NAME"));
setString("database_id", value("D1_DATABASE_ID"));
// 本地模板指向 migrations-dev（reset 脚本生成的临时链）；
// CI 用生产链，必须在渲染时改回来。
setString("migrations_dir", "migrations");
setString("CRM_TENANT_ID", value("CRM_TENANT_ID"));
setString("CF_API_BASE", value("CF_API_BASE"));
setString("CRM_CODE_VERSION", value("CRM_CODE_VERSION"));
setString("CRM_CONTRACT_VERSION", value("CRM_CONTRACT_VERSION"));

writeFileSync(OUT, source);

console.log(
  `[render-config] ${template} → ${OUT}\n` +
    `  worker=${value("WORKER_NAME")} d1=${value("D1_NAME")} ` +
    `tenant=${value("CRM_TENANT_ID")} api=${value("CF_API_BASE")} ` +
    `code=${value("CRM_CODE_VERSION")}`,
);
