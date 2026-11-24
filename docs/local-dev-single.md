# 本地联调：single 模式 CRM + 线上 cf-api（localhost:5181，无需 Caddy）

> **给其它会话：** 只想在本机启动 CRM、调线上 cf-api、不配 Caddy/域名/shard，
> 直接看本文；一键命令 `npm run dev:local`。不要走发布。

## 0. TL;DR

```bash
npm run db:reset      # 首次或想重置本地 D1
npm run dev:local     # 起 Vite(5181) + wrangler dev(8788)
# 打开 http://localhost:5181/admin/
```

本地管理员（`db:reset` 种子）：`ops@example.com` / `crm-admin-2026`。

首次登录后到「设置 → cf-api 对接」：

- 基址：`https://api.clever-vpn.org`
- token：本租户的 `cv_api_…`
- 点「测试连接」

## 1. `.dev.vars`（本机，gitignored）

```ini
CF_API_BASE=https://api.clever-vpn.org
APP_SECRET=<本机已有主密钥>
SETUP_TOKEN=dev-setup-token-1234
# 不要设 MODE=multi；默认 single
```

- 不要提交 `.dev.vars`。
- `APP_SECRET` 用本机已有的值；本地 D1 里的 token 只由它加密。
- 如果 `CF_API_BASE` 还是 `http://127.0.0.1:8899`（fake cf-api），启动脚本会提示，
  但不会自动改。

## 2. 启动方式

### 2.1 一键（推荐）

```bash
npm run dev:local
```

脚本会：

- 检查 `node_modules`、`.dev.vars`；
- `web/dist` 不存在时先跑 `npm run build:web`；
- 起 Vite `localhost:5181` 和 Worker `127.0.0.1:8788`；
- 等两个端口就绪后打印后台地址；
- Ctrl+C 同时停两个进程。

**AI 配置助手默认连线上网关 `studio`**（与 site-studio 一致；AI binding 没有本地模拟，
`wrangler dev` 会把请求代理到 Cloudflare）。所以本机需要先：

```bash
npx wrangler login      # scope 要含 ai (write)
# 或 export CLOUDFLARE_API_TOKEN=... CLOUDFLARE_ACCOUNT_ID=...
```

想分开开发期的账/日志：`CLOUDFLARE_GATEWAY_ID=studio-dev npm run dev:local`
（同账号建 `studio-dev` 网关并配 DeepSeek BYOK）；`CLOUDFLARE_GATEWAY_ID= npm run dev:local`
关闭 AI（面板显示未配置）。线上网关的调用会真花钱、真写网关日志。

默认模型是 `deepseek/deepseek-flash`，走 **provider-native + 网关 BYOK**：
用你自己的 DeepSeek 账号即可，不需要 Cloudflare Unified Billing credits。
要换模型显式指定即可，例如
`CLOUDFLARE_AI_MODEL=deepseek/deepseek-chat npm run dev:local`。

日志：

```txt
/tmp/crm-single-web.log
/tmp/crm-single-worker.log
```

### 2.2 手动两个终端

```bash
# 终端 A：管理后台 Vite（HMR，5181；/api 代理到 8788）
npm run dev:web

# 终端 B：CRM Worker（本地 D1，8788）
./node_modules/.bin/wrangler dev --port 8788
```

打开：

```txt
http://localhost:5181/admin/
```

- 不需要 Caddy，不需要 `/etc/hosts`，不需要 `crm.clever-vpn.org`；
- Vite 的 `/api` 代理到 8788，同源、Cookie、CSRF 都正常；
- UI 改动 → Vite HMR；
- `src/` Worker 改动 → wrangler 自动重载。

## 3. 这个模式能测什么

- 客户、订单、套餐、支付网关、促销、设置等 **非域名** CRM 功能。
- **AI 配置助手**：接口配置 → AI 面板 → 粘贴文档 → 生成 → 预览 → 应用。
  默认走线上网关 `studio`（`metadata.tenant` 取 `CRM_TENANT_ID`，本地默认 `0`）；
  换 `studio-dev` 可把开发消耗/日志与生产分开。
- 本地 D1 存 CRM 自己的数据；cf-api 调用走线上。

**域名页不可用**：`MODE=single` 下 `/api/admin/domains` 返回 `supported:false`，
页面只显示自部署说明。需要测试域名功能时用 multi 环境，不走这个入口。

## 4. 安全边界

- 本地是 single 模式：CRM 数据只写本地 D1，**不读写生产 D1**。
- 线上 cf-api 是真实系统：建客户、改余额、落账等写操作会写 tenant 的平台数据；
  测试用测试客户/测试单，不要动真实客户。
- token 只在 `.dev.vars` / 本地 D1，不提交、不打印。
- 全程不触发 GitHub Actions/部署；需要发布时再走 PR。

## 5. 故障排查

| 现象 | 处理 |
|---|---|
| `5181` / `8788` 被占用 | 停掉旧进程；脚本会直接报端口冲突 |
| 页面 502 / 接口失败 | 看 `/tmp/crm-single-worker.log`；Vite 是否在 5181 |
| `CF_API_BASE` 仍是 8899 | `.dev.vars` 改成 `https://api.clever-vpn.org` |
| 设置页提示“未配置 cf-api 凭据” | 按 §0 填 base/token 并保存 |
| 想重置本地数据 | `npm run db:reset`（会清空本地 D1） |
| 域名页只有说明 | 预期行为；single 模式不支持托管域名 |
| `wrangler dev` 报 `Failed to start the remote proxy session` / 要求 `CLOUDFLARE_API_TOKEN` | AI binding 没有本地模拟：`npx wrangler login`（scope 含 `ai (write)`）或导出 token；不想连 AI 也要登录，因为 binding 是 remote |
| AI 面板显示未配置 | `CLOUDFLARE_GATEWAY_ID` 为空；用默认/`studio-dev` 启动，或检查 `wrangler.jsonc` |
| AI 生成报 `ai_upstream_error` | 网关不存在或没配 DeepSeek BYOK（`default` 别名）；到 Cloudflare → AI Gateway 检查 |

## 6. 不做

- 不启动 Caddy、不改 hosts；
- 不做 multi/shard/HOSTS/DB_0；
- 不发布、不触发 CI。
