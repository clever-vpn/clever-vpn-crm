/**
 * 模板渲染引擎：**三个指令，多一个都没有**。
 *
 * 规范：`clever-vpn-docs/docs/standards/site-template.md` §1 / §8
 *
 *   `{{path}}`                              取值（文本与属性都能用）
 *   `data-repeat="<路径>"` + `data-as="<名>"` 把元素当模板重复 N 次
 *   `data-if="<路径>"`                       值为空 ⇒ 整个元素连缩进一起消失
 *
 * 三条纪律：
 *  1. **只切不改**：不做 HTML 重新序列化，切片拼回去，空白与属性顺序与源文件一致。
 *  2. **缺数据不出怪字**：取不到就输出空串并记进 `missing`，绝不把 `{{x}}` 留在产物里。
 *  3. **只删自己的指令**：只删 `data-repeat` / `data-as` / `data-if`，其余属性原样保留。
 *
 * 已知的两个坑（都写在规范 §8 里）：
 *  - 开标签要在**本条数据**的作用域里算：`href="…{{p.id}}"` 写在被重复的元素自身时，
 *    先算开标签再进循环会取到空串。这里靠"整段 inner 在子作用域里重渲染"天然解决。
 *  - 递归只吃自己那一段，不传偏移区间。
 */

/** 模板作用域：`{ site: {...}, plans: [...] }`，与 `data.schema.json` 的路径一致 */
export type Scope = Record<string, unknown>;

export interface RenderResult {
  html: string;
  /** 取值失败的路径（去重后）：发布时据此拒绝，避免线上露出 `{{x}}` */
  missing: string[];
}

const VOID = new Set([
  "area", "base", "br", "col", "embed", "hr", "img", "input",
  "link", "meta", "param", "source", "track", "wbr",
]);

const TAG_RE = /<(\/?)([a-zA-Z][\w:-]*)((?:"[^"]*"|'[^']*'|[^>"'])*)>/g;
const TOKEN_RE = /\{\{\s*([a-zA-Z0-9_]+(?:[.][a-zA-Z0-9_]+)*)\s*\}\}/g;

const at = (scope: Scope, path: string): unknown => {
  let cur: unknown = scope;
  for (const seg of path.split(".")) {
    if (cur === null || typeof cur !== "object") return undefined;
    cur = (cur as Record<string, unknown>)[seg];
  }
  return cur;
};

/** `null` / `undefined` / 空串 / 空数组 都算空；`0` 与 `false` **不算空** */
const isEmpty = (v: unknown): boolean =>
  v === undefined ||
  v === null ||
  v === "" ||
  (Array.isArray(v) && v.length === 0);

const escapeHtml = (v: string): string =>
  v
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");

const asText = (v: unknown): string => {
  if (typeof v === "string") return v;
  if (typeof v === "number" || typeof v === "boolean") return String(v);
  return "";
};

/** 属性里取到的原始值（未转义）；解析指令用 */
function attrOf(attrs: string, name: string): string | undefined {
  const m = new RegExp(`\\s${name}\\s*=\\s*"([^"]*)"`, "i").exec(attrs);
  if (m) return m[1];
  const m2 = new RegExp(`\\s${name}\\s*=\\s*'([^']*)'`, "i").exec(attrs);
  return m2 ? m2[1] : undefined;
}

/** 删掉指定属性（连同它前面的空白），保持其余字节不变 */
function stripAttrs(attrs: string, names: string[]): string {
  let out = attrs;
  for (const n of names) {
    out = out.replace(new RegExp(`\\s${n}\\s*=\\s*("[^"]*"|'[^']*')`, "gi"), "");
    out = out.replace(new RegExp(`\\s${n}\\b(?!\\s*=)`, "gi"), "");
  }
  return out;
}

/** 从 `start`（该元素的开标签起点）开始，找到它的结束位置（含闭合标签） */
function elementEnd(html: string, start: number): number | null {
  TAG_RE.lastIndex = start;
  const head = TAG_RE.exec(html);
  if (!head || head.index !== start) return null;
  const name = (head[2] ?? "").toLowerCase();
  const selfClosed = /\/\s*$/.test(head[3] ?? "") || VOID.has(name);
  if (selfClosed) return head.index + head[0].length;

  let depth = 0;
  TAG_RE.lastIndex = start;
  let m: RegExpExecArray | null;
  while ((m = TAG_RE.exec(html))) {
    if ((m[2] ?? "").toLowerCase() !== name) continue;
    if (m[1] === "/") {
      depth -= 1;
      if (depth === 0) return m.index + m[0].length;
    } else if (!/\/\s*$/.test(m[3] ?? "")) {
      depth += 1;
    }
  }
  return null;
}

interface Directive {
  start: number;
  end: number;
  name: string;
  attrs: string;
}

/** 找下一个带 `data-if` / `data-repeat` 的开标签 */
function nextDirective(html: string, from: number): Directive | null {
  TAG_RE.lastIndex = from;
  let m: RegExpExecArray | null;
  while ((m = TAG_RE.exec(html))) {
    if (m[1] === "/") continue;
    const attrs = m[3] ?? "";
    if (
      attrOf(attrs, "data-if") === undefined &&
      attrOf(attrs, "data-repeat") === undefined
    ) {
      continue;
    }
    return { start: m.index, end: m.index + m[0].length, name: m[2] ?? "", attrs };
  }
  return null;
}

const tokenValue = (scope: Scope, path: string, missing: string[]): string => {
  const v = at(scope, path);
  if (v === undefined) {
    missing.push(path);
    return "";
  }
  return escapeHtml(asText(v));
};

/** 在给定作用域里替换所有 `{{path}}` */
function subst(text: string, scope: Scope, missing: string[]): string {
  return text.replace(TOKEN_RE, (_all, path: string) => tokenValue(scope, path, missing));
}

/**
 * 删掉元素片段前面那一行的缩进（`data-if` 判定为空时用）。
 *
 * 要连**换行**一起吃掉：只删空格会留下一个空行，视觉上板块之间凭空多一道缝。
 */
const dropIndent = (out: string): string =>
  /\n[ \t]*$/.test(out) ? out.replace(/\n[ \t]*$/, "") : out.replace(/[ \t]+$/, "");

function renderInto(html: string, scope: Scope, missing: string[]): string {
  let out = "";
  let i = 0;
  for (;;) {
    const d = nextDirective(html, i);
    if (!d) {
      out += subst(html.slice(i), scope, missing);
      return out;
    }
    out += subst(html.slice(i, d.start), scope, missing);

    const end = elementEnd(html, d.start);
    if (end === null) {
      // 畸形片段：原样保留，交给 L0 报错，绝不猜
      out += subst(html.slice(d.start), scope, missing);
      return out;
    }
    const inner = html.slice(d.start, end);

    const cond = attrOf(d.attrs, "data-if");
    if (cond !== undefined) {
      const v = at(scope, cond);
      if (v === undefined) missing.push(cond);
      if (isEmpty(v)) {
        out = dropIndent(out);
      } else {
        const open = `<${d.name}${stripAttrs(d.attrs, ["data-if"])}>`;
        const rest = inner.slice(d.end - d.start);
        out += renderInto(open + rest, scope, missing);
      }
      i = end;
      continue;
    }

    // data-repeat：整段 inner 在**条目作用域**里重渲染（开标签随之重算）
    const listPath = attrOf(d.attrs, "data-repeat") ?? "";
    const as = attrOf(d.attrs, "data-as") || "item";
    const list = at(scope, listPath);
    if (list === undefined) missing.push(listPath);
    if (Array.isArray(list)) {
      const open = `<${d.name}${stripAttrs(d.attrs, ["data-repeat", "data-as"])}>`;
      const rest = inner.slice(d.end - d.start);
      for (const item of list) {
        const child: Scope =
          item !== null && typeof item === "object"
            ? { ...scope, [as]: item }
            : { ...scope, [as]: { value: item } };
        out += renderInto(open + rest, child, missing);
      }
    }
    i = end;
  }
}

/**
 * 渲染一整个文本产物。
 *
 * `missing` 非空 ⇒ 调用方应当**拒绝发布**：说明模板用了没有数据的路径。
 */
export function renderTemplate(src: string, scope: Scope): RenderResult {
  const missing: string[] = [];
  const html = renderInto(src, scope, missing);
  // 兜底：指令之外还残留花括号（畸形写法），也算未定义路径
  for (const m of html.matchAll(TOKEN_RE)) missing.push(m[1] ?? "");
  return { html, missing: [...new Set(missing)] };
}
