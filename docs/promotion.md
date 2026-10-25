# 促销（promotion / referral）

> 对外承诺见 `clever-vpn-docs` `app-crm.md` **§2.9**（contract `13`）。
> 本文是**内部设计依据与决策记录**：为什么只做这两种、为什么砍掉另外三种。
> 实现状态：**P1 ✅ 已实现**（自动活动 + 优惠码 + 邀请码；P2 带码投放未做）。

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

| | **优惠码** | **邀请码** | **赠送/兑换** |
|---|---|---|---|
| 生效时机 | 结账时 | 注册时 | 随时 |
| 改什么 | **订单金额** | **关系** + 首单金额 | 订阅权益 |
| 归因 | ❌ | ✅ **唯一来源** | ❌ |
| 分发 | 服务商（有成本） | **用户自己**（零成本） | 服务商 / 第三方 |

**邀请码与优惠码的本质区别**：优惠码是**匿名**的（谁用都一样），邀请码是**实名关系**
（必须绑定两个人）。邀请码可以带优惠，但**优惠码永远不产生归因**。

### 为什么不做"兑换码 / 礼品卡"

它的真实用途只有三个，对我们都不成立：

| 场景 | 判断 |
|---|---|
| 客服补偿（断线赔 3 天） | 后台点一下就能加权益，**不需要用户输码** |
| 送礼 | VPN 不是礼品 |
| 第三方渠道售卖（淘宝卖卡） | 灰色渠道，小服务商容易被薅 |

而且它要额外解决"码的交付"（印刷、发货、防撞库、防泄露），成本远高于收益。

### 为什么不做"券包"

Web 面板时代的产物——用户会登录网站、逛活动页、翻券包。**App 用户不会逛**。
定向给某个客户的优惠，用「活动 + 指定客户」实现即可，不需要"券"这个实体。

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

## 3. 数据模型（3 张表）

```
promotions                     一个活动 / 一批码
  code                         可空：null = 自动生效（全场活动）
  kind                         coupon | referral
  benefit_type                 amount | percent | days | gb | plan
  benefit_value, plan_id
  referrer_reward_type/value   kind=referral：给推荐人什么（默认给权益，不给现金）
  min_subtotal_minor           ⚠️ 两家面板都没有，我们必须有
  limit_plan_kinds / limit_plan_ids
  starts_at / ends_at
  max_uses / max_uses_per_customer
  first_purchase_only / new_user_within_days
  badge_label                  "限时 8 折"，直接给 UI 展示
  visible                      是否公开展示

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
| P1 | 自动活动（新人首单 / 续费 / 节日全场） | ✅ |
| P1 | 邀请码（注册绑定 + 首单双向奖励） | ✅ |
| P2 | 带码投放（KOL / 群） | ⬜ 建活动即可，无需新能力 |
| ❌ | 兑换码、券包、多级分销、佣金提现 | 见 §1 |

## 7. 已知的坑（实现时注意）

1. **邀请码不能必填**。用户刚装完 App，没有义务输码；必填等于杀转化率。
2. **iOS 拿不到 deferred deep link**。所以「分享落地页显示码 + 一键复制」是必需品，
   不能指望「点链接自动带上」。
3. **券的核销时机**：支付成功才写 `redemptions`，下单时只校验不扣减。
4. **最低消费必须有**：百分比券对低价套餐会击穿（$1 买年付）。
5. **`origin` 不是 `channel`**：`origin` = 从哪个壳进来；`channel` = 钱在哪里付。
   两者正交，别混用。

## 8. 实现地图（P1）

| 关注点 | 位置 |
|---|---|
| 表 | `promotions`（规则层）、`referrals`（关系层）、`redemptions`（核销台账，`(promotion_id, order_id)` 唯一） |
| 纯逻辑 | `src/promotions/model.ts`：时间窗 / 套餐范围 / 门槛 / 次数 / 首单 → `checkPromotion`；`discountOf`；`bestPromotion` |
| 取数 | `src/promotions/service.ts`：`resolvePromotion`（单套餐，含用户输入的码）、`resolveForPlans`（列表页，一次算完）、`planBadges`（公开角标） |
| 关系 | `src/promotions/referral.ts`：`ensureReferralCode`（懒生成）、`bindReferral`（静默、幂等）、`referralPanel`、`rewardReferrer` |
| 后台 | `src/admin/promotions.ts`：`GET/POST /api/admin/promotions`、`PATCH /:id`、`POST /:id/publish|end` |
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
