/**
 * `GET /api/site/meta` —— 平台对外的**数据契约**。
 *
 * 契约：`clever-vpn-docs/docs/contracts/site-studio-crm.md` §4.2 / §4.4（v8）
 * 标准：`clever-vpn-docs/docs/standards/site-template.md` §3
 *
 * 一句话：**字段清单只有一份，就住在这里。** 模板（studio 产出的那包静态文件）
 * 只**引用**这些路径，不声明、不扩展；AI 也不能新增字段。
 *
 * 三个字段：
 *
 * | 字段 | 是什么 | 谁用它 |
 * |---|---|---|
 * | `contract` | 数据契约版本（字段增删改语义才 +1） | 交付时协商：模板引用的字段在不在 |
 * | `engine` | 渲染引擎 = `render.ts` 的 sha256 前 16 位（`engine.generated.ts`） | 预览与发布必须同一份 |
 * | `capabilities` | 字段路径 + kind + 上限 + 标签 | studio 的规则注入、设置面板表单 |
 *
 * **故意不含**：套餐、订阅、订单、登录态（`plans` / `orders` / `subscription` / `me`）。
 * 那是运行期数据，只能经 `window.SiteCrm` 取，不能变成可填字段 —— 否则谁都能
 * 新增一个"价格"设置项，H7（业务数字不许写死）就形同虚设。
 *
 * 这个端点**不需要鉴权也不读库**：它是平台能力的广告，不含任何租户数据。
 */

import { ENGINE_ID } from "./engine.generated";
import {
  DOWNLOAD_KINDS,
  DOWNLOAD_PLATFORMS,
  SETTING_FIELDS,
} from "./settings";

/**
 * 数据契约版本。
 *
 * 什么时候 +1：**删字段、改 kind、改上限、改语义**（破坏性）。
 * 只新增字段不算破坏性，但也要 +1 —— 老模板仍然能渲染，新模板需要新版才可用，
 * 所以交付时比对的是">= 本版本"里的**字段存在性**，不是数字相等。
 */
export const SITE_CONTRACT = 4;

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
  label: string;
}

export interface Capability extends CapabilityField {
  path: string;
  /** 留空时用这个（只对文本类有意义） */
  default?: string;
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
  "site.tagline": "一句话介绍",
  "site.contact_email": "客服邮箱",
  "site.footer_note": "页脚版权行",
  "site.hero.title": "首屏大标题",
  "site.hero.sub": "首屏副标题",
  "site.hero.layout": "首屏版式",
  "site.layout.shell": "整站外壳",
  "site.theme.brand": "主题色",
  "site.theme.bg": "背景色",
  "site.theme.text": "正文色",
  "site.icon.mark": "图标字",
  "site.icon.image": "图标图片",
  "site.download.note": "下载页补充说明",
};

/** 一条下载入口最多多少个渠道（与 `settings.ts` 的校验保持一致） */
const MAX_DOWNLOADS = 20;

/** 首页大标题留空时的默认文案 —— 与 `buildScope()` 用的是同一个常量 */
const DEFAULT_HERO_TITLE = "连通世界，只需要一次点击。";

const DEFAULTS: Record<string, string> = {
  "site.hero.title": DEFAULT_HERO_TITLE,
  "site.theme.brand": "#4f46e5",
  "site.theme.bg": "#ffffff",
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
      label: LABELS[path] ?? path,
      ...(DEFAULTS[path] ? { default: DEFAULTS[path]! } : {}),
    };
  });
}

/** 集合（烘焙进产物的一小张表）：目前只有下载入口 */
function collectionCapabilities(): Capability[] {
  return [
    {
      path: "downloads",
      kind: "collection",
      label: "下载入口",
      items: {
        max: MAX_DOWNLOADS,
        fields: {
          platform: { kind: "enum", values: DOWNLOAD_PLATFORMS, label: DOWNLOAD_LABELS.platform! },
          kind: { kind: "enum", values: DOWNLOAD_KINDS, label: DOWNLOAD_LABELS.kind! },
          label: { kind: "text", max: 24, label: DOWNLOAD_LABELS.label! },
          url: { kind: "url", max: 300, label: DOWNLOAD_LABELS.url! },
        },
      },
    },
  ];
}

/** 全部可引用路径。顺序稳定（设置字段按声明顺序，集合追加在后）。 */
export function siteCapabilities(): Capability[] {
  return [...settingsCapabilities(), ...collectionCapabilities()];
}

export interface SiteMeta {
  contract: number;
  engine: string;
  capabilities: Capability[];
}

/** 端点的响应体。纯函数 —— 没有 env、没有 DB，所以永远不会有"500 因为库挂了" */
export function siteMeta(): SiteMeta {
  return { contract: SITE_CONTRACT, engine: ENGINE_ID, capabilities: siteCapabilities() };
}
