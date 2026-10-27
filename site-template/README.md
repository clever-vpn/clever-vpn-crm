# 官网静态站模板

这里是一份**可以直接拿去用的官网**：首页 / 定价 / 登录 / 结账 / 我的 / 下载 / 条款。
它和 CRM **完全分离** —— 可以放在任何域名、任何静态托管上（Cloudflare Pages、
R2、GitHub Pages、自家服务器都行），通过 HTTP 调 CRM 的接口。

## 为什么分开

| | 说明 |
|---|---|
| 官网不在 CRM Worker 里 | 改文案/样式不需要重新部署 CRM，也不会跟后台抢同一个源 |
| 不用 Cookie | 登录态是 `Authorization: Bearer <session_token>`，存浏览器 `localStorage` |
| 不受第三方 Cookie 政策影响 | 两个域名是不是同一父域都无所谓 |

安全取舍（有意为之）：token 存在 localStorage，同源脚本可以读到。这里承载的只是
"某个用户的套餐权益"，泄露的损失有限；换来的是不需要 BFF 代理、不需要 CORS 凭据。
如果你的场景风险更高，请改成"官网自己的 Worker 代理 + HttpOnly Cookie"。

## 部署三步

1. **改 `config.js`** —— 只填一个值：

   ```js
   window.CRM_API_BASE = "https://crm.你的域名.com"; // 不要以 / 结尾
   ```

2. **把本目录上传到你选好的静态托管**，确保 `index.html` 在根路径。

3. **在 CRM 侧登记这个域名**（`wrangler.jsonc` 的 vars）：

   ```jsonc
   "APP_ORIGINS": "https://www.你的域名.com",  // 允许跨域调 /api/app/v1
   "SITE_URL": "https://www.你的域名.com"      // 可选：访问 CRM 根路径时跳到这里
   ```

   改完 `wrangler deploy`。`APP_ORIGINS` 没配对，浏览器会拦掉静态站的所有请求。

## 文件说明

| 文件 | 作用 |
|---|---|
| `config.js` | **唯一需要你改的文件**：CRM 地址 |
| `api.js` | 给 `fetch` 自动补 `Authorization: Bearer`；登录态读写 `localStorage` |
| `index.html` | 首页 |
| `pricing.html` | 套餐列表（`GET /plans`，免登录） |
| `login.html` | 邮箱验证码登录，成功后把 `session_token` 存进 `localStorage` |
| `checkout.html` | 选支付方式下单，跳到网关 |
| `account.html` | 我的订阅 / 订单 / 兑换码 / 退出登录 |
| `download.html` | 下载页 |
| `legal/` | 条款与隐私（**请换成你自己的文本**） |
| `site.css` | 样式，随便改 |

## 改的时候注意

- **接口地址一律走 `API_BASE`**，不要写死相对路径 —— 相对路径会打到静态站自己身上。
- **登录后不要指望刷新还在**：`api.js` 用 `localStorage`，已经处理好了持久化。
- **`.html` 后缀是刻意的**：静态托管通常没有"无扩展名重写"，链接里都写成
  `pricing.html`，这样丢到任何 host 上都能跑。想用 `/pricing` 这种干净路径，就在
  你的托管上加重写规则，并把链接改回去。
- **条款与隐私必须自己写**：模板里的是占位文本，直接上线有法律风险。

## 想让官网也能被我们托管？

不推荐。官网和后台同源时，官网上任何一段脚本（包括你贴的第三方统计）都能以管理员
身份调 `/api/admin/*`。真要托管，请先给 CRM 换一个独立域名（`crm.` vs `www.`），
并且不要把它塞回这个 Worker 的 assets 里。
