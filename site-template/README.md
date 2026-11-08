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

3. **把站点地址告诉 CRM**（可选，只影响"访问 CRM 根路径跳到哪"）：

   ```jsonc
   "SITE_URL": "https://www.你的域名.com"
   ```

   跨域**不用登记**：`/api/app/v1/*` 对所有 origin 回 `Access-Control-Allow-Origin: *`。
   站点的域名怎么换都不影响接口，绑自定义域名也不用回来改配置。

## 文件说明

| 文件 | 作用 |
|---|---|
| `config.js` | **唯一需要你改的文件**：CRM 地址（发布时会被 CRM 改写） |
| `index.html` | 首页 |
| `pricing.html` | 套餐列表 + 购买按钮（全走 `SiteCrm`） |
| `login.html` | 邮箱验证码登录（`SiteCrm.sendCode` / `verify`） |
| `account.html` | 我的订阅 / 订单 / 兑换码 / 退出登录 |
| `download.html` | 下载页（入口来自后台「下载入口」表格：一个平台可挂多个渠道，没填的平台整块不显示） |
| `legal/` | 条款与隐私（**请换成你自己的文本**） |
| `site.css` | 样式，随便改 |

## 改的时候注意

- **不要自己 `fetch` CRM**：登录、下单、订阅、订单都走 `SiteCrm.*`（平台提供
  `/_crm/sdk.js`）。凭证只存在 SDK 里，页面拿不到，也不用管 `Authorization` 头。
- **价格与可售性不要自己算**：`SiteCrm.plans()` 返回的 `price` / `compareAt` /
  `badge` / `cta` / `buyable` 已经是渲染好的字符串与布尔，直接贴到 DOM 上。
- **不要自己做支付跳转**：`SiteCrm.checkout({ planId })` 会拿报价、下单、把支付页
  交给外部浏览器（App 里是 WebView，必须出 App）。
- **`.html` 后缀是刻意的**：静态托管通常没有"无扩展名重写"，链接里都写成
  `pricing.html`，这样丢到任何 host 上都能跑。想用 `/pricing` 这种干净路径，就在
  你的托管上加重写规则，并把链接改回去。
- **条款与隐私必须自己写**：模板里的是占位文本，直接上线有法律风险。

## 想让官网也能被我们托管？

不推荐。官网和后台同源时，官网上任何一段脚本（包括你贴的第三方统计）都能以管理员
身份调 `/api/admin/*`。真要托管，请先给 CRM 换一个独立域名（`crm.` vs `www.`），
并且不要把它塞回这个 Worker 的 assets 里。

---

## 模板自身的规范（改样式前先读这 6 条）

这套模板不只是"随便一套静态页"，它同时是我们**对外的脸面**和 studio 的编辑对象。

1. **品牌只靠一个变量**：`--brand: {{site.theme.brand}}`，其余颜色都由它派生
   （`color-mix`）。租户改一个主色，全站协调；不要在页面里写别的色值。
2. **能烘焙的都烘焙**：站点名、口号、首页大标题/副标题、联系方式、页脚版权行都是
   `{{site.*}}` 占位符，**发布时替换**。新增占位符要先改 CRM 的 `tokensOf()`。
3. **可编辑单元必须带锚点**：`data-eid="<页>.<区块>.<字段>"`，如
   `home.hero.title`。studio 靠它定位，不能靠"猜哪段文字"。
4. **不含业务规则**：能不能买只读 `buyable`，价格只渲染 `display_price_minor`，
   划线只看 `compare_at_price_minor`，按钮文案只按 `action` 查表。**别在自己这边
   比较促销价、别自建 `BUYABLE` 集合、别自己算应付。**
5. **零租户 JS**：页面里的脚本是平台资产（渲染 + 调接口），租户不往里写东西。
6. **一个主按钮**：一屏只有一个实心按钮，其余用文字链接或 `ghost`。

### 上传前会被自动拦截的事

`npm run site:template:upload` 在上传前用 `node:vm` 编译每个 `.js` 和每段内联
`<script>`，**有语法错就拒绝上传**。这条闸门是补出来的：曾经少一个 `}` 导致
`pricing.html` 整段脚本不执行，表现是"套餐列表空白"，而页面本身还是 200。
