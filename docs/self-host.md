# 自托管指南

> 目标：租户用自己的 Cloudflare 账号，把 CRM 跑在自己的域名下。**Workers Free 即可启动**（D1 免费额度：5 GB 存储、500 万行读/天、10 万行写/天）。

## 前置

- Cloudflare 账号（免费即可）
- 一个域名（可以稍后再配；先用 `*.workers.dev` 也能跑）
- 一个 **cf-api 租户 API Token**（`cv_api_…`）——CRM 用它调平台接口

## 1. 准备

```bash
git clone https://github.com/clever-vpn/clever-vpn-crm.git
cd clever-vpn-crm
pnpm install            # 或 npm install
```

## 2. 建库

```bash
npx wrangler login
npx wrangler d1 create clever-vpn-crm
```

把输出的 `database_id` 填进 `wrangler.jsonc`（从 `wrangler.example.jsonc` 复制）。

## 3. 配置

```bash
npx wrangler secret put CF_API_TOKEN      # 租户 API Token
npx wrangler secret put SESSION_SECRET    # 随便一串长随机值（会话签名）
```

编辑 `wrangler.jsonc` 的 `vars`：

| 变量 | 说明 |
|---|---|
| `CRM_TENANT_ID` | 你在 cf-api 的租户 ID |
| `CF_API_BASE` | 默认 `https://api.clever-vpn.org`，自建平台时改这里 |
| `CRM_CODE_VERSION` | 可保持 `dev`（发布流水线会注入） |

## 4. 部署

```bash
npx wrangler deploy
```

首次访问任意业务路径时，Worker 会**自动建表**（schema 指纹），无需手工执行 SQL。

验证：

```bash
curl https://<your-worker>.workers.dev/health
curl https://<your-worker>.workers.dev/__version
```

## 5. 绑定域名（可选）

在你自己的 Cloudflare zone 里给这个 Worker 添加 **Custom Domain**（不是 route），
证书由 Cloudflare 自动签发。

## 6. 升级

```bash
git fetch --tags && git checkout vX.Y.Z
pnpm install && npx wrangler deploy
```

升级后第一个请求会自动把库迁移到新版本（迁移必须向后兼容；见 `src/migrations.ts` 顶部约束）。

## 7. 备份与迁移

- 快照：`npx wrangler d1 export clever-vpn-crm --remote --output backup.sql`
- Cloudflare 控制台的 D1 页面有 **Time Travel**（Free 7 天 / Paid 30 天）可回滚
- 想搬到我们的托管 CRM：把 `backup.sql` 交给我们导入即可（schema 同版本）

## 常见问题

| 现象 | 原因 |
|---|---|
| `D1_ERROR: no such table` | 首次请求还没触发迁移；访问一次 `/health` 之外的路径，或检查 `database_id` 是否正确 |
| 调用 cf-api 返回 401 | `CF_API_TOKEN` 不是租户 token，或已失效 |
| 调用 cf-api 返回 403 | 访问了未开 `apiAccess` 的模块；当前只有 `customers` 可用 |
| 激活码兑换失败 | 码就是 `customers.code`（16 位）；客户被冻结/过期会被 App 报 `CustomerFrozen`。语义见 `docs/contract.md` 指向的权威契约 |
