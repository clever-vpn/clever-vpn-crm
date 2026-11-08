/**
 * 站点品牌设置：**发布时烘焙进产物**，运行时不再回填。
 *
 * 契约：`clever-vpn-docs/docs/contracts/site-crm.md` §0.1（静态数据 vs 动态数据）。
 *
 * 为什么是"发布时才生效"：站点是静态文件，改这里不会立刻改变线上 —— 需要重新发布。
 * 页面必须把这句话说清楚，否则租户会以为"点了保存就该变"。
 */
import type { Env } from "../env";

export interface SiteSettings {
  siteName: string;
  tagline: string;
  /** 首页大标题；空 = 用模板默认文案 */
  heroTitle: string | null;
  /** 首页副标题；空 = 不显示 */
  heroSub: string | null;
  /** `#rrggbb`；空 = 用模板默认 */
  color: string | null;
  contactEmail: string | null;
  /** 版权行；空 = 自动 `© <年> <站点名>` */
  footerNote: string | null;
  updatedAt: string | null;
}

export const SETTINGS_ROW_ID = 1;

/** 首页大标题的默认文案：租户没配时用它，避免首页出现空标题 */
export const DEFAULT_HERO_TITLE = "连通世界，只需要一次点击。";

const HEX = /^#[0-9a-fA-F]{6}$/;
const EMAIL = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;

export type SettingsResult =
  | { ok: true; settings: SiteSettings }
  | { ok: false; code: string; message: string };

/** 读设置；没有就往回填默认值（站点名留空时由调用方兜底成 CRM 品牌名） */
export async function readSiteSettings(env: Env): Promise<SiteSettings> {
  const row = await env.DB.prepare(
    `SELECT site_name, tagline, hero_title, hero_sub, color, contact_email,
            footer_note, updated_at
       FROM site_settings WHERE id = ?`,
  )
    .bind(SETTINGS_ROW_ID)
    .first<{
      site_name: string;
      tagline: string;
      hero_title: string | null;
      hero_sub: string | null;
      color: string | null;
      contact_email: string | null;
      footer_note: string | null;
      updated_at: string;
    }>();

  return {
    siteName: row?.site_name ?? "",
    tagline: row?.tagline ?? "",
    heroTitle: row?.hero_title ?? null,
    heroSub: row?.hero_sub ?? null,
    color: row?.color ?? null,
    contactEmail: row?.contact_email ?? null,
    footerNote: row?.footer_note ?? null,
    updatedAt: row?.updated_at ?? null,
  };
}

/**
 * 写设置。**只做技术校验**：长度、颜色格式、邮箱格式。
 * 不判断"这个名字好不好" —— 那是租户的事（`site-studio-crm.md` §7 的闸门口径）。
 */
export async function saveSiteSettings(
  env: Env,
  input: Record<string, unknown>,
): Promise<SettingsResult> {
  const str = (v: unknown, max: number, label: string): string | null | string => {
    if (v === undefined || v === null) return null;
    if (typeof v !== "string") return `__err:${label} 必须是字符串`;
    const t = v.trim();
    if (t.length > max) return `__err:${label} 最多 ${max} 个字符`;
    return t;
  };

  const name = str(input.site_name, 40, "站点名称");
  if (typeof name === "string" && name.startsWith("__err:")) {
    return { ok: false, code: "bad_site_name", message: name.slice(6) };
  }
  const tagline = str(input.tagline, 120, "一句话介绍");
  if (typeof tagline === "string" && tagline.startsWith("__err:")) {
    return { ok: false, code: "bad_tagline", message: tagline.slice(6) };
  }

  // 首页大标题/副标题：**空串 = 用模板默认**，所以这里不区分"没传"和"传了空"
  const heroTitle = str(input.hero_title, 40, "首页大标题");
  if (typeof heroTitle === "string" && heroTitle.startsWith("__err:")) {
    return { ok: false, code: "bad_hero_title", message: heroTitle.slice(6) };
  }
  const heroSub = str(input.hero_sub, 120, "首页副标题");
  if (typeof heroSub === "string" && heroSub.startsWith("__err:")) {
    return { ok: false, code: "bad_hero_sub", message: heroSub.slice(6) };
  }

  let color: string | null = null;
  if (typeof input.color === "string" && input.color.trim()) {
    color = input.color.trim();
    if (!HEX.test(color)) {
      return { ok: false, code: "bad_color", message: "主色必须是 #rrggbb" };
    }
  }

  let email: string | null = null;
  if (typeof input.contact_email === "string" && input.contact_email.trim()) {
    email = input.contact_email.trim();
    if (!EMAIL.test(email)) {
      return { ok: false, code: "bad_email", message: "客服邮箱格式不对" };
    }
  }

  const footer = str(input.footer_note, 80, "页脚版权行");
  if (typeof footer === "string" && footer.startsWith("__err:")) {
    return { ok: false, code: "bad_footer", message: footer.slice(6) };
  }

  const now = new Date().toISOString();
  await env.DB.prepare(
    `INSERT INTO site_settings
       (id, site_name, tagline, hero_title, hero_sub, color, contact_email,
        footer_note, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET
       site_name = excluded.site_name, tagline = excluded.tagline,
       hero_title = excluded.hero_title, hero_sub = excluded.hero_sub,
       color = excluded.color,
       contact_email = excluded.contact_email, footer_note = excluded.footer_note,
       updated_at = excluded.updated_at`,
  )
    .bind(
      SETTINGS_ROW_ID,
      (name as string | null) ?? "",
      (tagline as string | null) ?? "",
      heroTitle === "" ? null : (heroTitle as string | null),
      heroSub === "" ? null : (heroSub as string | null),
      color,
      email,
      footer,
      now,
    )
    .run();

  return { ok: true, settings: await readSiteSettings(env) };
}

/**
 * 把设置变成模板占位符的替换表。
 *
 * `{{site.name}}` / `{{site.tagline}}` / `{{site.color}}` / `{{site.contact}}` /
 * `{{site.contact_link}}` / `{{site.footer}}` —— 只有这六个，多一个都要先改契约。
 * （`contact_link` 是整段 `<a>`：没配邮箱就渲染空串，避免留一个空的 `mailto:`。）
 */
export function tokensOf(
  settings: SiteSettings,
  fallbackName: string,
  now = new Date(),
): Record<string, string> {
  const name = settings.siteName || fallbackName;
  const footer =
    settings.footerNote || `© ${now.getFullYear()} ${name}`;
  return {
    "{{site.name}}": escapeHtml(name),
    "{{site.tagline}}": escapeHtml(settings.tagline),
    // 首页大标题：空 = 模板默认文案；副标题：空 = 空串（模板用 `:empty` 隐藏）
    "{{site.hero_title}}": escapeHtml(
      settings.heroTitle || DEFAULT_HERO_TITLE,
    ),
    "{{site.hero_sub}}": escapeHtml(settings.heroSub ?? ""),
    // 空值回落到模板默认色：留空会让 `--brand: ;` 变成非法 CSS，整份样式失效
    "{{site.color}}": settings.color ?? "#3b82f6",
    "{{site.contact}}": escapeHtml(settings.contactEmail ?? ""),
    // 有邮箱才渲染整段链接；没有就渲染空串（不留一个 `mailto:` 空链接）
    "{{site.contact_link}}": settings.contactEmail
      ? `<a href="mailto:${escapeHtml(settings.contactEmail)}">联系我们</a>`
      : "",
    "{{site.footer}}": escapeHtml(footer),
  };
}

/** 占位符替换只用于 HTML/CSS/JS 文本，必须转义：站点名里出现 `"` 会破坏属性 */
export function escapeHtml(v: string): string {
  return v
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/** 未替换的 `{{site.*}}` 说明模板用了一个没定义的槽 —— 发布前就该拦下 */
export function leftoverTokens(text: string): string[] {
  const found = text.match(/\{\{site\.[a-z_]+\}\}/g);
  return found ? [...new Set(found)] : [];
}
