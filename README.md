# Clever VPN CRM

> 开源的租户 CRM（White-label customer backend）—— **独立产品**，与 cf-api 平台解耦。

终端用户在 **App** 里注册/登录/付费；账号、订单与订阅由本 CRM 承载。CRM 通过**租户 API Token** 调 cf-api 完成：
建账号 → 签发激活码 → 查询订阅与许可。App 拿到激活码后直接向 cf-api 换取设备许可，
**许可不经过 CRM**。

```
终端用户 ──下载──▶ App ──注册/付费──▶ 本 CRM ──租户 API Token──▶ cf-api
                    │                                              │
                    │◀────────────── 激活码 ───────────────────────┘
                    └──激活码──▶ cf-api ──▶ 设备许可 ──▶ 连接 VPN
```

用户只面对一个 App，不需要知道 CRM / cf-api 的存在。
登录成功时 App 同时拿到 `crm_token`（会话）与 `platform_token`（= 激活码），**登录即持码**；
激活码用户既看不到也不需要输入/保管，退出登录时两者一起删除。

## 它不是什么

- **不是** cf-api 的模块，cf-api 不认识 CRM；
- **不是**面向终端用户的网站：没有 App 的品牌里，用户拿不到登录/收银台页面 —— 这些流程都在 App 内（见 `docs/contract.md` 指向的 `app-crm.md`）；
- **不碰租户的钱**：支付走租户自己的商户号（支付适配器可插拔）；
- **不存 cf-api 的客户数据**：只保存"终端用户 ↔ 激活码 ↔ 订阅状态"。

## 自托管（fork + CI，Workers Free 即可）

**部署只走 GitHub Actions，不在本地 build / deploy。**

1. Fork 本仓库。
2. Settings → Secrets and variables → Actions 里配：

| 类型 | 名称 | 说明 |
|---|---|---|
| Secret | `CLOUDFLARE_API_TOKEN` | Workers Scripts:Edit + D1:Edit |
| Secret | `CF_API_TOKEN` | cf-api 租户 token（`cv_api_…`） |
| Secret | `SESSION_SECRET` | 随便一串长随机值（会话签名） |
| Variable | `CRM_TENANT_ID` | 你在 cf-api 的租户 ID（**必填**，为空则跳过部署） |
| Variable | `CLOUDFLARE_ACCOUNT_ID` | Cloudflare 账号 ID |
| Variable | `D1_NAME` / `WORKER_NAME` / `CF_API_BASE` | 可选，有默认值 |

3. Actions → **deploy** → Run workflow。首次会自动 `wrangler d1 create`，
   并用 `scripts/render-config.mjs` 把参数渲染进 `wrangler.ci.jsonc` 再部署。
4. 打开输出的 `https://<worker>.workers.dev/__version` 核对 `tenant` / `code`。

部署与**数据库迁移**都由 GitHub Actions 执行（deploy 工作流先 `wrangler d1 migrations apply`
再部署），无需手工执行 SQL。

本地只用于开发：`npm run dev`（或工作区任务 `crm: dev`），**不要本地 deploy**。

详细步骤与排障见 [`docs/self-host.md`](docs/self-host.md)。

## 托管形态

同一份代码（release 里的 `crm-worker.mjs`）由 [clever-vpn-crm-saas](../clever-vpn-crm-saas)
上传到 Workers for Platforms 的 dispatch namespace，每个租户一个 user Worker + 一个 D1。
托管侧不含任何业务代码，详见该仓库 README。

## 目录

```
src/index.ts          Worker 入口（/health、/__version、/api/* 路由）
src/admin/            管理后台 API（认证 / 2FA / 会话 / 审计）
src/db.ts             数据库就绪探测（迁移由 CI 执行）
src/db/schema.ts      Drizzle schema（表结构的唯一来源）
migrations/           生产迁移链（drizzle-kit 生成，CI 应用）
migrations-dev/       开发迁移链（reset 脚本生成，不入库）
web/                  管理后台 SPA（React + Vite，产物 web/dist/admin）
site-template/       官网静态站模板（独立部署，不进 CRM 构建；见其 README）
docs/admin.md         管理后台说明（认证、初始化、恢复、API）
docs/contract.md      契约指针（正文在 clever-vpn-docs/docs/contracts/）
docs/domain.md        领域模型（客户 / 订单 / 订阅 / 退款 / 礼品包）
docs/payments.md      支付域（词表 / 状态机 / 网关与映射）
docs/schema.md        表结构（Drizzle + D1，字段/索引/迁移）
docs/plans.md         套餐模型与残值换购（销售策略的唯一出处）
docs/promotion.md     促销（两层模型 + 必要性判断 + 不做什么）
docs/local-dev.md     本地联调环境（crm/app-web 域名 + 反代 + 验证码回显）
docs/self-host.md     自托管部署指南
```

## License

AGPL-3.0（见 `LICENSE`）。
