/**
 * 站点设置：**发布时烘焙进产物**，运行时不再回填。
 *
 * 规范：`clever-vpn-docs/docs/standards/site-template.md` §3
 * 契约：`clever-vpn-docs/docs/contracts/services/crm/site.md` §0.1
 *
 * **装"租户事实"**（契约 `contract: 8`）：站点名 / 法务主体 / 首屏标题与副标题 /
 * 一句话介绍 / 客服邮箱 / 主题与五个颜色令牌。判据见
 * `clever-vpn-docs/docs/standards/site-template.md` §3.2：
 *
 *   1. **文件 vs 事实**：改它要动模板文件 ⇒ studio 改；它是租户关于自己的一个事实
 *      （叫什么、主体是谁、什么颜色、怎么联系）⇒ 放这里；
 *   2. **首屏可见的进 setting，哪怕只出现一次** —— 首屏是租户最想改、也最容易看出
 *      "改了没变"的一屏，所以 `site.hero.*` 进（`contract: 7` 曾按"单页单处"删掉）。
 *
 * 结构决策（顶部导航还是侧边栏、首屏排布）仍然不进这里：那是编辑期的事。
 *
 * 三条约定：
 *  1. **单行 JSON + `rev` 乐观锁**：`site_settings.values` 是唯一事实，`rev` 每写一次 +1。
 *     CRM 后台与 studio 都能改，`PUT` 带 `if_rev`，不匹配返 `409`。
 *  2. **键 = 模板里写的路径**：`site.hero.title` 就是 `{{site.hero.title}}` 里的那一段，
 *     不需要任何映射表（`SETTING_FIELDS` 与模板包的 `data.schema.json` 同构）。
 *  3. **空值 = 用默认值**：默认值只在 `buildScope()` 里兜，不写进数据库。
 */
import type { Env } from "../env";

export const SETTINGS_ROW_ID = 1;

type Kind = "text" | "color" | "email" | "enum" | "asset" | "url";

interface FieldSpec {
  kind: Kind;
  max?: number;
  values?: readonly string[];
  /**
   * **站点工程配置，不是模板可见的内容字段。**
   *
   * 有这个标记的路径：不进 `capabilities`（模板不能引用）、
   * 不算 `unused_settings`（它本来就不该出现在页面里）。
   * 它仍然走同一张表、同一个校验、同一个 rev —— 只是"不由模板消费"。
   */
  internal?: true;
}

/**
 * 主题预设：中性色底盘（底色 / 卡片 / 边框 / 次要文字）整套换。
 *
 * 颜色令牌（`site.theme.color.*`）在它之上做品牌覆盖：`preset` 决定"浅色还是深色"，
 * 五个令牌决定"这个租户长什么样"。
 */
export const THEME_PRESETS = ["light", "dark"] as const;
export type ThemePreset = (typeof THEME_PRESETS)[number];

/**
 * 已知设置字段 = **数据契约本身**（契约 `site-studio-crm.md` §4.4）。
 *
 * 这份清单**只住在这里**：模板（studio 产出的静态文件包）只引用路径，不声明字段；
 * AI 也不能新增字段 —— 加一个可编辑项是**平台动作**（+`SITE_CONTRACT`、过评审、
 * 影响所有站点），不是某次设计对话的副作用。
 *
 * 对外形态：`GET /api/site/meta` 的 `capabilities`（见 `src/site/meta.ts`）。
 * 改这里时同时补 `meta.ts` 的 `LABELS`（人话标签）与 `HINTS`（表单里那句说明），
 * 否则表单会回退成路径本身。
 *
 * 顺序 = 表单里的顺序：身份 → 首屏 → SEO → 视觉。
 */
export const SETTING_FIELDS: Record<string, FieldSpec> = {
  // ── 身份：全站一份，出现在多个页面 ──
  "site.name": { kind: "text", max: 24 },
  // 法务主体：页脚署名用。站名可以不等于主体名（"云端加速" vs "上海某某网络科技有限公司"）
  "site.legal_name": { kind: "text", max: 40 },
  "site.contact_email": { kind: "email", max: 120 },
  // ── 首屏：只出现一次，但首屏可见 ⇒ 进 setting（§3.2 的例外）──
  "site.hero.title": { kind: "text", max: 24 },
  "site.hero.sub": { kind: "text", max: 60 },
  // ── SEO / 分享：只进 <meta name="description"> 与分享卡片，不上首屏 ──
  "site.tagline": { kind: "text", max: 120 },
  // ── 视觉：中性色底盘 + 五个品牌颜色令牌 ──
  "site.theme.preset": { kind: "enum", values: THEME_PRESETS },
  "site.theme.color.primary": { kind: "color" },
  "site.theme.color.accent": { kind: "color" },
  "site.theme.color.background": { kind: "color" },
  "site.theme.color.surface": { kind: "color" },
  "site.theme.color.text": { kind: "color" },
  // ── 集成：站点工程配置（internal，不进模板）──
  //
  // Cloudflare Zaraz 的加载器：`1` = 在页面的 </head> 前插一行
  // `<script src="/cdn-cgi/zaraz/i.js" referrerpolicy="origin">`。
  // 为什么是我们插而不是 CF 自动插：Zaraz 的自动注入只改写**源站**响应，
  // 而我们的站点是 Worker 返回的 HTML（2026-11-19 实测 + 官方文档的口径）。
  "site.integrations.zaraz": { kind: "text", max: 1, internal: true },
};

/** 这个路径是不是"站点工程配置"（不进模板、不算未使用） */
export function isInternalSetting(path: string): boolean {
  return SETTING_FIELDS[path]?.internal === true;
}

/**
 * 起始品牌内容：**没有设置行时**返回这一套。
 *
 * 为什么不是"空"：模板是给租户直接用的起点，打开就该像一个正经的品牌站，
 * 而不是"我的站点"加空字段。这些值不落库 —— 租户一保存就被自己的值覆盖。
 *
 * 为什么不是"测试数据"：它是一套完整的、可上线的文案（名字 / 主体 / 邮箱 /
 * 标语 / 首屏 / 主题），租户要做的只是把"云桥"换成自己。真实数字（价格、流量）
 * 一个都没有 —— 那些来自套餐与数据钩子，不在这份设置里。
 */
export const STARTER_SETTINGS: SiteValues = {
  site: {
    name: "云桥VPN",
    legal_name: "云桥网络科技有限公司",
    contact_email: "support@yunqiao.app",
    tagline: "小团队的稳定加速服务，不记浏览日志。",
    hero: {
      title: "快得不像 VPN",
      sub: "一个账号，三端通用；连上就不用管了。",
    },
    theme: {
      preset: "dark",
      color: { primary: "#0f766e", accent: "#14b8a6" },
    },
  },
};

/**
 * 颜色令牌：**一套五个**，不是散装色值。
 *
 * `contract: 7` 只留 preset、其余中性色硬编码，那时给一个"底色"字段必然出现
 * "深色底 + 浅灰卡片"；现在五个一起给，模板按 CSS 变量整套消费（标准 §3.2）。
 */
export const THEME_COLORS = ["primary", "accent", "background", "surface", "text"] as const;
export type ThemeColor = (typeof THEME_COLORS)[number];

/**
 * **每个主题的中性色底盘**：某个颜色令牌没填时用它。
 *
 * 为什么按主题分开：`preset` 是"浅色还是深色"的整套中性色。如果所有主题共用一组
 * 兜底值，选了深色主题但没单独挑颜色的站会得到"白底 + 深色边框"的花屏。所以
 * "没填"的含义是**跟随主题**，不是"用某个固定色"。
 *
 * 表单把没填的项显示成什么见 `meta.ts` 的 `DEFAULTS`（只给 primary / accent ——
 * 这两个在深浅两套里含义相同；另外三个留空才是正确的默认）。
 */
export const PRESET_COLORS: Record<ThemePreset, Record<ThemeColor, string>> = {
  light: {
    primary: "#4f46e5",
    accent: "#0ea5e9",
    background: "#ffffff",
    surface: "#ffffff",
    text: "#0d1626",
  },
  dark: {
    primary: "#6366f1",
    accent: "#22d3ee",
    background: "#0b1020",
    surface: "#141d31",
    text: "#e8eefc",
  },
};

/** 浅色底盘（配色建议 `palettes` 与测试拿它当基准） */
export const DEFAULT_COLORS: Record<ThemeColor, string> = PRESET_COLORS.light;

/** 主色上的文字永远是白色（按钮），所以对比度按白字算 */
const ON_PRIMARY = "#ffffff";
/**
 * 主色配白字的最低对比度。3:1 是 WCAG 对大号粗体 / 图形的最低门槛；再低就是
 * "按钮看得见但字看不清"。低于它**拒绝保存**，因为界面上没有警告通道，
 * 而静默接受等于让租户发布一个读不出字的按钮。
 *
 * 只查 `primary`：另外四个令牌目前还没有被种子消费，先别为还没接上的东西定门槛。
 */
const MIN_CONTRAST = 3;

export type SiteValues = Record<string, unknown>;

// ── 集合：下载入口 ──────────────────────────────────────────────
//
// 为什么是集合而不是"每平台一个 URL"：同一平台天然有多个渠道（App Store /
// TestFlight / 官网直链 / 历史版本）。用设置字段只能选一个，租户就会回去改模板。
//
// 平台与渠道都是**封闭集合**：模板按平台分区块（`data-repeat="site.download.ios"`），
// 平台名就是区块名，不能自由填写。

export const DOWNLOAD_PLATFORMS = ["ios", "android", "windows", "macos"] as const;
export const DOWNLOAD_KINDS = ["store", "file"] as const;
/** 一条下载入口。`label` 空着时按 `kind` 兜文案，所以可选 */
export interface DownloadItem {
  platform: string;
  kind: string;
  label: string;
  url: string;
}
export interface SiteCollections {
  downloads: DownloadItem[];
}
export const EMPTY_COLLECTIONS: SiteCollections = { downloads: [] };
/** 一条下载条目最多 20 个渠道：够用，且渲染出来还看得下去 */
const MAX_DOWNLOADS = 20;
const MAX_LABEL = 24;

export interface SiteSettings {
  /** 乐观锁版本号；`PUT` 时回传，冲突返 409 */
  rev: number;
  values: SiteValues;
  collections: SiteCollections;
  updatedAt: string | null;
}

export type SaveResult =
  | { ok: true; settings: SiteSettings }
  | { ok: false; code: string; message: string };

const HEX = /^#[0-9a-fA-F]{6}$/;
const EMAIL = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;
/**
 * 只收 http(s)。允许 `//host/path` 这种协议相对写法会跟着站点域名走，
 * 换个域名就指向错地方；`javascript:` / `data:` 更不能进 `href`。
 */
const URL_RE = /^https?:\/\/[^\s"'<>]+$/i;

const isObj = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

/** 把嵌套对象摊成 `a.b.c → 值`，只认 schema 声明过的路径 */
function flatten(v: unknown, prefix = "", out: Record<string, unknown> = {}) {
  if (!isObj(v)) return out;
  for (const [k, val] of Object.entries(v)) {
    const path = prefix ? `${prefix}.${k}` : k;
    if (isObj(val)) flatten(val, path, out);
    else out[path] = val;
  }
  return out;
}

/** 按路径写值（自动建中间层） */
function setPath(target: Record<string, unknown>, path: string, value: unknown) {
  const segs = path.split(".");
  let cur: Record<string, unknown> = target;
  for (const seg of segs.slice(0, -1)) {
    if (!isObj(cur[seg])) cur[seg] = {};
    cur = cur[seg] as Record<string, unknown>;
  }
  const last = segs[segs.length - 1];
  if (last !== undefined) cur[last] = value;
}

/** sRGB 相对亮度（WCAG 2.1 定义）—— 对比度就靠它 */
function luminance(hex: string): number {
  const n = Number.parseInt(hex.slice(1), 16);
  const channel = (v: number): number => {
    const c = v / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  };
  const r = (n >> 16) & 0xff;
  const g = (n >> 8) & 0xff;
  const b = n & 0xff;
  return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
}

/** 两个 `#rrggbb` 的对比度（1…21）。输入必须已通过 HEX 校验 */
function contrast(a: string, b: string): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi! + 0.05) / (lo! + 0.05);
}

/** 只做技术校验：长度、格式、枚举、对比度。不判断"这个名字好不好" */
function validate(flat: Record<string, unknown>): { code: string; message: string } | null {
  for (const [path, value] of Object.entries(flat)) {
    const spec = SETTING_FIELDS[path];
    if (!spec) return { code: "unknown_field", message: `未知设置项：${path}` };
    if (value === null || value === undefined) continue;
    if (typeof value !== "string") {
      return { code: "bad_value", message: `${path} 必须是字符串` };
    }
    const text = value.trim();
    if (spec.max !== undefined && text.length > spec.max) {
      return { code: "too_long", message: `${path} 最多 ${spec.max} 个字符` };
    }
    if (spec.kind === "color" && text && !HEX.test(text)) {
      return { code: "bad_color", message: `${path} 必须是 #rrggbb` };
    }
    if (spec.kind === "email" && text && !EMAIL.test(text)) {
      return { code: "bad_email", message: `${path} 邮箱格式不对` };
    }
    if (spec.kind === "url" && text && !URL_RE.test(text)) {
      return {
        code: "bad_url",
        message: `${path} 必须以 https:// 或 http:// 开头`,
      };
    }
    if (spec.kind === "enum" && text && !(spec.values ?? []).includes(text)) {
      return {
        code: "bad_enum",
        message: `${path} 只能是 ${(spec.values ?? []).join(" / ")}`,
      };
    }
    if (path === "site.theme.color.primary" && text && HEX.test(text)) {
      const ratio = contrast(text, ON_PRIMARY);
      if (ratio < MIN_CONTRAST) {
        return {
          code: "bad_contrast",
          message: `这个色太浅了：按钮上的白字看不清（对比度 ${ratio.toFixed(1)}:1，至少要 ${MIN_CONTRAST}:1），换深一点的颜色`,
        };
      }
    }
  }
  return null;
}

/**
 * 校验一份设置值（摊平后逐项查表）。返回第一个问题，没有就是 `null`。
 *
 * 单独导出是因为它是**契约的判定**：测试要能直接问"这个值能不能存"，
 * 而不必为每条规则造一个 D1。
 */
export function validateValues(values: unknown): { code: string; message: string } | null {
  if (!isObj(values)) return { code: "bad_values", message: "values 必须是对象" };
  return validate(flatten(values));
}

/**
 * 「设了值」的路径 → 文本值（空串不算设了）。
 *
 * 给 S2 用：判断"这个设置到底有没有被模板消费"必须从**设了值的路径**出发，
 * 而不是从 schema 出发 —— 没填的字段当然不会出现在产物里。
 */
export function setValues(values: SiteValues): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [path, value] of Object.entries(flatten(values))) {
    const text = typeof value === "string" ? value.trim() : "";
    if (text) out[path] = text;
  }
  return out;
}

/**
 * 规范化并校验下载条目。**整份替换**：前端提交什么就是什么，顺序即展示顺序。
 *
 * 归一化的三件事（都在这里做，读的时候不再兜）：
 *   - `platform` / `kind` 必须是封闭集合里的值
 *   - `url` 必须以 http(s) 开头（`javascript:` 会被写进 `href`）
 *   - `label` 空着时按 `kind` 兜一个：商店 → 应用商店，文件 → 直接下载
 */
function normalizeDownloads(
  raw: unknown,
): { ok: true; items: DownloadItem[] } | { ok: false; code: string; message: string } {
  if (raw === undefined || raw === null) return { ok: true, items: [] };
  if (!Array.isArray(raw)) {
    return { ok: false, code: "bad_collection", message: "downloads 必须是数组" };
  }
  if (raw.length > MAX_DOWNLOADS) {
    return {
      ok: false,
      code: "too_many",
      message: `下载入口最多 ${MAX_DOWNLOADS} 条`,
    };
  }
  const items: DownloadItem[] = [];
  for (const [i, entry] of raw.entries()) {
    const idx = i + 1;
    if (!isObj(entry)) {
      return { ok: false, code: "bad_collection", message: `第 ${idx} 条不是对象` };
    }
    const platform = typeof entry.platform === "string" ? entry.platform.trim() : "";
    if (!(DOWNLOAD_PLATFORMS as readonly string[]).includes(platform)) {
      return {
        ok: false,
        code: "bad_platform",
        message: `第 ${idx} 条的平台只能是 ${DOWNLOAD_PLATFORMS.join(" / ")}`,
      };
    }
    const kind = typeof entry.kind === "string" ? entry.kind.trim() : "";
    if (!(DOWNLOAD_KINDS as readonly string[]).includes(kind)) {
      return {
        ok: false,
        code: "bad_kind",
        message: `第 ${idx} 条的渠道只能是 ${DOWNLOAD_KINDS.join(" / ")}`,
      };
    }
    const url = typeof entry.url === "string" ? entry.url.trim() : "";
    if (!url) {
      return { ok: false, code: "bad_url", message: `第 ${idx} 条缺少链接` };
    }
    if (url.length > 300 || !URL_RE.test(url)) {
      return {
        ok: false,
        code: "bad_url",
        message: `第 ${idx} 条的链接必须以 https:// 或 http:// 开头（最长 300 字符）`,
      };
    }
    const rawLabel = typeof entry.label === "string" ? entry.label.trim() : "";
    if (rawLabel.length > MAX_LABEL) {
      return {
        ok: false,
        code: "too_long",
        message: `第 ${idx} 条的按钮文字最多 ${MAX_LABEL} 个字符`,
      };
    }
    items.push({
      platform,
      kind,
      label: rawLabel || (kind === "store" ? "应用商店" : "直接下载"),
      url,
    });
  }
  return { ok: true, items };
}

const trimLeaves = (v: unknown): unknown => {
  if (isObj(v)) {
    const out: Record<string, unknown> = {};
    for (const [k, val] of Object.entries(v)) out[k] = trimLeaves(val);
    return out;
  }
  return typeof v === "string" ? v.trim() : v;
};

/** 读设置；没有这一行就返回空 values（默认值在 `buildScope` 里兜） */
export async function readSiteSettings(env: Env): Promise<SiteSettings> {
  // `values` 是 SQLite 保留字（INSERT ... VALUES），必须加反引号
  const row = await env.DB.prepare(
    "SELECT `values`, collections, rev, updated_at FROM site_settings WHERE id = ?",
  )
    .bind(SETTINGS_ROW_ID)
    .first<{
      values: string;
      collections: string;
      rev: number;
      updated_at: string;
    }>();

  let values: SiteValues = {};
  let collections: SiteCollections = EMPTY_COLLECTIONS;
  try {
    const parsed = JSON.parse(row?.values ?? "{}") as unknown;
    if (isObj(parsed)) values = parsed;
  } catch {
    // 坏 JSON 当空处理：宁可回到默认值，也不要让发布失败
  }
  try {
    const parsed = JSON.parse(row?.collections ?? "{}") as unknown;
    const items = isObj(parsed) ? parsed.downloads : null;
    if (Array.isArray(items)) {
      collections = { downloads: items as DownloadItem[] };
    }
  } catch {
    // 同上
  }
  // 没有设置行 = 新装环境：给它一套完整的起始品牌，而不是空字段
  if (!row) {
    return {
      rev: 0,
      values: STARTER_SETTINGS,
      collections: EMPTY_COLLECTIONS,
      updatedAt: null,
    };
  }
  return {
    rev: Number(row?.rev ?? 0),
    values,
    collections,
    updatedAt: row?.updated_at ?? null,
  };
}

/**
 * 写设置。**整份替换**（前端表单提交全量），带 `if_rev` 做乐观锁。
 *
 * 为什么不支持部分更新：设置是"一个站的一份描述"，半份 JSON 的语义比整份更难推理；
 * 而且表单本来就是全量的。
 */
export async function saveSiteSettings(
  env: Env,
  input: { ifRev?: number; values: unknown; collections?: unknown },
): Promise<SaveResult> {
  if (!isObj(input.values)) {
    return { ok: false, code: "bad_values", message: "values 必须是对象" };
  }
  const current = await readSiteSettings(env);
  if (typeof input.ifRev === "number" && input.ifRev !== current.rev) {
    return {
      ok: false,
      code: "rev_conflict",
      message: "设置已被别处修改，请刷新后重试",
    };
  }

  const values = trimLeaves(input.values) as SiteValues;
  const bad = validateValues(values);
  if (bad) return { ok: false, code: bad.code, message: bad.message };

  // 集合：**没传就保持原样**（老客户端只发 settings 时不该把下载入口清空）
  let collections = current.collections;
  if (input.collections !== undefined) {
    const raw = isObj(input.collections) ? input.collections.downloads : input.collections;
    const norm = normalizeDownloads(raw);
    if (!norm.ok) return { ok: false, code: norm.code, message: norm.message };
    collections = { downloads: norm.items };
  }

  const rev = current.rev + 1;
  const now = new Date().toISOString();
  await env.DB.prepare(
    "INSERT INTO site_settings (id, `values`, collections, rev, updated_at) " +
      "VALUES (?, ?, ?, ?, ?) " +
      "ON CONFLICT(id) DO UPDATE SET " +
      "`values` = excluded.`values`, collections = excluded.collections, " +
      "rev = excluded.rev, updated_at = excluded.updated_at",
  )
    .bind(
      SETTINGS_ROW_ID,
      JSON.stringify(values),
      JSON.stringify(collections),
      rev,
      now,
    )
    .run();

  return { ok: true, settings: { rev, values, collections, updatedAt: now } };
}

/**
 * 把设置变成**渲染作用域**：`{{site.x}}` 就在这棵树上取。
 *
 * 这里只做两件事：空值兜默认、算派生值（`footer` / `brand` 不存库）。
 *
 * `contract: 8` 的判据是"文件 vs 事实"，所以这棵树装的是**租户关于自己的事实**：
 * 叫什么（name）、主体是谁（legal_name）、首屏说什么（hero）、什么颜色（theme）、
 * 怎么联系（contact_email）。结构、排布、一次性文案仍然在模板文件里。
 */
export function buildScope(
  settings: { values: SiteValues; collections?: SiteCollections },
  fallbackName: string,
  now = new Date(),
): Record<string, unknown> {
  const values = settings.values;
  const downloads = settings.collections?.downloads ?? [];
  const site = isObj(values.site) ? values.site : {};
  const theme = isObj(site.theme) ? site.theme : {};

  const str = (v: unknown): string => (typeof v === "string" ? v : "");
  const name = str(site.name) || fallbackName;
  const legalName = str(site.legal_name);
  const hero = isObj(site.hero) ? site.hero : {};
  // 只有封闭集合里的值才算数：写错一个字母就让整站掉回亮色（模板里
  // `:root.<preset>` 找不到类名 ⇒ 用默认那套）
  const preset: ThemePreset = (THEME_PRESETS as readonly string[]).includes(str(theme.preset))
    ? (str(theme.preset) as ThemePreset)
    : "light";
  const color = isObj(theme.color) ? theme.color : {};
  // 五个令牌各自兜底：**空的含义是"跟随主题"**（见 PRESET_COLORS）。
  // 不能留空串 —— `--bg: ;` 是非法 CSS，整份样式会失效。
  const colors = Object.fromEntries(
    THEME_COLORS.map((key) => [key, str(color[key]) || PRESET_COLORS[preset][key]]),
  ) as Record<ThemeColor, string>;

  return {
    site: {
      name,
      legal_name: legalName,
      hero: {
        // 没填就回落到站名：首屏大标题空着 = 页面上一个空洞，比"重复站名"更糟
        title: str(hero.title) || name,
        // 副标题留空就是留空：模板用 `data-if` 把整段收起来
        sub: str(hero.sub),
      },
      // 只做 SEO / 分享：模板里的 `<meta name="description">` 与 og 卡片读它，首屏不读
      tagline: str(site.tagline),
      contact_email: str(site.contact_email),
      theme: {
        preset,
        color: colors,
      },
      // 下载入口按**平台分组**：模板写 `data-if="site.download.ios"` 决定整块
      // 出不出现，写 `data-repeat="site.download.ios"` 决定这一平台有几个按钮。
      // 空数组 = 这个平台没有入口（`data-if` 把空数组也当空，见 `render.ts`）。
      download: Object.fromEntries(
        DOWNLOAD_PLATFORMS.map((p) => [p, downloads.filter((d) => d.platform === p)]),
      ),
      // ── 派生：不存库，发布时算 ──
      //
      // 只派生**纯文本**。曾经这里有个 `contact_link`（整段 `<a>`），现在去掉了：
      // 渲染器对所有取值统一转义，值里带标签只会被转义成一堆 `&lt;a` ——
      // 要么放开转义（XSS 口子），要么就别在数据里放标记。模板自己写
      // `<a href="mailto:{{site.contact_email}}">`。
      // 署名优先用法务主体（工商登记名），没有才退回站名
      footer: `© ${now.getFullYear()} ${legalName || name}`,
    },
  };
}
