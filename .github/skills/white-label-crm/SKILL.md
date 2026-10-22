---
name: white-label-crm
description: **WORKFLOW SKILL** — 把 clever-vpn-crm fork 到自己的 Cloudflare 账号并用 GitHub Actions 部署上线。USE FOR: 部署/升级 CRM、`deploy` 工作流 skipped 或报 `Authentication error`、`/__version` 里 tenant 不对、不知道要配哪些 Secrets/Variables、想给 CRM 绑自定义域名、D1 建库/备份。DO NOT USE FOR: 改 CRM 业务代码（那是改项目本身）、App 出包（用 `white-label-app`）、cf-api 平台侧配置、契约正文（在 clever-vpn-docs）。INVOKES: GitHub 仓库 Settings、Actions 工作流、`curl` 验证、`wrangler d1 export`。
---

# 白标 CRM 部署（租户视角）

目标：**fork → 配 Secrets/Variables → 点 Run workflow**。不需要本地装 Node、
wrangler，也不需要登录 Cloudflare。本地只用于开发调试（`npm run dev`）。

## 0. 保证边界

我们只保证**缺省配置**（只改 GitHub 里的 Secrets/Variables）下的部署正确性。
改 `src/` 属于修改项目本身，后果自负。

**部署只有一条路径：GitHub Actions。** 不要本地 `wrangler deploy`（会盖掉 CI 下次
部署的参数，且没人知道你改了什么）。

## 1. 前置：先在 cf-api 注册租户

CRM 自己的数据存 D1，客户/激活码存在 **cf-api**（CRM 通过租户 API Token 调它）。
所以顺序是先有租户，再部署 CRM：

1. 在 cf-api 面板注册租户，记下 **租户 ID**（数字）；
2. 为该租户生成 **API Token**（`cv_api_…`）——它能读写 `customers` 模块；
3. 准备 Cloudflare 账号（Workers Free 足够）与账号 ID。

## 2. Fork

Fork `clever-vpn/clever-vpn-crm`。public / private 由你决定（public 的 Actions 免费
不限量，private 消耗你自己的分钟数）。

## 3. 配 Secrets / Variables

仓库 → **Settings → Secrets and variables → Actions**：

Secrets（加密，写进去就看不到）：

| 名称 | 内容 |
|---|---|
| `CLOUDFLARE_API_TOKEN` | 权限：**Workers Scripts:Edit** + **D1:Edit**（+ Account Settings:Read） |
| `CF_API_TOKEN` | cf-api 租户 Token（`cv_api_…`） |
| `SESSION_SECRET` | ≥32 字符随机串（会话签名）；换掉 = 所有用户重新登录 |
| `SETUP_TOKEN` | 管理后台初始化口令（`openssl rand -hex 24`）；不配就无法创建管理员 |

Variables（明文）：

| 名称 | 必填 | 默认 | 说明 |
|---|:--:|---|---|
| `CRM_TENANT_ID` | ✓ | – | 你的 cf-api 租户 ID；**为空则部署工作流整体跳过** |
| `CLOUDFLARE_ACCOUNT_ID` | ✓ | – | Cloudflare 账号 ID |
| `CF_API_BASE` | ✗ | `https://api.clever-vpn.org` | 自建平台时改 |
| `D1_NAME` | ✗ | `clever-vpn-crm` | D1 库名（可同时当实例名用） |
| `WORKER_NAME` | ✗ | `clever-vpn-crm` | Worker 名；名字被占用就换 |

> `CLOUDFLARE_API_TOKEN` 能改你的 Cloudflare 账号，务必单独建一把、只给这个仓库
> 用，不要复用主账号 token。

## 4. 部署

Actions → **deploy** → **Run workflow**。工作流会自动：

1. `npm ci` → `typecheck` → `test`；
2. 找 D1（不存在就 `d1 create`，幂等）；
3. 渲染 `wrangler.ci.jsonc`（D1 id + 租户参数注入，仓库里不含密钥）；
4. `wrangler deploy`；
5. 写入 Worker secrets（`CF_API_TOKEN` / `SESSION_SECRET`）；
6. 在 run 的 **Summary** 里打印 Worker URL 与验证命令。

因为"先部署后写 secrets"，**首次部署建议再跑一次**（或等 secrets 生效后访问一次业
务路径）。

验证：

```bash
curl -s https://<worker>.workers.dev/health      # {"status":"ok"}
curl -s https://<worker>.workers.dev/__version   # code / contract / tenant
```

`tenant` 必须等于你的租户 ID；是 `0` 说明 Variables 没生效（重新 Run workflow）。

建管理员：打开 `https://<worker>.workers.dev/admin/`，用 `SETUP_TOKEN` + 邮箱 + 密码（≥12 位）
创建唯一管理员账号，然后可在「设置」里开启 TOTP 两步验证。
忘记密码 / 丢了 2FA / 账号被锁：用 Cloudflare 账号直接改 D1（步骤与 SQL 见
`docs/admin.md` §4），**不需要也不存在 `/recover` 接口**。

首次访问业务路径会自动建表（schema 指纹），不用手工执行 SQL。

## 5. 绑定域名（可选）

在你的 Cloudflare zone 里给这个 Worker 加 **Custom Domain**（不是 Route），证书自
动签发。加完后业务地址就是 `https://crm.你的域名`，这个值稍后要填进 App 的
`brand.json.crm_base`（契约 §4，待落地）。

## 6. 升级

同步上游仓库 → merge 到 `main`（或在 Actions 里对 `main` 重跑 **deploy**）。
首个请求会自动把库迁移到新版本（迁移必须向后兼容，见 `src/migrations.ts` 顶部）。

只改配置不动代码的话，同步上游通常零冲突。

## 7. 备份

```bash
npx wrangler d1 export <D1_NAME> --remote --output backup.sql
```

D1 控制台还有 Time Travel（Free 7 天 / Paid 30 天）可回滚。这一步在本地执行属于只
读导出，不算"本地部署"。

## 8. 常见失败

| 现象 | 原因 / 处理 |
|---|---|
| 工作流一直 **skipped** | 没配 Variable `CRM_TENANT_ID`（空值即跳过） |
| `Authentication error` / `Authentication failed` | `CLOUDFLARE_API_TOKEN` 缺 **D1:Edit** 或 **Workers Scripts:Edit** |
| `A worker with this name already exists` | `WORKER_NAME` 被占；换名 |
| `/__version` 里 `tenant` 是 `0` | Variables 没配，或看的是旧一次 run 的地址 |
| 业务接口 401 / 502 | Worker secrets 没写入（首次需再跑一次，或 `CF_API_TOKEN` 失效） |
| `D1_ERROR: no such table` | 首次请求未触发迁移；访问一次 `/health` 之外的路径；或 D1 绑错 |
| cf-api 返回 403 | 访问了未开 `apiAccess` 的模块；当前只有 `customers` 可用 |

## 9. 交付核对

- [ ] `/health` 返回 `{"status":"ok"}`
- [ ] `/__version` 的 `tenant` = 你的租户 ID
- [ ] 自定义域名（可选）能访问并签发证书
- [ ] 备份命令跑通一次，知道备份在哪
- [ ] 未修改 `src/`（否则自己负责同步上游）
