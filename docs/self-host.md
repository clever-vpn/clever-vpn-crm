# 自托管指南

> 🤖 **用 agent 自动实施**：本仓库内置 skill `.github/skills/white-label-crm/SKILL.md`。
> 在 fork 里对 Copilot 说「按 white-label-crm skill 部署」，它会带你配完
> Secrets/Variables、跑 `deploy` 工作流并用 `/__version` 验收。
>
> **保证边界**：只保证缺省配置（只改 GitHub 里的 Secrets/Variables）下的部署正确。

> 目标：租户用自己的 Cloudflare 账号，把 CRM 跑在自己的域名下。**Workers Free 即可启动**（D1 免费额度：5 GB 存储、500 万行读/天、10 万行写/天）。

## 前置

- Cloudflare 账号（免费即可）
- 一个域名（可以稍后再配；先用 `*.workers.dev` 也能跑）
- 一个 **cf-api 租户 API Token**（`cv_api_…`）——CRM 用它调平台接口

## 0. 为什么必须走 CI

**部署只有一条路径：GitHub Actions。** 不要在本地 `git clone` 后 build/deploy。

理由：租户大多是"不懂 Cloudflare 的运营者"，本地环境（Node 版本、wrangler 版本、
Cloudflare 登录态）每次都能踩坑；而 CI 是**可复现、可审计、可升级**的：
参数存在仓库里，谁点的、什么时候点的、部署了哪个 commit 都有记录。

本地只用于开发：`npm run dev` 起一个 `wrangler dev`（端口 8788）。

## 1. Fork

Fork `clever-vpn/clever-vpn-crm`。**建议设为 Private**（仓库里会出现你的租户参数），
Private fork 的 Actions 消耗你自己的分钟数（Free 额度 2000 分钟/月，CRM 一次部署约
1 分钟）。

## 2. 配置 Secrets / Variables

仓库 → **Settings → Secrets and variables → Actions**：

Secrets（加密，不可读回）：

| 名称 | 内容 |
|---|---|
| `CLOUDFLARE_API_TOKEN` | Cloudflare API Token，权限：**Workers Scripts:Edit** + **D1:Edit**（+ Account Settings:Read） |
| `CF_API_TOKEN` | cf-api 租户 API Token（`cv_api_…`） |
| `SESSION_SECRET` | 随便一串 ≥32 字符的随机值（会话签名）；换掉 = 所有用户重新登录 |
| `SETUP_TOKEN` | 管理后台首次初始化口令（`openssl rand -hex 24`）；不配则不能初始化管理员 |
| `RESEND_API_KEY` | 发信服务商 API key（与 `EMAIL` 绑定二选一，见下方"邮件"一节） |

Variables（明文）：

| 名称 | 必填 | 说明 |
|---|---|---|
| `CRM_TENANT_ID` | ✅ | 你在 cf-api 的租户 ID。**为空则 deploy 工作流整体跳过** |
| `CLOUDFLARE_ACCOUNT_ID` | ✅ | Cloudflare 账号 ID |
| `CF_API_BASE` | – | 默认 `https://api.clever-vpn.org`，自建平台时改这里 |
| `D1_NAME` | – | 默认 `clever-vpn-crm` |
| `WORKER_NAME` | – | 默认 `clever-vpn-crm` |
| `EMAIL_FROM` | – | 发信人地址（如 `noreply@your-domain.com`，域名需验证）；**与传输一起才算"邮件就绪"** |

> `CLOUDFLARE_API_TOKEN` 建议单独建一把、只给这个仓库用；它是"能改你 Cloudflare
> 账号"的密钥，不要复用主账号 token。

## 2.5 邮件（App 登录的前提）

**App 是无密码登录（只有邮箱验证码）⇒ 没配邮件，用户就无法注册/登录。**
所以这一节实际上不是可选项：

| 事项 | 配了 | 没配 |
|---|---|---|
| App 用户登录 | ✅ | ❌ `503 email_unavailable` |
| 管理后台登录 | 密码 **或** 邮箱验证码 | 只有密码 |
| 忘记后台密码 | 邮箱验证码自助重置 | 用 Cloudflare 账号进 D1 重置（`docs/admin.md` §4） |

两种传输二选一（**不需要额外开关，配置即生效**）：

1. **Cloudflare Email Service**：`wrangler.jsonc` 加 `send_email` 绑定，并设 `EMAIL_FROM`；
2. **Resend**：设 `RESEND_API_KEY`（secret）+ `EMAIL_FROM`。

配置完打开 **设置 → 邮件发送 → 发送测试邮件** 验一下——
"配了 binding"不等于"能发"（域名未验证、额度耗尽都会失败）。

## 3. 跑一次 deploy

Actions → **deploy** → **Run workflow**（`main` 分支）。

工作流做的事（全部在 CI 里，你不需要本地执行任何命令）：

1. `npm ci` → `npm run typecheck` → `npm test`；
2. `wrangler d1 list` 找 `D1_NAME`，**不存在就 `wrangler d1 create`**（幂等）；
3. `node scripts/render-config.mjs` 把 D1 id 与租户参数渲染进 `wrangler.ci.jsonc`；
4. `wrangler deploy --config wrangler.ci.jsonc`；
5. `wrangler secret put CF_API_TOKEN / SESSION_SECRET`；
6. 在 run 的 Summary 里打印 Worker URL 与验证命令。

因为第 4 步先于第 5 步，**首次部署后要再跑一次**（或等 secrets 生效后调用一次业务
路径）。正常升级时 secrets 已存在，一次即可。

验证：

```bash
curl -s https://<worker>.workers.dev/health      # {"status":"ok"}
curl -s https://<worker>.workers.dev/__version   # code/contract/tenant
```

`tenant` 必须等于你在 cf-api 的租户 ID；不等于是 Variables 没生效。

建管理员：打开 `https://<worker>.workers.dev/admin/`，用 `SETUP_TOKEN` + 邮箱 + 密码（≥12 位）
创建唯一的管理员账号；之后可自行开启 TOTP 两步验证。若忘记密码/丢失 2FA，见
[`docs/admin.md`](admin.md) §4（用 Cloudflare 账号直接改 D1）。

建表由 deploy 工作流里的 `wrangler d1 migrations apply --remote` 完成（先迁移、再部署），
无需手工执行 SQL。


## 4. 绑定域名（可选）

在你自己的 Cloudflare zone 里给这个 Worker 添加 **Custom Domain**（不是 route），
证书由 Cloudflare 自动签发。

## 5. 升级

同步上游仓库后 merge 到 `main`（或在 Actions 里对 `main` 重跑 **deploy**）。
**不要**在本地 deploy：CI 会用同一套参数、同一份渲染逻辑重新部署。

升级时工作流会先应用增量迁移（迁移必须向后兼容；见 `migrations/`
顶部约束）。

## 6. 备份与迁移

- 快照（在本地可执行，只是只读导出）：
  `npx wrangler d1 export clever-vpn-crm --remote --output backup.sql`
- Cloudflare 控制台的 D1 页面有 **Time Travel**（Free 7 天 / Paid 30 天）可回滚
- 想搬到我们的托管 CRM：把 `backup.sql` 交给我们导入即可（schema 同版本）

## 常见问题

| 现象 | 原因 |
|---|---|
| deploy 工作流一直 **skipped** | 没配 Variable `CRM_TENANT_ID`（空值即跳过） |
| `Authentication error` / `Authentication failed` | `CLOUDFLARE_API_TOKEN` 缺 **D1:Edit** 或 **Workers Scripts:Edit** |
| `A worker with this name already exists` | `WORKER_NAME` 被别的项目占用；换一个名字 |
| 部署成功但 `/__version` 里 `tenant` 是 `0` | Variables 没配或工作流用了旧 run；重新 Run workflow |
| 业务接口 401 / 502 | Worker secrets 没写入（首次部署需再跑一次，或检查 `CF_API_TOKEN`） |
| `D1_ERROR: no such table` | 首次请求还没触发迁移；访问一次 `/health` 之外的路径，或检查 D1 是否绑到了正确的 `database_id` |
| 调用 cf-api 返回 401 | `CF_API_TOKEN` 不是租户 token，或已失效 |
| 调用 cf-api 返回 403 | 访问了未开 `apiAccess` 的模块；当前只有 `customers` 可用 |
| 激活码兑换失败 | 码就是 `customers.code`（16 位）；客户被冻结/过期会被 App 报 `CustomerFrozen`。语义见 `docs/contract.md` 指向的权威契约 |

## 附：不用 CI 的等价命令（仅排障用）

CI 挂掉又急着上线时才这么干，事后请把参数补回 Variables，否则下次 CI 会盖掉：

```bash
npm ci
npx wrangler d1 create clever-vpn-crm     # 已存在会报错，忽略
D1_DATABASE_ID=<uuid> CRM_TENANT_ID=<id> node scripts/render-config.mjs
npx wrangler deploy --config wrangler.ci.jsonc
printf '%s' "$CF_API_TOKEN"   | npx wrangler secret put CF_API_TOKEN   --config wrangler.ci.jsonc
printf '%s' "$SESSION_SECRET" | npx wrangler secret put SESSION_SECRET --config wrangler.ci.jsonc
```

