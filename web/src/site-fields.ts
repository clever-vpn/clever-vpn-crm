/**
 * 站点设置表单 = **由 CRM 的 `capabilities` 生成**（契约 `site-studio-crm.md` §4.4）。
 *
 * 为什么不能手写这张表单：字段清单只有一份，住 `src/site/meta.ts`。后台再手写一遍，
 * 加一个字段就要改两处，而漏改的那处**不会报错** —— 表单照旧渲染，只是少了那一项，
 * 租户看到的是"这项没法改"，谁也不知道是漏了。
 *
 * 纯函数、不碰 React：这样它能在 node 环境的单测里直接跑（`test/site-form.test.ts`），
 * 把"清单 → 控件"这一步钉住。渲染循环在 `pages/Site.tsx` 里，只做搬砖。
 */

/** `/api/site/meta` 里的一条能力（只声明这里用得到的字段） */
export interface SiteCapability {
  path: string;
  kind: string;
  max?: number;
  values?: readonly string[];
  /** 与 `values` 一一对应的人话（`light` → 浅色） */
  value_labels?: readonly string[];
  label?: string;
  /** 表单里那句说明 */
  hint?: string;
  default?: string;
  /** 渲染时算的值：可引用，**不可填** */
  derived?: boolean;
  /** 集合才有：条目上限（表单不渲染集合，这里只用来说明形状） */
  items?: { max?: number };
}

/** 成套配色建议：`{id, label, colors:{primary,…}}`，**不落库** */
export interface SitePalette {
  id: string;
  label: string;
  colors: Record<string, string>;
}

/** 颜色令牌：与后端 `THEME_COLORS` / `DEFAULT_COLORS` 同名同序 */
export const COLOR_TOKENS = ["primary", "accent", "background", "surface", "text"] as const;

export type FieldControl = "text" | "email" | "url" | "color" | "select";

export interface FormField {
  /** 设置路径（`site.theme.color.primary`）—— 也是错误信息里的名字 */
  path: string;
  /** antd `Form.Item` 的 name：按 `.` 拆开，值就是 `site_settings.values` 的形状 */
  name: string[];
  label: string;
  hint?: string;
  control: FieldControl;
  max?: number;
  options?: { value: string; label: string }[];
  defaultValue?: string;
}

/**
 * 清单 → 表单字段。
 *
 * 跳过三类：派生值（改了不生效）、集合（不是单值，下载入口单独一块表单）、
 * `asset`（上传是文件，不是输入框）。**不认识的 kind 也跳过** —— 宁可少一项，
 * 也不猜一个可能写坏数据的控件；新 kind 出现时在这里补一个 case。
 */
export function formFields(caps: readonly SiteCapability[]): FormField[] {
  const out: FormField[] = [];
  for (const cap of caps) {
    if (cap.derived) continue;
    let control: FieldControl;
    switch (cap.kind) {
      case "text":
        control = "text";
        break;
      case "email":
        control = "email";
        break;
      case "url":
        control = "url";
        break;
      case "color":
        control = "color";
        break;
      case "enum":
        control = "select";
        break;
      default:
        // collection / asset / 未知 kind
        continue;
    }
    const options =
      control === "select"
        ? (cap.values ?? []).map((value, i) => ({
            value,
            label: cap.value_labels?.[i] ?? value,
          }))
        : undefined;
    out.push({
      path: cap.path,
      name: cap.path.split("."),
      label: cap.label ?? cap.path,
      ...(cap.hint ? { hint: cap.hint } : {}),
      control,
      ...(cap.max !== undefined ? { max: cap.max } : {}),
      ...(options ? { options } : {}),
      ...(cap.default !== undefined ? { defaultValue: cap.default } : {}),
    });
  }
  return out;
}

/** 按 `.` 取一层层取出来的值（对象缺失就是空） */
export function getPath(source: unknown, path: string): unknown {
  let cur: unknown = source;
  for (const key of path.split(".")) {
    if (typeof cur !== "object" || cur === null) return undefined;
    cur = (cur as Record<string, unknown>)[key];
  }
  return cur;
}

/**
 * 表单初始值：**只从清单里的字段取**。
 *
 * 这条白名单是刻意的：库里可能还留着已经删掉的路径（`site.theme.brand` 就在
 * `contract: 8` 删了），原样回填会被后端判 `unknown_field` —— 租户看到的是
 * "保存失败"，却不知道哪一项。取不到的字段再用契约声明的 `default`。
 */
export function initialValues(
  fields: readonly FormField[],
  values: Record<string, unknown>,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const field of fields) {
    const raw = getPath(values, field.path);
    const text = typeof raw === "string" ? raw : "";
    const value = text || field.defaultValue;
    if (value === undefined) continue;
    let cur: Record<string, unknown> = out;
    const last = field.name.length - 1;
    for (let i = 0; i < last; i += 1) {
      const key = field.name[i]!;
      if (typeof cur[key] !== "object" || cur[key] === null) cur[key] = {};
      cur = cur[key] as Record<string, unknown>;
    }
    cur[field.name[last]!] = value;
  }
  return out;
}

/**
 * 选一套配色 ⇒ 交给 antd 的 `setFieldsValue` 补丁。
 *
 * 只写五个颜色令牌：`preset`（深浅底盘）是另一件事，不该被配色方案悄悄改掉。
 */
export function palettePatch(palette: SitePalette): Record<string, unknown> {
  const color: Record<string, string> = {};
  for (const token of COLOR_TOKENS) {
    const value = palette.colors[token];
    if (value) color[token] = value;
  }
  return { site: { theme: { color } } };
}
