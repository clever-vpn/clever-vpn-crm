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
  // 下载入口：**每平台一个官方链接**，留空 = 该平台不出现在下载页
  // （模板用 `data-if` 整卡隐藏，不做"敬请期待"占位）
  "site.download.ios": { kind: "url", max: 300 },
  "site.download.android": { kind: "url", max: 300 },
  "site.download.windows": { kind: "url", max: 300 },
  "site.download.macos": { kind: "url", max: 300 },
  "site.download.note": { kind: "text", max: 120 },
};

/** 首页大标题留空时的默认文案（避免首页出现空 `<h1>`） */
export const DEFAULT_HERO_TITLE = "连通世界，只需要一次点击。";

/** 兜底主题色：留空会拼出非法 CSS，整份样式失效 */
const DEFAULT_BRAND = "#4f46e5";

export type SiteValues = Record<string, unknown>;

export interface SiteSettings {
  /** 乐观锁版本号；`PUT` 时回传，冲突返 409 */
  rev: number;
  values: SiteValues;
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
    "SELECT `values`, rev, updated_at FROM site_settings WHERE id = ?",
  )
    .bind(SETTINGS_ROW_ID)
    .first<{ values: string; rev: number; updated_at: string }>();

  let values: SiteValues = {};
  if (row?.values) {
    try {
      const parsed = JSON.parse(row.values) as unknown;
      if (isObj(parsed)) values = parsed;
    } catch {
      // 坏 JSON 当空处理：宁可回到默认值，也不要让发布失败
    }
  }
  return { rev: Number(row?.rev ?? 0), values, updatedAt: row?.updated_at ?? null };
}

/**
 * 写设置。**整份替换**（前端表单提交全量），带 `if_rev` 做乐观锁。
 *
 * 为什么不支持部分更新：设置是"一个站的一份描述"，半份 JSON 的语义比整份更难推理；
 * 而且表单本来就是全量的。
 */
export async function saveSiteSettings(
  env: Env,
  input: { ifRev?: number; values: unknown },
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

  const rev = current.rev + 1;
  const now = new Date().toISOString();
  await env.DB.prepare(
    "INSERT INTO site_settings (id, `values`, rev, updated_at) VALUES (?, ?, ?, ?) " +
      "ON CONFLICT(id) DO UPDATE SET " +
      "`values` = excluded.`values`, rev = excluded.rev, updated_at = excluded.updated_at",
  )
    .bind(SETTINGS_ROW_ID, JSON.stringify(values), rev, now)
    .run();

  return { ok: true, settings: { rev, values, updatedAt: now } };
}

/**
 * 把设置变成**渲染作用域**：`{{site.x}}` 就在这棵树上取。
 *
 * 两件事在这里做，且只在这里做：
 *   - 空值兜默认（`hero.title` 兜文案、`theme.brand` 兜色值）
 *   - 派生值（`contact_link` / `footer`）——它们**不存库**，每次发布时算
 */
export function buildScope(
  values: SiteValues,
  fallbackName: string,
  now = new Date(),
): Record<string, unknown> {
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
      // 空串 = 没有这个平台，模板据此整块隐藏
      download: {
        ios: str(download.ios),
        android: str(download.android),
        windows: str(download.windows),
        macos: str(download.macos),
        note: str(download.note),
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
