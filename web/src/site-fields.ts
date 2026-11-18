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

/** 成套配色建议：`{id, label, preset, colors}`，**不落库** */
export interface SitePalette {
  id: string;
  label: string;
  /** 这套方案属于浅色还是深色底盘 */
  preset: string;
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

/** 按 `.` 写值（自动建中间层）；表单回填与"只提交动过的字段"都用它 */
export function setPath(target: Record<string, unknown>, name: readonly string[], value: unknown): void {
  let cur: Record<string, unknown> = target;
  for (const key of name.slice(0, -1)) {
    if (typeof cur[key] !== "object" || cur[key] === null) cur[key] = {};
    cur = cur[key] as Record<string, unknown>;
  }
  const last = name[name.length - 1]!;
  cur[last] = value;
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
 * 回填：存过的用存的，没存的用**当前生效值**（`scope`），再没有才用契约默认值。
 *
 * 为什么颜色要用 `scope`：`site.theme.color.background` 这类"留空 = 跟随主题"的字段，
 * 空的时候库里确实没有值，但页面上有一个**正在生效**的颜色（深色主题是深蓝底）。
 * 直接显示默认值会让租户以为自己的站是白底。注意：显示的生效值**不算存过** ——
 * 保存时只写动过的字段（否则选一次深色主题再保存，就会把白底钉死）。
 */
export function effectiveInitialValues(
  fields: readonly FormField[],
  values: Record<string, unknown>,
  scope: Record<string, unknown> | null | undefined,
): Record<string, unknown> {
  const out = initialValues(fields, values);
  for (const field of fields) {
    if (getPath(out, field.path) !== undefined) continue;
    const effective = getPath(scope, field.path);
    if (typeof effective === "string" && effective) setPath(out, field.name, effective);
  }
  return out;
}

/**
 * 选一套配色 ⇒ 交给 antd 的 `setFieldsValue` 补丁。
 *
 * **只写 `preset` + 主色 + 强调色**：中性三色（底色 / 卡片 / 正文）由 preset 决定，
 * 保持"跟随主题"，不写进库 —— 否则租户之后换深浅主题时，那三色不会跟着变。
 * 想逐个调色的人走"高级"。
 */
export function palettePatch(palette: SitePalette): Record<string, unknown> {
  const color: Record<string, string> = {};
  for (const token of ["primary", "accent"] as const) {
    const value = palette.colors[token];
    if (value) color[token] = value;
  }
  return {
    site: {
      theme: {
        ...(palette.preset ? { preset: palette.preset } : {}),
        color,
      },
    },
  };
}
