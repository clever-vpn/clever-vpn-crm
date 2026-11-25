/**
 * 新建网关表单的 driver 规则（纯函数，便于单测）。
 *
 * 三个概念别混：
 * - **可创建 driver**：`epay_v1` / `generic_json_v1` / `stripe` / `paypal` / `mock`；
 *   `manual` 不在此列（线下到账走后台手工开通）。
 * - **固定支付方式**：Stripe / PayPal 的方式就是品牌本身，网关表单不再让用户选；
 *   `manual` 历史行同理（`transfer`）。
 * - **历史行**：编辑已有网关时，即使 driver 不在新建列表里，也要把当前值加回选项，
 *   否则 Select 会显示空的。
 */

export interface DriverOption {
  driver: string;
  methods: string[];
}

export const FIXED_DRIVER_METHODS: Record<string, string[]> = {
  stripe: ["stripe"],
  paypal: ["paypal"],
  manual: ["transfer"],
};

const CREATABLE_DRIVERS = ["epay_v1", "epay_v2", "generic_json_v1", "stripe", "paypal", "mock"] as const;

export function visibleDrivers(
  all: readonly DriverOption[],
  opts: { current?: string | null },
): DriverOption[] {
  const seen = new Set<string>();
  const out: DriverOption[] = [];
  for (const d of all) {
    if (!(CREATABLE_DRIVERS as readonly string[]).includes(d.driver)) continue;
    if (seen.has(d.driver)) continue;
    seen.add(d.driver);
    out.push(d);
  }
  if (opts.current && !out.some((d) => d.driver === opts.current)) {
    const current = all.find((d) => d.driver === opts.current);
    if (current) out.unshift(current);
  }
  return out;
}

export function showMethodPicker(driver: string): boolean {
  return !FIXED_DRIVER_METHODS[driver];
}

export function defaultMethods(driver: string, allowed: readonly string[]): string[] {
  const fixed = FIXED_DRIVER_METHODS[driver];
  return fixed ? [...fixed] : allowed.slice(0, 1);
}

export interface DriverFields {
  endpoint: boolean;
  merchant: boolean;
  secret: boolean;
  webhook: boolean;
  methods: boolean;
  /** `epay` = 高级覆盖映射；`generic` = 完整映射编辑器 */
  mapping: "epay" | "generic" | null;
  merchantLabel: string;
  secretLabel: string;
  webhookLabel: string;
}

export function driverFields(driver: string): DriverFields {
  switch (driver) {
    case "epay_v1":
      return {
        endpoint: true,
        merchant: true,
        secret: true,
        webhook: false,
        methods: true,
        mapping: "epay",
        merchantLabel: "商户号",
        secretLabel: "密钥",
        webhookLabel: "",
      };
    case "epay_v2":
      return {
        endpoint: true,
        merchant: true,
        secret: true,
        webhook: false,
        methods: true,
        mapping: null,
        merchantLabel: "商户号",
        secretLabel: "密钥 JSON（商户私钥 + 平台公钥）",
        webhookLabel: "",
      };
    case "generic_json_v1":
      return {
        endpoint: true,
        merchant: true,
        secret: true,
        webhook: false,
        methods: true,
        mapping: "generic",
        merchantLabel: "商户号",
        secretLabel: "密钥",
        webhookLabel: "",
      };
    case "stripe":
      return {
        endpoint: false,
        merchant: false,
        secret: true,
        webhook: true,
        methods: false,
        mapping: null,
        merchantLabel: "",
        secretLabel: "Secret Key",
        webhookLabel: "Webhook Secret",
      };
    case "paypal":
      return {
        endpoint: false,
        merchant: true,
        secret: true,
        webhook: true,
        methods: false,
        mapping: null,
        merchantLabel: "Client ID",
        secretLabel: "Client Secret",
        webhookLabel: "Webhook ID",
      };
    case "mock":
      return {
        endpoint: false,
        merchant: false,
        secret: false,
        webhook: false,
        methods: true,
        mapping: null,
        merchantLabel: "",
        secretLabel: "",
        webhookLabel: "",
      };
    default:
      return {
        endpoint: false,
        merchant: false,
        secret: false,
        webhook: false,
        methods: false,
        mapping: null,
        merchantLabel: "",
        secretLabel: "",
        webhookLabel: "",
      };
  }
}

export function secretFieldLabel(driver: string): string {
  return driverFields(driver).secretLabel || "密钥";
}
