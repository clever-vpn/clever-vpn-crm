# 管理后台

> Last updated: 2026-10-23 — 契约/接口变更请同步本文件与 `docs/contract.md`。

定位：**单个管理员账号**的租户运营控制台。不是 SaaS 后台，不做多租户、不做角色模型。

## 1. 结构

同一个 Worker、同一个 D1，三个面：

| 路径 | 内容 | 鉴权 |
|---|---|---|
| `/` | 只做跳转：配了 `SITE_URL` 就 302 过去，否则显示一行部署提示 | 公开 |
| `/admin/*` | 管理后台 SPA（React + Vite，产物 `web/dist/admin`） | Cookie 会话 |
| `/api/admin/*` | 管理后台 API | Cookie 会话（`/bootstrap`、`/setup`、`/login*` 公开） |
| `/api/app/v1/*` | App 与静态站共用的接口（契约在 `clever-vpn-docs`） | Bearer 或 Cookie |

**官网不在这个 Worker 里。** 静态站（首页 / 定价 / 登录 / 我的 / 条款）独立部署，
可以是完全不同的域名，通过 `Authorization: Bearer <session_token>` 调 `/api/app/v1/*`。
模板见 [`../site-template/`](../site-template/README.md)。

这样做的好处：官网与后台**不同源**，租户（或 AI）在官网上写的脚本碰不到 `/api/admin/*`；
CRM 也不必应付各家浏览器的第三方 Cookie 政策。代价是登录态存在浏览器 `localStorage`
（见模板 README 的取舍说明）。

两个配置项决定它怎么工作（`wrangler.jsonc` 的 vars）：

| 变量 | 作用 |
|---|---|
| `SITE_URL` | 访问 CRM 根路径时 302 到官网。留空只显示部署提示 |
| `APP_ORIGINS` | 允许跨域调 `/api/app/v1` 的 origin（逗号分隔）。**静态站域名必须在这里** |


## 2. 认证

- **一个账号**：`admin_users` 只有一行。需要多人时加 `role` 列即可（additive 迁移）。
- **密码**：PBKDF2-HMAC-SHA256，默认 5 万次迭代，存储格式
  `pbkdf2$sha256$<iters>$<salt>$<hash>`（salt/hash 为 base64url）。
  全站只有管理员登录会付这个 CPU 代价（App 用户无密码）；5 万次约 6ms，
  免费版 Workers 的单请求 CPU 就是 10ms。想要更硬：
  `wrangler secret put ADMIN_PBKDF2_ITERATIONS`（如 210000，最小 10000）。
  验证时按**存储里的迭代次数**计算，所以改默认值不会让旧密码失效。
- **会话**：`admin_sessions` 存 token 的 sha256，Cookie 为
  `crm_admin`（`HttpOnly; Secure; SameSite=Lax`，30 天滑动）。
  与 App 的 `Bearer session_token` **完全分离**，互不影响。
- **登录方式**：**密码**（永远可用）+ **邮箱验证码**（服务端配了发信才出现）。
  能力由 `GET /api/admin/bootstrap` 的 `methods` 上报，前端**不显示不可用的方式**。
  开发环境（`ENVIRONMENT != production`）验证码直接回显，不需要配邮件。
- **2FA（可选）**：TOTP（RFC 6238，SHA1/6 位/30 秒），绑定返回 secret 与
  `otpauth://` 链接（手动输入到认证器）。开启后登录分两步：密码 → `crm_admin_pending`
  （5 分钟挑战）→ 6 位验证码。
  **邮箱验证码登录也必须过这一步** —— 否则邮箱认证就成了绕过 2FA 的后门。
- **改密码**：可以用当前密码，也可以改用**发到当前绑定邮箱的验证码**（忘了旧密码时用）。
  改邮箱只能靠当前密码（验证码不能改邮箱，否则验证码=全权）。
- **CSRF**：所有写操作要求请求头 `x-crm-request: 1`（跨源请求无法静默携带自定义头，
  且本 Worker 不对 `/api/admin` 返回 CORS 头）。
- **限流 / 锁定**：同一账号连续 5 次密码错误锁定 15 分钟（429）。
- **人机校验（Cloudflare Turnstile，可选）**：**配了才生效**。
  - `TURNSTILE_SITE_KEY`（公开值，可放 `vars`）→ 通过 `/api/admin/bootstrap`
    的 `turnstile_site_key` 下发给前端；为 `null` 时前端**不渲染挂件**。
  - `TURNSTILE_SECRET`（`wrangler secret put TURNSTILE_SECRET`）→ 服务端校验。
    **未配置 = 完全不校验**，本地开发与不想开的自托管租户都不受影响。
  - 校验点：`/setup`、`/login`、`/login/email/start`、App 的 `/api/app/v1/auth/send-code`
    （都是"公开且能花钱或能枚举"的入口）。已登录后的接口不校验。
  - 只配 `TURNSTILE_SECRET` 不配 `TURNSTILE_SITE_KEY` 会让登录**必然失败**
    （服务端要校验、前端又拿不到 site key）——两个一起配。

## 3. 首次初始化

不采用"谁先访问谁是管理员"。`/setup` 必须提供 **`SETUP_TOKEN`**：

1. 生成一串随机值，配进仓库 secret（见 `docs/self-host.md`）：
   `openssl rand -hex 24`
2. 部署完成后打开 `https://<worker>/admin/`，填口令 + 邮箱 + 密码（≥12 位）。
3. 建完立即生效；之后再访问看到的是登录页。

`SETUP_TOKEN` 缺失时 `/api/admin/bootstrap` 返回 `setup_configured:false`，
`/setup` 返回 503 并给出提示。

## 4. 账号恢复

> 只要 Cloudflare 账号在手，一切都能找回来。**没有 `/recover` 端点**：
> 少一个可被攻击的入口。
>
> 顺序：① 配了邮件 → 登录页「忘记密码」（邮箱验证码自助重设）；
> ② 邮件没配 / 邮箱也进不去 / 2FA 丢失 → **走下面的 D1 重置**（这一条永远有效，
> 因为它不依赖任何一个外部服务）。

### 4.1 忘记密码（自助，未登录可用）

登录页密码框下方有「忘记密码？」（**只有服务端真能发信时才显示**）：

```
POST /api/admin/password/forgot   { email, turnstile_token? }   → 恒返回 { ok:true, cooldown:60 }
POST /api/admin/password/reset    { email, code, next }          → { ok:true }
```

- `purpose = admin_reset`：与「邮箱验证码登录」（`admin_login`）、「已登录改密」
  （`admin_password`）**互不通用** —— 哈希入参含 purpose。
- 码 6 位 / 10 分钟 / 最多 5 次 / 60 秒冷却；只存哈希。
- 重置成功会 **① 踢掉所有会话**（重置的动机通常是"账号可能被别人用过"）
  **② 解除 `failed_attempts` / `locked_until`**（被锁 15 分钟的人正是最需要重置的人，
  而验证码已经证明了他就是本人）。
- `forgot` 是恒定响应：不泄露"这个邮箱是不是管理员"。

### 4.2 SaaS 开通时的初始密码

托管模式下租户拿不到 `SETUP_TOKEN`，所以管理员账号由 **cf-api 在开通时直接写进
租户 D1**（`admin_users` 一行），初始密码随后发到 `accounts.email`。

- 密码格式与本节 4.3 完全一致（`pbkdf2$sha256$50000$…`），cf-api 与本站
  `src/admin/crypto.ts` 的 `verifyPassword` 已做过跨仓验证。
- 这封信没收到 / 密码丢了 → 用 4.1 的「忘记密码」自己重设，**不需要** cf-api 介入。
- 因此 `bootstrap.needs_setup` 在托管租户里应为 `false`；只有自托管（自己拥有
  Cloudflare 账号）才走 `/setup` + `SETUP_TOKEN`。

### 4.3 最后的兜底：D1 重置

忘记密码 / 丢失 2FA / 账号被锁，在 D1 上执行（本地或 Dashboard 都行）：

```sql
-- 1) 解锁（忘记密码前先解锁，否则一直是 429）
UPDATE admin_users SET failed_attempts = 0, locked_until = NULL;

-- 2) 关闭 2FA（手机丢了）
UPDATE admin_users SET totp_enabled = 0, totp_secret = NULL;

-- 3) 重置密码：password_hash 必须先由本仓库生成
--    见下方命令；把输出整串贴到下面
UPDATE admin_users SET password_hash = '<pbkdf2$sha256$...>';

-- 4) 踢掉所有会话（**必做**：重置的意义之一就是让旧登录态失效）
DELETE FROM admin_sessions;
```

生成新哈希（在仓库里跑，纯本地计算，不联网）：

```bash
node --input-type=module -e '
const enc = new TextEncoder();
const salt = crypto.getRandomValues(new Uint8Array(16));
const b64 = (b) => Buffer.from(b).toString("base64url");
const key = await crypto.subtle.importKey("raw", enc.encode(process.argv[1]), "PBKDF2", false, ["deriveBits"]);
const bits = new Uint8Array(await crypto.subtle.deriveBits(
  { name: "PBKDF2", hash: "SHA-256", salt, iterations: 50000 }, key, 256));
console.log(`pbkdf2$sha256$50000$${b64(salt)}$${b64(bits)}`);' '新密码'
```

> 备份文件（`wrangler d1 export`）里的 `password_hash` 属于敏感数据：
> 按密码对待——不要进 git、不要发聊天工具、不要丢在公共网盘。

## 5. API 一览

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/api/admin/bootstrap` | `{needs_setup, setup_configured}`（公开） |
| POST | `/api/admin/setup` | `{token,email,password}`（公开，一次性） |
| POST | `/api/admin/login` | `{email,password}` → `{ok}` 或 `{totp_required:true}` |
| POST | `/api/admin/login/totp` | `{code}` → 建正式会话 |
| POST | `/api/admin/logout` | 删当前会话 |
| GET | `/api/admin/me` | `{email, totp_enabled}` |
| POST | `/api/admin/password` | `{current,next}`；成功后踢掉其它会话 |
| GET | `/api/admin/sessions` | 会话列表（`sid` = 哈希前 8 位） |
| DELETE | `/api/admin/sessions/:sid` | 吊销指定会话 |
| POST | `/api/admin/2fa/enroll` | 返回 `{secret, uri}` |
| POST | `/api/admin/2fa/activate` | `{code}` 启用 |
| POST | `/api/admin/2fa/disable` | `{password}` 关闭 |
| GET | `/api/admin/audit?limit=50` | 审计日志（最多 200 条） |
| * | `/api/admin/plans*` | 套餐设计器（CRUD / 发布 / 下线 / 预览），见 [plans.md](plans.md)  |
| GET/POST | `/api/admin/customers` | 客户列表 / 建客户（本地联调与补单用） |
| GET/POST | `/api/admin/subscriptions` | 订阅历史 / 手工开通，见 [plans.md](plans.md) |
| POST | `/api/admin/subscriptions/settle` | 跑一轮额度结算（**默认 dry-run**；线上由 cron 每小时跑） |

## 6. 审计

`audit_log` 记录：`setup` / `login` / `login_failed` / `login_totp_failed` /
`logout` / `password_changed` / `session_revoked` / `totp_enabled` / `totp_disabled`。
业务写操作（改客户、退款）落地时同样必须写一条，带 `target` 与变更前后值。

## 7. 开发

```bash
npm run dev        # 构建 SPA，再起 wrangler dev（:8788）
npm run dev:web    # 只跑 vite（:5273，/api 代理到 8788）
npm run typecheck  # Worker + web
npm test           # 单测（Node）+ 集成测试（workerd），见 local-dev.md §6.1
```

本地没有 `SETUP_TOKEN` 时可临时用 `wrangler dev --var SETUP_TOKEN:dev`。

## 8. 尚未实现

- 业务页面（客户 / 订单 / 套餐）：目前是占位卡片。
- 官网内容：不在本仓库构建产物里，见 `site-template/`（独立部署）。
- App 接口 `/api/app/v1/*`（登录/套餐/下单/取码），契约见 `clever-vpn-docs`。
