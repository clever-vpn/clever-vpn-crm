/**
 * `GET /api/site/meta` —— 平台对外的**数据契约**。
 *
 * 契约：`clever-vpn-docs/docs/contracts/services/crm/site-studio.md` §3 / §4.4（v15）
 * 标准：`clever-vpn-docs/docs/standards/site-template.md` §3
 *
 * 一句话：**字段清单只有一份，就住在这里。** 模板（studio 产出的那包静态文件）
 * 只**引用**这些路径，不声明、不扩展；AI 也不能新增字段。
 *
 * 五个字段：
 *
 * | 字段 | 是什么 | 谁用它 |
 * |---|---|---|
 * | `contract` | 数据契约版本（字段增删改语义才 +1） | 交付时协商：模板引用的字段在不在 |
 * | `engine` | 渲染引擎 = `render.ts` 的 sha256 前 16 位（`engine.generated.ts`） | 预览与发布必须同一份 |
 * | `capabilities` | 字段路径 + kind + 上限 + 标签 + 提示 | studio 的规则注入、两个设置表单 |
 * | `palettes` | 成套配色建议（**不落库**） | 表单"一键填五个色" |
 * | `limits` | 体积上限（**唯一口径 = 整版字节**） | studio 的闸门 / 上传、CRM 的源包与产物校验 |
 *
 * **故意不含**：套餐、订阅、订单、登录态（`plans` / `orders` / `subscription` / `me`）。
 * 那是运行期数据，只能经 `window.SiteCrm` 取，不能变成可填字段 —— 否则谁都能
 * 新增一个"价格"设置项，H7（业务数字不许写死）就形同虚设。
 *
 * 这个端点**不需要鉴权也不读库**：它是平台能力的广告，不含任何租户数据。
 */

import { ENGINE_ID } from "./engine.generated";
import { SITE_LIMITS } from "./limits";
import { SDK_VERSION } from "./sdk";
import {
  DEFAULT_COLORS,
  DOWNLOAD_KINDS,
  DOWNLOAD_PLATFORMS,
  SETTING_FIELDS,
  THEME_COLORS,
} from "./settings";

/**
 * 数据契约版本。
 *
 * 什么时候 +1：**删字段、改 kind、改上限、改语义**（破坏性）。
 * 只新增字段不算破坏性，但也要 +1 —— 老模板仍然能渲染，新模板需要新版才可用，
 * 所以交付时比对的是">= 本版本"里的**字段存在性**，不是数字相等。
 */
export const SITE_CONTRACT = 8;

export type CapabilityKind =
  | "text"
  | "color"
  | "email"
  | "enum"
  | "asset"
  | "url"
  | "collection";

export interface CapabilityField {
  kind: CapabilityKind;
  max?: number;
  values?: readonly string[];
  /**
   * 与 `values` 一一对应的**人话标签**（`light` → 「浅色」）。
   *
   * 用途只有一个：表单里不该出现 `light` / `dark` 这种给代码看的词。
   * 缺省时表单回退到 `values` 本身。
   */
  value_labels?: readonly string[];
  label: string;
}

export interface Capability extends CapabilityField {
  path: string;
  /** 留空时用这个（只对文本类有意义） */
  default?: string;
  /**
   * 表单里那句**人话说明**（"用在浏览器标签页标题和页脚版权行"）。
   *
   * 放这里而不是各自的表单里：CRM 后台与 studio 面板是两张表单、一份清单，
   * 说明写在代码里就必然一边有一边没有。
   */
  hint?: string;
  /**
   * **派生值**：渲染时由引擎算出来，不存在库里、也不能填。
   *
   * 模板可以引用（`{{site.footer}}`），设置表单必须跳过（否则租户会看到一个
   * 改了也无效的输入框）。标准 `site-template.md` §3 的 `derived` 就是这几项 ——
   * 但**必须是清单的一部分**：闸门用清单判"这个路径能不能用"，漏掉就等于
   * 把一个合法模板判死（`{{site.footer}}` 就踩过这个坑）。
   */
  derived?: true;
  /** `kind === "collection"` 时：条目上限 + 每条有哪些字段 */
  items?: {
    max: number;
    fields: Record<string, CapabilityField>;
  };
}

/**
 * 人话标签。**只有这一处**：后台表单、studio 设置面板、错误提示都从这里取。
 * 新加字段时，`SETTING_FIELDS`（kind/上限）与这里（标签）一起改。
 */
const LABELS: Record<string, string> = {
  "site.name": "站点名",
  "site.legal_name": "法务主体",
  "site.contact_email": "客服邮箱",
  "site.hero.title": "首屏标题",
  "site.hero.sub": "首屏副标题",
  "site.tagline": "一句话介绍",
  "site.theme.preset": "主题",
  "site.theme.color.primary": "主色",
  "site.theme.color.accent": "强调色",
  "site.theme.color.background": "底色",
  "site.theme.color.surface": "卡片色",
  "site.theme.color.text": "正文色",
};

/**
 * 表单里那句说明。**为什么一句话要由服务端给**：同一份清单要喂两个表单
 * （CRM 后台、studio 面板），说明留在各自的组件里就等于两份措辞，迟早不一致。
 */
const HINTS: Record<string, string> = {
  "site.name": "浏览器标签页、页头与页脚都用它；短一点更好看",
  "site.legal_name": "页脚署名用，要跟工商登记一致；留空就用站点名",
  "site.contact_email": "页脚与下载页的『联系我们』；留空则不显示入口",
  "site.hero.title": "首页第一屏的大标题",
  "site.hero.sub": "大标题下面那句话，说清「是什么、给谁用」",
  "site.tagline": "只用于搜索引擎摘要与分享卡片，不进首屏",
  "site.theme.preset": "整套中性色（底色 / 卡片 / 边框）一次换好",
  "site.theme.color.primary": "按钮与强调用的品牌色；太浅会看不清白字，保存时会被拦",
  "site.theme.color.accent": "次要强调色（标签、标记、图表）",
  "site.theme.color.background": "页面底色",
  "site.theme.color.surface": "卡片 / 弹层底色，通常比底色浅或深一档",
  "site.theme.color.text": "正文文字颜色，要和底色形成足够对比",
};

/** 一条下载入口最多多少个渠道（与 `settings.ts` 的校验保持一致） */
const MAX_DOWNLOADS = 20;

/**
 * 空值兜底：与 `settings.ts` 的 `DEFAULT_COLORS` 同值。
 *
 * 这边是"表单上显示什么"，那边是"真的没填时渲染什么"—— 两处必须一致
 * （`test/site-settings-fields.test.ts` 对过）。
 */
const DEFAULTS: Record<string, string> = {
  "site.theme.preset": "light",
  ...Object.fromEntries(THEME_COLORS.map((key) => [`site.theme.color.${key}`, DEFAULT_COLORS[key]])),
};

/** 枚举值的人话（顺序与 `SETTING_FIELDS` 里的 `values` 一致） */
const ENUM_LABELS: Record<string, readonly string[]> = {
  "site.theme.preset": ["浅色", "深色"],
};

const DOWNLOAD_LABELS: Record<string, string> = {
  platform: "平台",
  kind: "类型",
  label: "按钮文字",
  url: "链接",
};

/** 设置字段清单（kind / 上限 / 枚举值 全部来自 `SETTING_FIELDS`，不重复一遍） */
function settingsCapabilities(): Capability[] {
  return Object.entries(SETTING_FIELDS).map(([path, spec]) => {
    const spec2 = spec as { kind: CapabilityKind; max?: number; values?: readonly string[] };
    return {
      path,
      kind: spec2.kind,
      ...(spec2.max !== undefined ? { max: spec2.max } : {}),
      ...(spec2.values ? { values: spec2.values } : {}),
      ...(ENUM_LABELS[path] ? { value_labels: ENUM_LABELS[path]! } : {}),
      label: LABELS[path] ?? path,
      ...(DEFAULTS[path] ? { default: DEFAULTS[path]! } : {}),
      ...(HINTS[path] ? { hint: HINTS[path]! } : {}),
    };
  });
}

const PLATFORM_LABEL: Record<string, string> = {
  ios: "iOS",
  android: "Android",
  windows: "Windows",
  macos: "macOS",
};

/**
 * 集合（烘焙进产物的一小张表）：下载入口。
 *
 * **路径是 `site.download.<平台>`，不是 `downloads`。** 数据库里叫 `downloads`，但
 * `buildScope()` 会按平台分组 —— 模板真正能引用的是渲染作用域里的那个形状。
 * 这一点必须写成"scope 的路径"，否则闸门会放行一个渲染出来是空白的路径
 * （或者拦下一个本来能用的）。
 */
function collectionCapabilities(): Capability[] {
  const fields = {
    platform: { kind: "enum" as const, values: DOWNLOAD_PLATFORMS, label: DOWNLOAD_LABELS.platform! },
    kind: { kind: "enum" as const, values: DOWNLOAD_KINDS, label: DOWNLOAD_LABELS.kind! },
    label: { kind: "text" as const, max: 24, label: DOWNLOAD_LABELS.label! },
    url: { kind: "url" as const, max: 300, label: DOWNLOAD_LABELS.url! },
  };
  return DOWNLOAD_PLATFORMS.map((platform) => ({
    path: `site.download.${platform}`,
    kind: "collection" as const,
    label: `下载入口 · ${PLATFORM_LABEL[platform] ?? platform}`,
    items: { max: MAX_DOWNLOADS, fields },
  }));
}

/**
 * 派生值：由引擎算，不进库、不可填。与标准 `site-template.md` §3 的 `derived` 对齐。
 *
 * 为什么要把它们放进 `capabilities`：闸门判"模板能不能引用这个路径"用的就是这份
 * 清单。漏声明 = 把一份**合法**模板判成 `unknown_path`（`{{site.footer}}` 就是这么
 * 被拦的）。
 *
 * 两项：
 *
 *   · `site.footer` —— `© <年> <法务主体或站名>`。`contact_link` 曾经也派生过，后来
 *     去掉了：渲染器对所有取值统一转义，值里带 `<a>` 只会变成 `&lt;a`。
 *   · `site.theme.brand` —— `contract: 8` 把主色改名为 `site.theme.color.primary`，
 *     旧路径留成派生别名（值就是 primary）。已发布的模板里还有 `{{site.theme.brand}}`，
 *     删掉就等于让所有老站点下次发布会 `unknown_path` 直接失败。
 */
function derivedCapabilities(): Capability[] {
  return [
    { path: "site.footer", kind: "text", label: "页脚版权行（自动）", derived: true },
    { path: "site.theme.brand", kind: "color", label: "主色（旧路径别名）", derived: true },
  ];
}

/** 一套配色建议：五个令牌的值，**不落库**（存的是色值，不是方案名） */
export interface Palette {
  id: string;
  label: string;
  colors: Record<(typeof THEME_COLORS)[number], string>;
}

/**
 * 成套配色建议。表单拿它当"一键填五个色"，租户改哪个色都不影响这里。
 *
 * 为什么要有：五个令牌是**一套**（标准 §3.2 判据 4），让非技术租户从零挑五个
 * 互不打架的颜色是不现实的；给几套现成的，他只需要选"像不像我"。
 */
const PALETTES: readonly Palette[] = [
  { id: "indigo", label: "靛蓝", colors: { ...DEFAULT_COLORS } },
  {
    id: "ocean",
    label: "海洋",
    colors: {
      primary: "#0369a1",
      accent: "#0891b2",
      background: "#f8fafc",
      surface: "#ffffff",
      text: "#0f172a",
    },
  },
  {
    id: "forest",
    label: "森林",
    colors: {
      primary: "#047857",
      accent: "#0d9488",
      background: "#f7faf7",
      surface: "#ffffff",
      text: "#111827",
    },
  },
];

/** 全部可引用路径。顺序稳定（设置字段 → 集合 → 派生值）。 */
export function siteCapabilities(): Capability[] {
  return [...settingsCapabilities(), ...collectionCapabilities(), ...derivedCapabilities()];
}

export interface SiteMeta {
  contract: number;
  engine: string;
  /** 平台 SDK 的版本（`/_crm/sdk.js` 里的 `SiteCrm.version`）—— 预览与线上对账用 */
  sdk_version: string;
  capabilities: Capability[];
  /** 成套配色建议：表单用，**不落库** */
  palettes: Palette[];
  /**
   * 体积上限：**唯一口径 = 整版字节**（文本 + 素材）。
   *
   * 放在这里而不是各自写常量：studio 的闸门/上传与 CRM 的源包/产物校验必须同一个数，
   * 分开写就是几份会漂移的常量（标准 `site-template.md` §9）。
   */
  limits: typeof SITE_LIMITS;
}

/** 端点的响应体。纯函数 —— 没有 env、没有 DB，所以永远不会有"500 因为库挂了" */
export function siteMeta(): SiteMeta {
  return {
    contract: SITE_CONTRACT,
    engine: ENGINE_ID,
    // 与 `/_crm/sdk.js` 同一个常量：租户排障时"这个站跑的是哪版 SDK"一眼可查；
    // studio 预览用它证明"预览与线上是同一份 SDK"（site-crm.md §3.1）。
    sdk_version: SDK_VERSION,
    capabilities: siteCapabilities(),
    palettes: [...PALETTES],
    limits: SITE_LIMITS,
  };
}
