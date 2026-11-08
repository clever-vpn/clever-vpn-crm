/**
 * 站点设置：**发布时烘焙进产物**，运行时不再回填。
 *
 * 规范：`clever-vpn-docs/docs/standards/site-template.md` §3
 * 契约：`clever-vpn-docs/docs/contracts/site-crm.md` §0.1
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
}

/**
 * 已知设置字段：**加字段先改这里，再改模板**。
 * 将来由模板包里的 `data.schema.json` 驱动，届时删掉这份常量。
 */
export const SETTING_FIELDS: Record<string, FieldSpec> = {
  "site.name": { kind: "text", max: 40 },
  "site.tagline": { kind: "text", max: 120 },
  "site.contact_email": { kind: "email", max: 120 },
  "site.footer_note": { kind: "text", max: 80 },
  "site.hero.title": { kind: "text", max: 40 },
  "site.hero.sub": { kind: "text", max: 120 },
  "site.hero.layout": { kind: "enum", values: ["split", "center", "stack"] },
  "site.layout.shell": { kind: "enum", values: ["top", "side", "bare"] },
  "site.theme.brand": { kind: "color" },
  "site.theme.bg": { kind: "color" },
  "site.theme.text": { kind: "color" },
  "site.icon.mark": { kind: "text", max: 8 },
  "site.icon.image": { kind: "asset", max: 200 },
  // 下载页的说明文字（入口本身是**集合** `downloads`，见 `DownloadItem`）
  "site.download.note": { kind: "text", max: 120 },
};

/** 首页大标题留空时的默认文案（避免首页出现空 `<h1>`） */
export const DEFAULT_HERO_TITLE = "连通世界，只需要一次点击。";

/** 兜底主题色：留空会拼出非法 CSS，整份样式失效 */
const DEFAULT_BRAND = "#4f46e5";

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

/** 只做技术校验：长度、格式、枚举。不判断"这个名字好不好" */
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
  }
  return null;
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
  const flat = flatten(values);
  const bad = validate(flat);
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
 * 两件事在这里做，且只在这里做：
 *   - 空值兜默认（`hero.title` 兜文案、`theme.brand` 兜色值）
 *   - 派生值（`contact_link` / `footer`）——它们**不存库**，每次发布时算
 */
export function buildScope(
  settings: { values: SiteValues; collections?: SiteCollections },
  fallbackName: string,
  now = new Date(),
): Record<string, unknown> {
  const values = settings.values;
  const downloads = settings.collections?.downloads ?? [];
  const site = isObj(values.site) ? values.site : {};
  const hero = isObj(site.hero) ? site.hero : {};
  const layout = isObj(site.layout) ? site.layout : {};
  const theme = isObj(site.theme) ? site.theme : {};
  const icon = isObj(site.icon) ? site.icon : {};
  const download = isObj(site.download) ? site.download : {};

  const str = (v: unknown): string => (typeof v === "string" ? v : "");
  const name = str(site.name) || fallbackName;
  const email = str(site.contact_email);
  const footerNote = str(site.footer_note);

  return {
    site: {
      name,
      tagline: str(site.tagline),
      contact_email: email,
      footer_note: footerNote,
      hero: {
        title: str(hero.title) || DEFAULT_HERO_TITLE,
        sub: str(hero.sub),
        layout: str(hero.layout) || "split",
      },
      layout: { shell: str(layout.shell) || "top" },
      theme: {
        brand: str(theme.brand) || DEFAULT_BRAND,
        bg: str(theme.bg) || "#ffffff",
        text: str(theme.text) || "#0d1626",
      },
      icon: { mark: str(icon.mark), image: str(icon.image) || null },
      // 下载入口按**平台分组**：模板写 `data-if="site.download.ios"` 决定整块
      // 出不出现，写 `data-repeat="site.download.ios"` 决定这一平台有几个按钮。
      // 空数组 = 这个平台没有入口（`data-if` 把空数组也当空，见 `render.ts`）。
      download: {
        note: str(download.note),
        ...Object.fromEntries(
          DOWNLOAD_PLATFORMS.map((p) => [
            p,
            downloads.filter((d) => d.platform === p),
          ]),
        ),
      },
      // ── 派生：不存库，发布时算 ──
      //
      // 只派生**纯文本**。曾经这里有个 `contact_link`（整段 `<a>`），现在去掉了：
      // 渲染器对所有取值统一转义，值里带标签只会被转义成一堆 `&lt;a` ——
      // 要么放开转义（XSS 口子），要么就别在数据里放标记。模板自己写 `<a href="mailto:{{site.contact_email}}">`。
      footer: footerNote || `© ${now.getFullYear()} ${name}`,
    },
  };
}
