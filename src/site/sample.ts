/**
 * `GET /api/site/sample-data` —— 运行期数据的**预览样例**（契约 §4.4）。
 *
 * 为什么需要它：套餐价、订阅状态、订单这些**只能经 `window.SiteCrm` 在浏览器里取**，
 * 不可能烘进静态页面。但模板开发时又得看到"有数据时长什么样"，否则只能编一串假数字
 * 写进 HTML —— 而写进 HTML 的假价格，闸门拦不住（L0 只判技术有效性），最后就是
 * "预览好看、线上不对"。
 *
 * 所以样例由 CRM **按契约生成**、并明确打上 `sample: true`：
 *
 *   · 形状与 `src/site/sdk.ts` 的 `planView()` 一致 —— 模板照着它写就能上线，
 *     不会出现"样例里叫 `price`，真接口叫 `price_minor`"这种坑；
 *   · 数字是样例，不是任何租户的真实价格；客户端看到 `sample` 就该显示"示例数据"；
 *   · **付费动作在预览里一律拒绝**（`bootMode`），样例只用于渲染。
 */

/** `planView()` 的字段顺序即模板里常用的顺序，别随手改 */
export interface SamplePlan {
  id: string;
  name: string;
  kind: string;
  price: string;
  compareAt: string | null;
  badge: string | null;
  specs: string[];
  cta: string;
  action: string;
  buyable: boolean;
  reason: string | null;
  /** 给人看的支付方式名（`planView().methods`） */
  methods: string[];
  /** 带 id 的同款（`planView().method_options`）：下单要回传的是这个 id */
  method_options: { id: string; label: string }[];
}

export interface SampleData {
  /** 恒为 true：任何一方都不许把它当真实数据 */
  sample: true;
  plans: SamplePlan[];
  me: {
    user: { id: string; email: string; created_at: string } | null;
    subscription: {
      status: string;
      plan_id: string;
      expires_at: string;
      devices: number;
      licence_limit: number;
    } | null;
    referral: { code: string; invited: number; rewarded: number } | null;
  };
  orders: {
    code: string;
    plan_id: string;
    amount: string;
    status: string;
    created_at: string;
  }[];
}

/** 样例的"今天"由调用方给（测试可固定），避免样例里的日期跟着系统时间乱跳 */
export const sampleDataOf = (now = new Date()): SampleData => {
  const day = (offset: number): string =>
    new Date(now.getTime() + offset * 86_400_000).toISOString();
  return {
    sample: true,
    plans: [
      {
        id: "sample-monthly",
        name: "按月",
        kind: "subscription",
        price: "US$12.00",
        compareAt: null,
        badge: null,
        specs: ["30 天有效期", "3 台设备"],
        cta: "立即购买",
        action: "purchase",
        buyable: true,
        reason: null,
        methods: ["支付宝", "银行卡"],
        method_options: [
          { id: "alipay", label: "支付宝" },
          { id: "card", label: "银行卡" },
        ],
      },
      {
        id: "sample-yearly",
        name: "年付",
        kind: "subscription",
        price: "US$120.00",
        compareAt: "US$144.00",
        badge: "省 17%",
        specs: ["365 天有效期", "5 台设备"],
        cta: "立即购买",
        action: "purchase",
        buyable: true,
        reason: null,
        methods: ["支付宝", "微信", "银行卡"],
        method_options: [
          { id: "alipay", label: "支付宝" },
          { id: "wechat", label: "微信" },
          { id: "card", label: "银行卡" },
        ],
      },
    ],
    me: {
      user: { id: "sample-user", email: "sample@example.com", created_at: day(-120) },
      subscription: {
        status: "active",
        plan_id: "sample-yearly",
        expires_at: day(200),
        devices: 2,
        licence_limit: 5,
      },
      referral: { code: "SAMPLE01", invited: 1, rewarded: 1 },
    },
    orders: [
      {
        code: "SAMPLE-ORDER-1",
        plan_id: "sample-yearly",
        amount: "$120.00",
        status: "paid",
        created_at: day(-120),
      },
      {
        code: "SAMPLE-ORDER-2",
        plan_id: "sample-monthly",
        amount: "$12.00",
        status: "refunded",
        created_at: day(-400),
      },
    ],
  };
};

/**
 * `/plans` 的**原始返回**（预览宿主用）。
 *
 * 为什么还要一份"原始形状"：`sampleDataOf()` 给的是 `planView()` 的输出（模板直接
 * 贴 DOM 用的视图模型）。而预览里跑的是**真 SDK**，它拿到 `/plans` 后自己会再过一遍
 * `planView()` —— 喂视图模型进去只会得到一堆 `undefined`。
 *
 * 所以预览宿主把这份原始返回当成 `/plans` 的响应，SDK 原样映射一遍：
 * "预览看到的价格卡" = "线上拿到同样数据时渲染出的价格卡"，中间没有第二套实现。
 * 两份样例是否对得上，由 `test/site-sdk-sample.test.ts` 在沙箱里跑真 SDK 比出来
 * —— 不靠人记得同步改。
 */
export const SAMPLE_PLANS_RAW = [
  {
    plan_id: "sample-monthly",
    name: "按月",
    kind: "subscription",
    price_minor: 1200,
    display_price_minor: 1200,
    currency: "USD",
    compare_at_price_minor: null,
    promo_badge: null,
    validity_days: 30,
    licence_limit: 3,
    action: "purchase",
    buyable: true,
    reason: null,
    payment_methods: [
      { id: "alipay", label: "支付宝" },
      { id: "card", label: "银行卡" },
    ],
  },
  {
    plan_id: "sample-yearly",
    name: "年付",
    kind: "subscription",
    price_minor: 14400,
    display_price_minor: 12000,
    currency: "USD",
    compare_at_price_minor: 14400,
    promo_badge: "省 17%",
    validity_days: 365,
    licence_limit: 5,
    action: "purchase",
    buyable: true,
    reason: null,
    payment_methods: [
      { id: "alipay", label: "支付宝" },
      { id: "wechat", label: "微信" },
      { id: "card", label: "银行卡" },
    ],
  },
] as const;
