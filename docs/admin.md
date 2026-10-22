# 管理后台

> Last updated: 2026-10-22 — 契约/接口变更请同步本文件与 `docs/contract.md`。

定位：**单个管理员账号**的租户运营控制台。不是 SaaS 后台，不做多租户、不做角色模型。

## 1. 结构

同一个 Worker、同一个 D1，三个面：

| 路径 | 内容 | 鉴权 |
|---|---|---|
| `/admin/*` | 管理后台 SPA（React + Vite，产物 `web/dist/admin`） | Cookie 会话 |
| `/api/admin/*` | 管理后台 API | Cookie 会话（`/bootstrap`、`/setup`、`/login*` 公开） |
| `/api/app/v1/*` | App 接口（⬜ 待实现，契约在 `clever-vpn-docs`） | Bearer（另说） |

`/` 目前 302 到 `/admin/`；品牌官网上线后 `/` 归官网、后台仍在 `/admin/`。

## 2. 认证

- **一个账号**：`admin_users` 只有一行。需要多人时加 `role` 列即可（additive 迁移）。
- **密码**：PBKDF2-HMAC-SHA256，默认 10 万次迭代，存储格式
  `pbkdf2$sha256$<iters>$<salt>$<hash>`（salt/hash 为 base64url）。
  免费版 Workers 单请求 CPU 只有 10ms，登录若超时可下调：
  `wrangler secret put ADMIN_PBKDF2_ITERATIONS`（最小 10000）。
- **会话**：`admin_sessions` 存 token 的 sha256，Cookie 为
  `crm_admin`（`HttpOnly; Secure; SameSite=Lax`，30 天滑动）。
  与 App 的 `Bearer session_token` **完全分离**，互不影响。
- **2FA（可选）**：TOTP（RFC 6238，SHA1/6 位/30 秒），绑定返回 secret 与
  `otpauth://` 链接（手动输入到认证器）。开启后登录分两步：密码 → `crm_admin_pending`
  （5 分钟挑战）→ 6 位验证码。
- **CSRF**：所有写操作要求请求头 `x-crm-request: 1`（跨源请求无法静默携带自定义头，
  且本 Worker 不对 `/api/admin` 返回 CORS 头）。
- **限流 / 锁定**：同一账号连续 5 次密码错误锁定 15 分钟（429）。

## 3. 首次初始化

不采用"谁先访问谁是管理员"。`/setup` 必须提供 **`SETUP_TOKEN`**：

1. 生成一串随机值，配进仓库 secret（见 `docs/self-host.md`）：
   `openssl rand -hex 24`
2. 部署完成后打开 `https://<worker>/admin/`，填口令 + 邮箱 + 密码（≥12 位）。
3. 建完立即生效；之后再访问看到的是登录页。

`SETUP_TOKEN` 缺失时 `/api/admin/bootstrap` 返回 `setup_configured:false`，
`/setup` 返回 503 并给出提示。

## 4. 账号恢复（不做接口，走 D1）

> 只要 Cloudflare 账号在手，一切都能找回来。**故意不提供 `/recover` 端点**：
> 少一个可被攻击的入口。

忘记密码 / 丢失 2FA / 账号被锁，在 D1 上执行（本地或 Dashboard 都行）：

```sql
-- 1) 解锁（忘记密码前先解锁，否则一直是 429）
UPDATE admin_users SET failed_attempts = 0, locked_until = NULL;

-- 2) 关闭 2FA（手机丢了）
UPDATE admin_users SET totp_enabled = 0, totp_secret = NULL;

-- 3) 重置密码：password_hash 必须先由本仓库生成
--    见下方命令；把输出整串贴到下面
UPDATE admin_users SET password_hash = '<pbkdf2$sha256$...>';

-- 4) 踢掉所有会话（可选）
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
  { name: "PBKDF2", hash: "SHA-256", salt, iterations: 100000 }, key, 256));
console.log(`pbkdf2$sha256$100000$${b64(salt)}$${b64(bits)}`);' '新密码'
```

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

## 6. 审计

`audit_log` 记录：`setup` / `login` / `login_failed` / `login_totp_failed` /
`logout` / `password_changed` / `session_revoked` / `totp_enabled` / `totp_disabled`。
业务写操作（改客户、退款）落地时同样必须写一条，带 `target` 与变更前后值。

## 7. 开发

```bash
npm run dev        # 构建 SPA + wrangler dev（:8788）
npm run dev:web    # 只跑 vite（:5273，/api 代理到 8788）
npm run typecheck  # Worker + web
npm test           # 密码学/TOTP 单测
```

本地没有 `SETUP_TOKEN` 时可临时用 `wrangler dev --var SETUP_TOKEN:dev`。

## 8. 尚未实现

- 业务页面（客户 / 订单 / 套餐）：目前是占位卡片。
- App 接口 `/api/app/v1/*`（登录/套餐/下单/取码），契约见 `clever-vpn-docs`。
- 品牌官网（`/`、`/pricing`、`/legal/*`）。
