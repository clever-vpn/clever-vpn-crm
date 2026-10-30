# 促销（promotion / gift / referral）

> 对外承诺见 `clever-vpn-docs` `app-crm.md` **§2.9**（contract `15`）。
> 本文是**内部设计依据与决策记录**：为什么是这三类、为什么砍掉其他玩法。
> 实现状态：**P1 ✅**（优惠券 + 邀请码）、**P2 ✅**（礼包 / 人群 / 冷却）；
> **P3 未做**（一码一人的批次 / CSV 导出、营销报表）。

## 0. 定位决定形态

我们的租户是**小型 VPN 服务商**，终端用户通过 **App + 品牌官网**两个壳使用服务：

| 壳 | 承担 | 与促销的关系 |
|---|---|---|
| App | 使用、留存、续费、邀请 | 打开即见活动；不需要输入码 |
| 品牌官网 | 介绍、比价、购买、登录看权益 | **有结账页**，是唯一自然的"输入码"场所 |

两条由此推出的硬事实：

1. **促销发生在"下载之后"**（App）或"付款之前"（官网）。它影响不了"这人为什么会来"。
2. **凡是需要服务商主动把码送出去的促销，都排最后**——小团队最缺的是"持续做运营动作"的人力。

## 1. 三类物件，用四个维度切开

| 维度 | 含义 |
|---|---|
| **生效时机** | 注册时 / 结账时 / 随时 |
| **改什么** | 订单金额 / 订阅权益 / 人际关系 |
| **是否产生归因** | 能不能统计"谁拉来的" |
| **谁负责分发** | 系统自动 / 服务商投放 / 用户自发 |

| | **优惠券** | **邀请** | **礼包** |
|---|---|---|---|
| 生效时机 | 结账时 | 注册时 | 随时（注册 / 到期 / 手动） |
| 改什么 | **订单金额** | **关系** + 首单金额 | **订阅权益**（天数 / 流量） |
| 归因 | ❌ | ✅ **唯一来源** | ❌ |
| 是否产生订单 | ✅ 折扣后的正常订单 | ✅ 同上 | ✅ **0 元已付订单**（留痕用） |
| 分发 | 服务商（有成本） | **用户自己**（零成本） | 系统自动 / 后台手动 |

**邀请与优惠券的本质区别**：优惠券是**匿名**的（谁用都一样），邀请是**实名关系**
（必须绑定两个人）。邀请可以带优惠，但**优惠券永远不产生归因**。

**礼包与优惠券的本质区别**：优惠券"少收钱"，礼包"改权益"。两者是两套账，
所以送出去的天数**不参与残值计算**（`promotion.md` §4）。

### 为什么叫「礼包」，不叫「礼品卡」

XBoard 叫礼品卡（gift card），因为它是**可转赠的预付凭证**（有码、可囤、可送人）。
我们不是：我们的礼包是**运营工具**——注册礼包、续费礼包、到期挽回礼包，由租户
主动发，不进入流通。叫「礼品卡」会让人误以为可以买来送朋友。

有码一对一时叫**兑换码**（v16 已做「共享码」），无码的权益组合叫**礼包**。

### 兑换码（v16 起，v18 收敛为一张表）

**码是分发方式，不是第四类物件** —— 所以不是 `kind=voucher`，而是礼包带一个 `code`。
用户登录后在官网账户页 / App 里输码，直接换权益（`POST /redeem`）。

| 能力 | 状态 |
|---|---|
| 共享码（一码多人，`max_uses` 限量 + 每人 1 次） | ✅ v16 |
| 一码一渠道（建多个活动，核销数各自统计） | ✅ 天然成立，不需要批次表 |
| 载体套餐：没订阅的新客用隐藏套餐 0 元开户（= 免费体验） | ✅ v16 |
| 防撞库（同客户每小时 5 次失败即锁） | ✅ v16 |
| 一码一人批次 / CSV 导出 / 实体卡 | ❌ 不做（那是批发分销的业务） |

### 码的两种发法（v18）

后台只问两个问题，租户**从不手输码**：

| 选项 | 落库 | 语义 |
|---|---|---|
| 不发码 | 0 行 | 只能后台手动 / 系统自动发出 |
| 共享码 · 多少人可用（默认 100） | 1 行 `max_uses = N` | 一个码贴到群里，前 N 人 |
| 一人一码 · 发 N 个（默认 1） | N 行 `max_uses = 1` | 一码一渠道 / 实体卡 |

码由系统生成（8 位，去掉 `0/O/1/I`），共享码和一人一码**是同一张表的两种写法**，
不再有"主码 + 批次码"两套入口。**每人每活动固定 1 次**：允许同一个人反复用一个
优惠，既违背营销语义，也让"核销次数 = 触达人数"的报表口径失效。

### 为什么不做"码包 / 券包"

不是"永远不做"，而是**顺序问题**：它要额外解决码的交付（印刷、发货、防撞库、
防泄露）与批次管理（前缀 / 生效期 / 导出 CSV），成本集中在**分发**而不是产品价值。
在"租户还没有稳定跑注册礼包与到期挽回"之前，先不引入。

| 场景 | 现在怎么做 |
|---|---|
| 客服补偿（断线赔 3 天） | 后台「礼包 → 发放」填客户 ID，一次一个 |
| 到期挽回 | `audience=expiring` 礼包 + 每日定时任务自动发 |
| 第三方渠道售卖（卡密） | ❌ 灰色渠道，不做 |

### 为什么不做"券包"

Web 面板时代的产物——用户会登录网站、逛活动页、翻券包。**App 用户不会逛**。
定向给某个客户的优惠，用「优惠券 + 指定客户」实现即可，不需要"券"这个实体。

### 人群（取代旧的「仅限首单」布尔）

旧实现只有 `first_purchase_only` 一个布尔，表达不了"老客续费""快到期"这两种
最值钱的场景。现在改成枚举（契约 §2.9.6）：

| 取值 | 含义 | 典型用法 |
|---|---|---|
| `all` | 所有人 | 节日全场折扣 |
| `new` | 首单客户 | 拉新；**也是"注册礼包"的标记** |
| `existing` | 当前有生效订阅 | 续费折扣 |
| `expiring` | N 天内到期 | 到期前挽回（定时任务自动发礼包） |
| `expired` | 订阅已结束 | 召回 |
| `specific` | 点名名单（`promotion_targets`） | VIP / 客服定向 |

判定一律在服务端（`src/promotions/model.ts` 的 `checkAudience`），匿名用户对任何
个人条件**一律不适用**——不能因为"看起来像新人"就打折。

## 2. 获取路径矩阵（判断必要性的工具）

| | 自动活动 | 优惠码 | 邀请码 |
|---|---|---|---|
| 码从哪来 | 不需要码 | 运营后台生成 | **老用户自己生成** |
| 用户在哪遇到 | 打开套餐页就看见 | 群 / 邮件 / 博主 / 官网 | 朋友分享的链接或口令 |
| 需要 App 做什么 | 渲染 `promo_badge` | 结账页输入框 | 我的→邀请好友 + 注册可填 |
| 需要服务商做什么 | **什么都不用** | 把码发出去 | 定奖励规则 |

筛选标准（以后加任何促销都用这套）：

1. **用户能不能自然遇到它？**（有没有零成本触达路径）
2. **遇到之后有没有动力用？**（力度够不够抵消麻烦）
3. **服务商有没有办法把它发出去？**

三条都"是"才做。

## 3. 数据模型（4 张表）

```
promotions                     一个活动 / 一批码
  code                         可空：null = 自动生效（全场活动）
  kind                         coupon | gift | referral
  benefit_type                 金额维度：amount | percent（kind=gift 时不用）
  benefit_value
  rewards_json                 权益维度：{days, gb}（kind=gift）
  delivery                     auto | claim：礼包触发后直接到账，还是只发一张券（§3.1）
  claim_valid_days             delivery=claim 时的领取有效期（天，1–90）
  referrer_reward_type/value   kind=referral：给推荐人什么（默认给权益，不给现金）
  min_subtotal_minor           ⚠️ 两家面板都没有，我们必须有
  limit_plan_kinds / limit_plan_ids
  starts_at / ends_at
  max_uses / max_uses_per_customer
  audience / audience_days     人群（all/new/existing/expiring/expired/specific）
  cooldown_hours               同一客户两次核销的最小间隔
  plan_id                      载体套餐（仅礼包）：无订阅时用它 0 元开户（必须 hidden）
  new_user_within_days         额外的"注册 N 天内"闸门（与 audience 正交）
  badge_label                  "限时 8 折"，直接给 UI 展示
  visible                      是否公开展示

promotion_targets               audience=specific 的点名名单
  promotion_id, customer_id     唯一约束：(promotion_id, customer_id)

promotion_claims                待领取的礼包（delivery=claim）：券，不是权益
  promotion_id, customer_id, source(signup|expiring|manual)
  status                        pending | claiming（领取中的占位，防双击）| claimed
  expires_at                    领取截止时间（过期是算出来的，不是状态）
  order_id / granted_json       领取时产生的 0 元订单与实际生效的权益
  唯一约束：(promotion_id, customer_id) —— 一个活动对一个人只留一张

referrals                      谁邀请了谁（只存关系，不存钱）
  customer_id（被邀请人）, referrer_id, promotion_id, created_at
  唯一约束：customer_id（一个人只能被邀请一次）

redemptions                    台账：谁在什么订单上用了什么
  promotion_id, customer_id, order_id, discount_minor, granted_json, created_at
  唯一约束：(promotion_id, order_id)
```

设计要点：

- **`referrals` 只存关系**，钱与权益都走 `redemptions` 的 `granted_json`，便于对账。
- **`redemptions.order_id` 是"支付成功才写"**，不是下单时写。
- `code` 允许为空，是"自动活动"与"优惠码"共用一张表的关键——**只有一个概念：活动**。

### 3.1 礼包的两种到账方式（`delivery`）

**「已经发给你了」和「你已经拿到了」是两件事**，所以礼包有一列 `delivery`：

| 值 | 触发之后 | 记账 |
|---|---|---|
| `auto`（默认） | 权益立刻写进订阅 | 0 元订单 + `redemptions` 一行，全在触发那一刻产生 |
| `claim` | 只写一行 `promotion_claims`（待领取的券） | **什么都没产生**：没有订单、没有核销、名额不占 |

为什么必须有 `claim`：**悄悄改账用户感知不到**。把到期日悄悄推后 10 天，用户只会在
某天发现"居然还能用"，既不知道是谁给的、也不知道给了多少 —— 那是没人知道的善意，
不是营销。有个"领取"动作，福利才变成看得见、记得住的事。

实现约束：

- 待领取**不是第二套发放逻辑**：领取时仍然调 `grantGift()`（`promotions/gift.ts`），
  所以「无限期不收天数 / 不限量不收 GB / 送 GB 必须回源平台余额」这些规则一处生效。
- 建券时就先判一次"这份订阅收不收得下"：收不下**连券都不发**，否则用户会拿到一张
  永远领不掉的卡。
- 领取时 `skipCheck`：**不重判人群**。券是按当时身份点名的，用户晚两天回来领，
  不该因为期间付过费（`audience='new'` 不再成立）而作废。
- 并发：`pending → claiming` 是一条带条件的 `UPDATE`，`changes=0` 就是别人抢到了；
  领取失败（平台余额读不到等）把券**还回 `pending`**，不因为一次抖动就让券消失；
  占位超过 5 分钟视为那次失败（进程被杀也能自愈）。
- 过期**不靠定时任务**：`expires_at <= now` 就是过期。活动再次触发会刷新同一张券的
  截止时间（`ON CONFLICT ... WHERE status != 'claimed'`），已领取的绝不回退。

## 4. 三条不变量（永久有效，实现时不得违反）

1. **折扣与赠送分开记账**
   - 折扣（少收钱）⇒ `paid_minor` 变小 ⇒ 未来残值也变小（少付就少剩）
   - 赠送（送天数/流量）⇒ `paid_minor` 不变 ⇒ 残值不变
   - 混用会出现「8 折买入、按原价折残值」的套利。

2. **促销不改变升级阶梯**
   升级判定只看 `price_minor`（`plans.md` §2），促销只压 `payable_minor`。

3. **一次下单最多用一个码**
   邀请码的首单权益与 `promo_code` 冲突时取**更优**，不叠加。

计算顺序（永不变）：

$$\text{payable} = \max\left(0,\ \text{promo}(\text{price\_minor}) - \text{residual}\right)$$

## 5. 从两个面板借鉴了什么 / 拒绝了什么

| 来源 | 借鉴 | 拒绝 |
|---|---|---|
| XBoard | 券的四个限制维度（总量/每人次/限套餐/有效期）；`show`（是否公开） | 券在下单时扣次数（未支付也占用）；残值可跨订单累积结转（与折扣叠加易套利） |
| XBoard | 活动模板「条件 → 奖励 → 限制」的分层思路 | 盲盒、倍数、多级佣金 |
| SSPanel | 邀请返佣的三条防护：比例 + 总额封顶 + 一单只返一次 | 礼品卡（只等于余额，需钱包系统） |
| 两家 | 定向发放（可按用户） | 券包、库存/限量、用户等级体系 |

## 6. 实现顺序与契约字段

契约字段位已在 `app-crm.md` v12 定下，**App 与官网一次写完，后续上活动不发版**：

| 层 | 字段 | 用途 |
|---|---|---|
| `/plans[]` | `original_price_minor`, `promo_badge`, `payable_minor` | 划线价 + 活动标签 |
| `/quote` | 入参 `promo_code`；响应 `discount_minor`, `discount_label`, `applied_promotions` | 唯一的应付金额来源 |
| `/auth/verify` | 入参 `referral_code`（**选填，永不必填**） | 建立归因 |
| `/me` | `referral: { code, invited, reward_days, reward_gb }` | 邀请面板 |
| `/orders` | 入参 `origin`（`web`/`app`）, `promo_code` | 统计入口；下单复核 |

实施顺序：

| 阶段 | 内容 | 状态 |
|---|---|---|
| P1 | 优惠券（自动活动 / 凭码 / 节日全场） | ✅ |
| P1 | 邀请（注册绑定 + 首单双向奖励） | ✅ |
| P2 | 礼包（送天数 / 送流量） | ✅ |
| P2 | 人群六值 + 冷却 + 点名名单（`promotion_targets`） | ✅ |
| P2 | 注册礼包（首单后自动）/ 到期挽回礼包（每日定时） | ✅ |
| P2 | 兑换码（共享码 + 官网/App 兑换入口 + 防撞库） | ✅ v16 |
| P2 | 载体套餐（隐藏套餐 0 元开户 = 免费体验） | ✅ v16 |
| P3 | 兑换码批次（一码一人、CSV 导出、实体卡） | ⬜ 见 §1「为什么不做」 |
| P3 | 营销报表（按活动看核销 / 实收 / 让利） | ⬜ 台账已有，只差聚合 |
| ❌ | 券包、盲盒、多级分销、佣金提现 | 见 §1 |
| ❌ | 送余额（没有钱包）、送设备数（`licence_limit` 不可改） | 见 §4 |

## 7. 已知的坑（实现时注意）

1. **邀请码不能必填**。用户刚装完 App，没有义务输码；必填等于杀转化率。
2. **iOS 拿不到 deferred deep link**。所以「分享落地页显示码 + 一键复制」是必需品，
   不能指望「点链接自动带上」。
3. **券的核销时机**：支付成功才写 `redemptions`，下单时只校验不扣减。
4. **最低消费必须有**：百分比券对低价套餐会击穿（$1 买年付）。
5. **`origin` 不是 `channel`**：`origin` = 从哪个壳进来；`channel` = 钱在哪里付。
   两者正交，别混用。

## 8. 实现地图（P1 + P2）

| 关注点 | 位置 |
|---|---|
| 表 | `promotions`（规则层）、`referrals`（关系层）、`redemptions`（核销台账，`(promotion_id, order_id)` 唯一） |
| 纯逻辑 | `src/promotions/model.ts`：时间窗 / 套餐范围 / 门槛 / 次数 / 首单 → `checkPromotion`；`discountOf`；`bestPromotion` |
| 取数 | `src/promotions/service.ts`：`resolvePromotion`（单套餐，含用户输入的码）、`resolveForPlans`（列表页，一次算完）、`planBadges`（公开角标） |
| 关系 | `src/promotions/referral.ts`：`ensureReferralCode`（懒生成）、`bindReferral`（静默、幂等）、`referralPanel`、`rewardReferrer` |
| 礼包 | `src/promotions/gift.ts`：`grantGift`（幂等发放）、`grantSignupGifts`（首单后发 `audience=new`）、`runExpiringGifts`（每日扫 `audience=expiring`） |
| 兑换 | `src/promotions/redeem.ts`：`redeemGiftCode`（码归一 → 限流 → 找活动 → 发放），失败一律 `ok:false` + 整句原因 |
| 人群判定 | `model.ts` 的 `checkAudience`（六值）、冷却判定；取数在 `service.ts` 的 `customerFacts` / `targetedOf` |
| 后台 | `src/admin/promotions.ts`：`GET/POST /api/admin/promotions`、`PATCH /:id`、`POST /:id/publish|end`、`POST /:id/grant`（礼包手动发放）、`GET/PUT /:id/targets`（点名名单） |
| 核销 | 只在 `src/payments/notify.ts` 的 `grant()` 里调（钱到账之后），`INSERT OR IGNORE` |
| 金额 | `payable = max(0, price − discount − residual)`；`orders.amount_minor` 是实收，`orders.discount_minor` 只记促销那部分 |

几个**实现上的硬约束**（改代码时别破坏）：

1. `promotions.code` 为 `NULL` = 自动活动；**`kind='referral'` 的活动不能当码用**
   （否则等于一个匿名优惠码且不产生归因）。
2. 邀请码存在 `customers.referral_code`（懒生成 + 唯一索引），**不是** `promotions.code`。
3. 60 秒复用窗口按「用户 + 套餐 + 方式 + **金额**」匹配 —— 中途换码换了价，必须新建订单。
4. `referrals.rewarded_at` 带 `IS NULL` 条件更新 ⇒ 回调重放不会重复发奖励。
5. 推荐人奖励（天/GB）落在 `subscription_changes.action='gift'`，并立刻 `provisionSubscription`
   把 `expire_date` / `traffic_balance` 推到平台；推送失败只记日志，本地账已生效。

已知未做（有意）：0 元单（100% 抵扣）直接拒绝，不接"免费试用"；跨订单残值结转不做。
