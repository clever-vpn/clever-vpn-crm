# 站点存储布局（R2 + KV）

Last updated: 2026-11-10
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
g/templates/<模板>/<版本>/…           全局模板（公共模板），一份，所有租户共享
tpl/<sha256>/…                        租户模板包的**内容寻址**存储（studio 交付）
  files/<包内路径>                    包里的静态文件
  manifest.json                       包清单（契约 site-studio-crm.md §4.1）
sites/<租户>/versions/<n>/public/…    已发布的产物，按版本隔离
```

- **模板**由 `npm run site:template:upload` 上传（`scripts/upload-site-template.mjs`），
  现在固定是 `g/templates/basic/v1/`。
- **产物**由发布写入：把模板整体复制到 `sites/<租户>/versions/<n>/public/`，
  复制时做两件事（**只在发布时做，运行时不改**）：
  - `config.js` 重写成注入后的 `window.CRM_API_BASE`
  - 所有文本产物做 `{{site.*}}` 占位符替换（品牌设置烘焙，见下）
- **版本不可变**：写完就不再改。回滚 = 把指针指回旧 `n`，**不重建、不删除旧版本**。

### 1.1 `tpl/<sha>/`：模板版本（内容寻址）

studio 交付的模板包走这一层，与 `g/templates/` 的区别是**键不是版本号而是内容 sha**：

| | `g/templates/basic/v1/` | `tpl/<sha>/` |
|---|---|---|
| 谁写 | `npm run site:template:upload`（我们，手工） | `storeTemplate()`（studio 交付） |
| 键 | 模板名 + 版本 | **内容 sha256** |
| 语义 | 公共模板，所有租户共享 | 一份内容；租户的 `v7` 只是它的别名 |

三条纪律（`src/site/templates.ts`）：

1. **内容寻址**：同内容 → 同 sha → 同前缀。两个租户交同样的包只占一份。
2. **不可变**：写进去的 `tpl/<sha>/` 永不修改；改模板 = 新 sha = 新键。
3. **幂等**：同内容重复交付返回已有版本号（`idempotent: true`），不新增行 —— 所以
   sha 里不能有时间戳（契约 §4.3 的"确定性"就是为这条服务的）。

版本号 `v<seq>` 与 `sha` 的关系记在 D1 的 `site_templates`（`tenant_id, seq,
version, parent_sha, sha, engine, schema_version, files, bytes, created_by,
created_at`），当前指针是 `site_settings.template_version`（与数据设置同表，一起
做乐观锁）。

**交付 ≠ 上线**：`storeTemplate()` 只产生模板版本；上线仍然走 `publishSite()`
（渲染 + 注入 SDK + 写 `sites/…` + 切 KV 指针）。

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

发布的替换表只有六个槽，**多一个都要先改契约**：

| 槽 | 来源 | 说明 |
|---|---|---|
| `{{site.name}}` | `site_name`，空则用兜底名 | 转义后写入 |
| `{{site.tagline}}` | `tagline` | 转义 |
| `{{site.hero_title}}` | `hero_title`，空则用默认文案 | 转义 |
| `{{site.hero_sub}}` | `hero_sub` | 转义；空 ⇒ 空串（模板用 `:empty` 隐藏） |
| `{{site.color}}` | `color`（`#rrggbb`） | 不转义，需已校验 |
| `{{site.contact}}` | `contact_email` | 转义 |
| `{{site.contact_link}}` | `contact_email` | **整段 `<a>`**；没配就渲染空串（避免空的 `mailto:`） |
| `{{site.footer}}` | `footer_note`，空则 `© <年> <站点名>` | 转义 |

> **空值必须回落到可用默认**：`{{site.color}}` 留空会让 `--brand: ;` 变成非法 CSS，
> 整份样式失效 —— 所以它回落到 `#3b82f6`，而不是空串。

产物里若残留**未定义**的 `{{site.xxx}}` ⇒ 发布直接失败（`template_token_unknown`），
不让它漏到线上。

## 5. 域名

- **`MODE=single`（自部署）**：域名不归本仓管。租户在 Cloudflare 里给 `site-serve`
  加 Custom Domain，并自己写 `KV[host:<域名>]`。
- **`MODE=multi`（SaaS）**：域名动作一律走 cf-api（它才持有云凭据）。cf-api 的
  三个端点（申请 / 查询状态 / 解绑）**尚未实现**，所以 `GET /api/admin/site/domain`
  在托管模式下如实返回 `available: false`。
