# 本地测试环境（crm.clever-vpn.org + app-web.clever-vpn.org）

Last updated: 2026-10-23

一套**本机就能跑**的联调环境：CRM 作为服务端，`app-web` 是一张网页模拟 App。
全部走 `https://`，证书由本机 Caddy 的内部 CA 签发（已在本机信任链里）。

```
浏览器 ──https──▶ Caddy (:443)
                    ├── crm.clever-vpn.org/admin*     → localhost:5181  (Vite dev，HMR)
                    ├── crm.clever-vpn.org/<其余>      → 127.0.0.1:8788  (wrangler dev，CRM Worker)
                    └── app-web.clever-vpn.org        → 127.0.0.1:5180  (node scripts/dev-app-web.mjs)
```

**管理后台为什么指向 dev server**：后台是 SPA，改一行代码不该走「`build:web` → 重启 wrangler」。
Caddy 在**同一个域名**下按路径分流：`/admin*` 交给 Vite（HMR），`/api/*` 等仍打到真 Worker
——所以会话 Cookie、`x-crm-request` CSRF、错误信封全都是真环境，而且同源、不需要 CORS。

## 1. 一次性准备

### hosts（需要 sudo，一次性）

```bash
sudo sh -c 'printf "\n127.0.0.1 crm.clever-vpn.org app-web.clever-vpn.org\n" >> /etc/hosts'
```

> ⚠️ 生效后本机就**够不到线上**的 `crm.clever-vpn.org`。要核对线上版本请用
> `curl --resolve crm.clever-vpn.org:443:$(dig +short crm.clever-vpn.org @1.1.1.1 | tail -1) …`。

### Caddy（一次性）

反代配置的**源文件**在本仓库 `scripts/local/Caddyfile.crm.conf`，落到
`/opt/homebrew/etc/Caddyfile` 末尾后 reload：

```bash
cat scripts/local/Caddyfile.crm.conf >> /opt/homebrew/etc/Caddyfile
caddy validate --config /opt/homebrew/etc/Caddyfile && caddy reload --config /opt/homebrew/etc/Caddyfile
```

- 上游写 `127.0.0.1`（不是 `localhost`）：`wrangler dev` 绑 IPv4，`dev-app-web.mjs` 也显式
  listen `127.0.0.1`。本机其它 Vite 块用 `localhost` 是因为 Node 会把它解析成 `[::1]`，别照抄。

### 本地密钥

`.dev.vars`（已 gitignore）：

```bash
SETUP_TOKEN=dev-setup-token-1234      # 首次 /api/admin/setup 用
```

## 2. 起服务（两个终端）

```bash
# 终端 A：管理后台 dev server（Vite，HMR，5181）
npm run dev:web

# 终端 B：CRM Worker（wrangler dev，8788）—— 只有后台与接口（官网独立部署）
npm run build:web            # 只在没产物时需要跑一次（assets 目录必须存在）
./node_modules/.bin/wrangler dev --port 8788 --test-scheduled

# 终端 C：app-web 模拟端（纯静态，5180）
npm run dev:app-web
```

- **改 `web/` 里的界面代码 → 浏览器直接热更新**，不用重新构建、不用重启 wrangler。
- 改了 `src/`（Worker 逻辑）→ wrangler 自己会重载，刷新页面即可。
- 想看**编译后的产物**（验证「build 之后也没问题」）：`npm run build:web` 后直接开
  <http://127.0.0.1:8788/admin/> —— 绕过 Caddy，走 Worker 的 assets。

- **不要用 `npx wrangler`**：会提示安装 `wrangler@4.152.0` 并卡在 `Ok to proceed?`。
- 别把 wrangler 输出接给 `head`（SIGPIPE 会把服务打死）；要留日志就 `> /tmp/crm-dev.log 2>&1 &`。

打开：

| 地址 | 用途 |
|---|---|
| <https://crm.clever-vpn.org/admin/> | 管理后台（**Vite dev server**；首次进用 `SETUP_TOKEN` 初始化管理员） |
| <http://127.0.0.1:8788/admin/> | 管理后台**编译产物**（对比用，走 Worker assets） |
| <https://crm.clever-vpn.org/admin/plans> | 套餐设计器 |
| <https://app-web.clever-vpn.org/> | App 模拟端：登录 → 套餐（`action` 渲染）→ 报价 → 下单 → 支付 → 轮询 → 看权益/激活码 |

### 假 cf-api（否则付款后拿不到码）

落账走真实 cf-api；本地没有时，订单会**如实**停在 `provisioning`（契约行为，不是 bug）。
想跑通“付钱 → 拿到码”，起一个假平台：

```bash
# 终端 D：假 cf-api（只存在内存，重启即清空）
node scripts/fake-cf-api.mjs          # 127.0.0.1:8899
```

再在 `.dev.vars` 里加两行，然后**重启 wrangler dev**（`.dev.vars` 不热重载）：

```ini
CF_API_BASE=http://127.0.0.1:8899
CF_API_TOKEN=cv_api_local
```

验证：付款后 `GET /api/app/v1/subscription` 变成 `active` 并带上 `code`；
假平台日志会把控制参数打成“人话”，**流量那一项必须是 `xx.xx GB`**：

```
[fake-cf] CREATE id=4201 code=7391048261558201 auth_id=crm:1 limit=1 frozen=0 expire=2028-10-24 traffic=1000.00 GB quota=NULL
```

（`traffic_balance` 存的是**字节**；写成 GB 会变成“100 字节”并在几分钟内断网。）

## 3. 验证码（本地直接回显）

与 `clever-vpn-cf-api` / `cf-dashboard` 同一做法：

- CRM 用 `ENVIRONMENT` 判断环境，**非 `production`** 时 `POST /api/app/v1/auth/send-code`
  直接把 `code` 放在响应里，并在 Worker 日志打一行 `[send-code] email => code`；
- 生产环境只发邮件（`EMAIL` 绑定 + `EMAIL_FROM`），响应里**没有** `code`。

app-web 会把回显的验证码直接填进输入框，点「登录」即可。

```bash
curl -s -H 'content-type: application/json' \
  -d '{"email":"you@local.test"}' \
  https://crm.clever-vpn.org/api/app/v1/auth/send-code
# {"ok":true,"cooldown":60,"code":"123456","dev":true}
```

## 4. 现成的本地账号与数据

- 客户/订阅存在本地 D1（`.wrangler/state/`），随 `wrangler dev` 重启保留。
- 手工开通订阅（不走支付）：

```bash
curl -s -H "Cookie: crm_admin=<token>" -H 'x-crm-request: 1' -H 'content-type: application/json' \
  -d '{"customer_id":1,"plan_id":"p_30d_100g_1d"}' \
  https://crm.clever-vpn.org/api/admin/subscriptions
```

- 跑一轮额度结算（默认 dry-run，只打印"会写成什么"）：

```bash
curl -s -H "Cookie: crm_admin=<token>" -H 'x-crm-request: 1' -H 'content-type: application/json' \
  -d '{"dry_run":true}' https://crm.clever-vpn.org/api/admin/subscriptions/settle
```

- 触发定时任务入口（需要 `--test-scheduled`）：
  `curl "https://crm.clever-vpn.org/__scheduled?cron=17+*+*+*+*"`

## 5. 跨域

`/api/app/v1/*` 只对 `APP_ORIGINS` 里的**精确 Origin** 回 CORS 头（`wrangler.jsonc`）：
`https://app-web.clever-vpn.org, http://localhost:5180`。为空则不下发任何 CORS 头。

## 6. 数据库（本地）

本地 D1 用**开发迁移链**（`migrations-dev/`，gitignore 的产物），随改随重置：

```bash
npm run db:reset      # 停 dev → 删本地 D1 → 从 schema.ts 重建全量 DDL + dev 种子 → apply
npm run db:migrate:local   # 只 apply（不清库）
```

重置后直接可用：管理员 `ops@example.com` / `crm-admin-2026`，另有 4 个套餐
（含一个 0 元隐藏的礼品包）、2 个客户、1 个订阅、2 张订单。

改了 `src/db/schema.ts` 之后：

- 开发想看效果 → `npm run db:reset`（开发链自动重生成）；
- 要发布 → `npm run db:generate` 生成**生产链**迁移并提交（`npm run check:migrations` 会拦住漏提交）。

## 6.1 测试（两套）

| 命令 | 跑在哪 | 内容 |
|---|---|---|
| `npm run test:unit` | **Node**（`vitest.config.ts`） | 纯函数：报价、校验、加解密、邮件模板 → `test/**/*.test.ts` |
| `npm run test:workers` | **workerd**（`@cloudflare/vitest-plugin`，Miniflare） | 真 D1 + 真路由 + 真 cookie → `test/workers/**/*.test.ts` |
| `npm test` | 上面两个依次跑 | CI 用这个 |

两套必须分开配置：Workers 集成不允许自定义 `environment`/`runner`，所以
`vitest.config.ts` 显式 `exclude: ["test/workers/**"]`。

集成测试的几个要点：

- **建表**：`test/workers/apply-migrations.ts` 在每个 test 文件里
  `applyD1Migrations(env.DB, env.TEST_MIGRATIONS)`。迁移数组由
  `readD1Migrations("migrations")` 在 **Node 侧**读出（用 fs），以测试专用绑定注入。
  读的是**生产链** `migrations/`，不是 `migrations-dev/` —— 测试用的就是 CI 会 apply 的 DDL。
- **隔离**：存储按 test 文件隔离，每个文件一份空库 + 重跑一次迁移；文件之间默认并发。
- **写操作要带 `x-crm-request: 1`**（CSRF 防线），否则一律 403 `csrf_rejected`。
- **登录**：没有 cookie jar，自己从 `set-cookie` 里取 `crm_admin=…` 再回传。
- ⚠️ 插件会自动注入 `nodejs_compat`，所以测试里 `import fs` 也能跑通，**但线上会挂**。
  集成测试里要刻意避免 Node API，保住"测得过 = 部署得上"。

## 7. 常见问题

| 现象 | 原因 / 处理 |
|---|---|
| `https://crm.clever-vpn.org` 502 | CRM 没起或没起在 8788；看 `/tmp/crm-dev.log` |
| 页面能开但接口 CORS 报错 | `Origin` 不在 `APP_ORIGINS`；改 `wrangler.jsonc` 后重启 wrangler |
| 浏览器证书告警 | Caddy 内部 CA 没被信任：`caddy trust`（或用 `Caddyfile` 里 `sign_with_root` 对应的根证书） |
| `send-code` 不给 `code` | `ENVIRONMENT` 被设成了 `production` |
| 本地够不到线上 `crm.clever-vpn.org` | hosts 钉到 127.0.0.1 了；用 `curl --resolve` 指定真实 IP |
