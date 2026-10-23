# 本地测试环境（crm.clever-vpn.org + app-web.clever-vpn.org）

Last updated: 2026-10-23

一套**本机就能跑**的联调环境：CRM 作为服务端，`app-web` 是一张网页模拟 App。
全部走 `https://`，证书由本机 Caddy 的内部 CA 签发（已在本机信任链里）。

```
浏览器 ──https──▶ Caddy (:443)
                    ├── crm.clever-vpn.org      → 127.0.0.1:8788  (wrangler dev，CRM Worker)
                    └── app-web.clever-vpn.org  → 127.0.0.1:5180  (node scripts/dev-app-web.mjs)
```

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
# 终端 A：CRM（wrangler dev 绑 IPv4，端口 8788）
npm run build:web            # 先出管理后台产物
./node_modules/.bin/wrangler dev --port 8788 --test-scheduled

# 终端 B：app-web 模拟端（纯静态，端口 5180）
npm run dev:app-web
```

- **不要用 `npx wrangler`**：会提示安装 `wrangler@4.152.0` 并卡在 `Ok to proceed?`。
- 别把 wrangler 输出接给 `head`（SIGPIPE 会把服务打死）；要留日志就 `> /tmp/crm-dev.log 2>&1 &`。

打开：

| 地址 | 用途 |
|---|---|
| <https://crm.clever-vpn.org/admin/> | 管理后台（首次进 `/admin/` 用 `SETUP_TOKEN` 初始化管理员） |
| <https://crm.clever-vpn.org/admin/plans> | 套餐设计器 |
| <https://app-web.clever-vpn.org/> | App 模拟端：登录 → 套餐列表 → 换购报价 |

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

## 6. 常见问题

| 现象 | 原因 / 处理 |
|---|---|
| `https://crm.clever-vpn.org` 502 | CRM 没起或没起在 8788；看 `/tmp/crm-dev.log` |
| 页面能开但接口 CORS 报错 | `Origin` 不在 `APP_ORIGINS`；改 `wrangler.jsonc` 后重启 wrangler |
| 浏览器证书告警 | Caddy 内部 CA 没被信任：`caddy trust`（或用 `Caddyfile` 里 `sign_with_root` 对应的根证书） |
| `send-code` 不给 `code` | `ENVIRONMENT` 被设成了 `production` |
| 本地够不到线上 `crm.clever-vpn.org` | hosts 钉到 127.0.0.1 了；用 `curl --resolve` 指定真实 IP |
