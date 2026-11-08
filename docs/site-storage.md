# 站点存储布局（R2 + KV）

Last updated: 2026-11-08
Status: `as-built`（本仓内部实现说明，**不是跨仓契约**）

> 写这份东西的是 `src/site/publish.ts`，读它的是 `workers/site/src/index.ts`
> （`site-serve`）—— **两个都在本仓**，所以按
> [`clever-vpn-docs/docs/contracts/README.md`](https://github.com/clever-vpn/clever-vpn-docs/blob/main/docs/contracts/README.md) §2 的规则，它不进契约目录。
>
> **若 `site-serve` 将来独立成仓，本页升格为契约**，届时迁到
> `clever-vpn-docs/docs/contracts/`。

## 1. R2：两个前缀，一个桶

桶名由 `wrangler.jsonc` 的 `SITES` 绑定决定（生产用 `clever-sites`，与 `site-serve`
共用同一个桶）。

```
g/templates/<模板>/<版本>/…           全局模板，一份，所有租户共享
sites/<租户>/versions/<n>/public/…    已发布的产物，按版本隔离
```

- **模板**由 `npm run site:template:upload` 上传（`scripts/upload-site-template.mjs`），
  现在固定是 `g/templates/basic/v1/`。
- **产物**由发布写入：把模板整体复制到 `sites/<租户>/versions/<n>/public/`，
  复制时做两件事（**只在发布时做，运行时不改**）：
  - `config.js` 重写成注入后的 `window.CRM_API_BASE`
  - 所有文本产物做 `{{site.*}}` 占位符替换（品牌设置烘焙，见下）
- **版本不可变**：写完就不再改。回滚 = 把指针指回旧 `n`，**不重建、不删除旧版本**。

## 2. KV：指针，只有一把

同一个 `HOSTS` namespace（与 cf-api 共用，见 `contracts/cf-api-hosting.md` §4）：

```
host:<hostname>        { tenant_id, slot, shard, status }   写：cf-api
site:<tenant>:active   { n }                                写：本仓发布
```

- `site-serve` 先读 `host:*` 拿到租户，再读 `site:*:active` 拿到版本号，最后拼
  R2 key `sites/<租户>/versions/<n>/public/<路径>`。
- **键前缀即所有权**：本仓只写 `site:*`，绝不写 `host:*`（那是 cf-api 的）。
- 指针缓存 5 秒 ⇒ 发布后最多 5 秒生效。

## 3. 版本号的权威在 D1，不在 KV

`site_versions(seq UNIQUE, template, template_version, files, bytes, created_by, created_at)`。

- `seq` 是 `MAX(seq)+1`，唯一索引挡住并发撞号（撞了就返回 `version_conflict`）
- 回滚前校验"这个 `n` 真实存在过"，防止指针指向从未发布的版本（那会 404 且难排查）
- 保留策略未实现（契约 `site-studio-crm.md` §9.3 定的是最近 30 版 + blob mark-and-sweep）

## 4. 品牌设置：发布时烘焙

`site_settings`（本仓 D1，单行）：`site_name` / `tagline` / `color` / `contact_email`
/ `footer_note`。

发布的替换表只有五个槽，**多一个都要先改契约**：

| 槽 | 来源 | 说明 |
|---|---|---|
| `{{site.name}}` | `site_name`，空则用兜底名 | 转义后写入 |
| `{{site.tagline}}` | `tagline` | 转义 |
| `{{site.color}}` | `color`（`#rrggbb`） | 不转义，需已校验 |
| `{{site.contact}}` | `contact_email` | 转义 |
| `{{site.footer}}` | `footer_note`，空则 `© <年> <站点名>` | 转义 |

产物里若残留**未定义**的 `{{site.xxx}}` ⇒ 发布直接失败（`template_token_unknown`），
不让它漏到线上。

## 5. 域名

- **`MODE=single`（自部署）**：域名不归本仓管。租户在 Cloudflare 里给 `site-serve`
  加 Custom Domain，并自己写 `KV[host:<域名>]`。
- **`MODE=multi`（SaaS）**：域名动作一律走 cf-api（它才持有云凭据）。cf-api 的
  三个端点（申请 / 查询状态 / 解绑）**尚未实现**，所以 `GET /api/admin/site/domain`
  在托管模式下如实返回 `available: false`。
