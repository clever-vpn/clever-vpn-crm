# Clever VPN CRM

> 开源的租户 CRM（White-label customer portal）—— **独立产品**，与 cf-api 平台解耦。

终端用户在你的 CRM 里注册/登录/付费，CRM 通过**租户 API Token** 调 cf-api 完成：
建账号 → 签发激活码 → 查询订阅与许可。App 拿到激活码后直接向 cf-api 换取设备许可，
**不经过 CRM**。

```
终端用户 ──注册/付费──▶ 本 CRM ──租户 API Token──▶ cf-api（SaaS 平台）
   │                                                   ▲
   └──下载 App──▶ clever-vpn-app ──激活码──▶ 许可 ─────┘
```

## 它不是什么

- **不是** cf-api 的模块，cf-api 不认识 CRM；
- **不碰租户的钱**：支付走租户自己的商户号（支付适配器可插拔）；
- **不存 cf-api 的客户数据**：只保存"终端用户 ↔ 激活码 ↔ 订阅状态"。

## 自托管（Workers Free 即可）

```bash
pnpm install
npx wrangler d1 create clever-vpn-crm          # 记下 database_id
cp wrangler.example.jsonc wrangler.jsonc       # 填入 database_id
npx wrangler secret put CF_API_TOKEN           # 租户 API Token（cv_api_…）
npx wrangler deploy
```

首次请求时 Worker 会**自动建表/迁移**（schema 指纹），无需手工执行 SQL。

## 托管形态

同一份代码（release 里的 `crm-worker.mjs`）由 [clever-vpn-crm-saas](../clever-vpn-crm-saas)
上传到 Workers for Platforms 的 dispatch namespace，每个租户一个 user Worker + 一个 D1。
托管侧不含任何业务代码，详见该仓库 README。

## 目录

```
src/index.ts          Worker 入口（/health、/__version，其余待实现）
src/db.ts             自迁移（schema 指纹）
src/migrations.ts     迁移定义（随代码发布）
docs/contract.md      契约指针（正文在 clever-vpn-docs/docs/contracts/）
docs/self-host.md     自托管部署指南
```

## License

AGPL-3.0（见 `LICENSE`）。
