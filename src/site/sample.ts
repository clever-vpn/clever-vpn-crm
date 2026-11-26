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
 *   · 形状与真接口一致（视图模型的字段与 `SiteCrm.plans()` / `me()` 一致）；
 *   · 数字是样例，不是任何租户的真实价格；客户端看到 `sample` 就该显示"示例数据"；
 *   · **付费动作在预览里一律拒绝**（`bootMode`），样例只用于渲染。
 *
 * ⚠️ 这里的两份数据必须与真接口同形：`SAMPLE_PLANS_RAW` 是 `/plans` 的**原始返回**，
 * `sampleDataOf()` 是 SDK 映射后的**视图模型**。`test/site-sdk-sample.test.ts` 在沙箱里
 * 跑真 SDK，比"预览看到的价格卡" == "线上同样数据渲染出的价格卡"。
 */

/** `planView()` 的字段顺序即模板里常用的顺序，别随手改 */
export interface SamplePlan {
  id: string;
  name: string;
  kind: string;
  kindLabel: string;
  price: string;
  compareAt: string | null;
  badge: string | null;
  specs: string[];
  cta: string;
  priceNote: string;
  action: string;
  buyable: boolean;
  reason: string | null;
  /** 带 id 的支付方式：下单要回传的是这个 id */
  method_options: { id: string; label: string }[];
}

export interface SampleData {
  /** 恒为 true：任何一方都不许把它当真实数据 */
  sample: true;
  plans: SamplePlan[];
  me: {
    user: { id: number; uuid: string; email: string; name: string | null } | null;
    subscription: {
      status: string;
      reason: string | null;
      status_text: string;
      tag: string | null;
      tag_tone: string | null;
      kind: string;
      plan_id: string;
      expires_at: string;
      licence_limit: number;
      unlimited: boolean;
      remaining_gb: number | null;
      next_reset_at: string | null;
    } | null;
    referral: { code: string; invited: number; reward_days: number; reward_gb: number } | null;
  };
  orders: {
    order_code: string;
    title: string;
    amount_text: string;
    status: string;
    status_text: string;
    tag: string;
    tag_tone: string;
    next_poll_after_ms: number | null;
    created_at: string;
    paid_at: string | null;
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
        kind: "period",
        kindLabel: "按时长",
        price: "¥12.00",
        compareAt: null,
        badge: null,
        specs: ["每月 100 GB", "30 天有效期", "3 台设备"],
        cta: "立即购买",
        priceNote: "实付价格",
        action: "buy",
        buyable: true,
        reason: null,
        method_options: [
          { id: "alipay", label: "支付宝" },
          { id: "card", label: "银行卡" },
        ],
      },
      {
        id: "sample-yearly",
        name: "年付",
        kind: "period",
        kindLabel: "按时长",
        price: "¥120.00",
        compareAt: "¥144.00",
        badge: "省 17%",
        specs: ["每月 100 GB", "365 天有效期", "5 台设备"],
        cta: "立即购买",
        priceNote: "实付价格",
        action: "buy",
        buyable: true,
        reason: null,
        method_options: [
          { id: "alipay", label: "支付宝" },
          { id: "wechat", label: "微信" },
          { id: "card", label: "银行卡" },
        ],
      },
    ],
    me: {
      user: { id: 1, uuid: "00000000-0000-4000-8000-000000000000", email: "sample@example.com", name: "样例用户" },
      subscription: {
        status: "active",
        reason: null,
        status_text: "生效中，每月 22 日重置",
        tag: "已订阅",
        tag_tone: "success",
        kind: "period",
        plan_id: "sample-yearly",
        expires_at: day(200),
        licence_limit: 5,
        unlimited: false,
        remaining_gb: 88.5,
        next_reset_at: day(10),
      },
      referral: { code: "SAMPLE01", invited: 1, reward_days: 7, reward_gb: 0 },
    },
    orders: [
      {
        order_code: "SAMPLE-ORDER-1",
        title: "年付",
        amount_text: "¥120.00",
        status: "paid",
        status_text: "已生效",
        tag: "已完成",
        tag_tone: "success",
        next_poll_after_ms: null,
        created_at: day(-120),
        paid_at: day(-120),
      },
      {
        order_code: "SAMPLE-ORDER-2",
        title: "按月",
        amount_text: "¥12.00",
        status: "refunded",
        status_text: "已退款",
        tag: "已退款",
        tag_tone: "warn",
        next_poll_after_ms: null,
        created_at: day(-400),
        paid_at: day(-400),
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
 * 所以预览宿主把这份原始返回当成 `/plans` 的响应，SDK 原样映射一遍。
 */
export const SAMPLE_PLANS_RAW = [
  {
    plan_id: "sample-monthly",
    name: "按月",
    kind: "period",
    kind_label: "按时长",
    specs: ["每月 100 GB", "30 天有效期", "3 台设备"],
    price_minor: 1200,
    display_price_minor: 1200,
    compare_at_price_minor: null,
    currency: "CNY",
    licence_limit: 3,
    term_days: 30,
    monthly_quota_gb: 100,
    traffic_gb: null,
    validity_days: null,
    promo_badge: null,
    action: "buy",
    buyable: true,
    reason: null,
    next_expires_at: null,
    cta: "立即购买",
    price_note: "实付价格",
    payment_methods: [
      { id: "alipay", label: "支付宝" },
      { id: "card", label: "银行卡" },
    ],
    store_product_id: {},
  },
  {
    plan_id: "sample-yearly",
    name: "年付",
    kind: "period",
    kind_label: "按时长",
    specs: ["每月 100 GB", "365 天有效期", "5 台设备"],
    price_minor: 14400,
    display_price_minor: 12000,
    compare_at_price_minor: 14400,
    currency: "CNY",
    licence_limit: 5,
    term_days: 365,
    monthly_quota_gb: 100,
    traffic_gb: null,
    validity_days: null,
    promo_badge: "省 17%",
    action: "buy",
    buyable: true,
    reason: null,
    next_expires_at: null,
    cta: "立即购买",
    price_note: "实付价格",
    payment_methods: [
      { id: "alipay", label: "支付宝" },
      { id: "wechat", label: "微信" },
      { id: "card", label: "银行卡" },
    ],
    store_product_id: {},
  },
] as const;
