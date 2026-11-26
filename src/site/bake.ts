/**
 * **烘焙**：把「一份源包 + 当前设置」渲染成产物，写进**内容寻址**的 `art/<sha>/`。
 *
 * 为什么它和发布是两件事（契约 `site-studio.md` §0.1 / D3）：
 *
 *   · **发布** = 租户在设计器里交付了一版设计：有签收、产生版本号（`site_releases` 一行）、
 *     所有租户都看得见"第 N 版"。
 *   · **烘焙** = 用**现在**的设置把**现在**这份设计渲染一遍。没有签收、不记账。
 *
 * 设置（站名、配色、首屏文案）是租户**关于自己的事实**，改它不该占一个设计版本号；
 * 但它确实要改变线上的字节 —— 所以保存设置之后自动重烘焙一次，指针只换 `artifact_sha`，
 * `template_seq` 不动。反过来，回滚设计时用**当前**设置重烘焙那个旧设计，
 * 于是"设计回退、身份不回退"。
 *
 * 内容寻址的三条纪律：
 *
 *   1. 目录键是**整版产物的 sha**（渲染后的全部文件 + 素材 + `_crm/*`），不是版本号
 *      —— 同内容只占一份，且永远不会"原地覆盖"。
 *   2. 指纹必须覆盖**全部文件**：只改 CSS（换主色）时页面结构一模一样，
 *      按页面算的指纹不会变，两份内容就会撞到同一个目录里，后一份把前一份覆盖掉。
 *   3. 写失败不留指针：指针由调用方在 bake 成功**之后**才切。
 */
import { SITE_LIMITS } from "./limits";
import { contentTypeOfPath, isTextPath, readSource, seedFiles, seedSha } from "./source";
import { RETURN_HTML, SDK_JS } from "./sdk";
import { renderTemplate } from "./render";
import { isInternalSetting } from "./settings";
import { buildScope, readSiteSettings, setValues } from "./settings";

import type { Env } from "../env";

/** `art/<sha-hex>/` —— 与 `workers/site/src/index.ts` 严格一致 */
export const artPrefix = (sha: string): string =>
  `art/${sha.replace(/^sha256:/, "")}/`;

/** 平台文件（`_crm/*`）：每次烘焙重新写，源包里不允许有（L0 直接拒） */
export function platformFiles(apiBase: string): Array<[string, string, string]> {
  return [
    [
      "_crm/config.js",
      `// 由 CRM 在烘焙时写入（不要手改；换域名请重新发布）\nwindow.CRM_API_BASE = ${JSON.stringify(apiBase)};\n`,
      "text/javascript; charset=utf-8",
    ],
    ["_crm/sdk.js", SDK_JS, "text/javascript; charset=utf-8"],
    ["_crm/return.html", RETURN_HTML, "text/html; charset=utf-8"],
  ];
}

interface Entry {
  path: string;
  sha256: string;
  bytes: number;
}

const enc = new TextEncoder();

async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** 同一个算法两处共用：按 path 排序后拼 `path\0sha256\0bytes`，再取一次 sha256 */
async function digestOf(entries: Entry[]): Promise<string> {
  const lines = entries
    .sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))
    .map((e) => `${e.path}\u0000${e.sha256}\u0000${e.bytes}`)
    .join("\n");
  return `sha256:${await sha256Hex(enc.encode(lines))}`;
}

export interface BakeInput {
  /** 站点调 CRM 的地址：写进 `/_crm/config.js`，跟着租户的站点域名走 */
  apiBase: string;
  /** 源包 sha（`tpl/<sha>/`）；等于种子 sha 时用代码里的种子 */
  sourceSha: string;
  /** 站名为空时的兜底（一般是 CRM 自己的品牌名） */
  brandFallback?: string;
}

export type BakeResult =
  | {
      ok: true;
      /** 整版产物的指纹，也是它在 `art/` 下的目录名 */
      artifactSha: string;
      files: number;
      bytes: number;
      /** 烘焙用的设置版本（界面上"设置 rev N"就是它） */
      settingsRev: number;
      /**
       * **S2**：设了值、但这份模板没用到（也看不出通过派生值用到）的路径。
       *
       * 判据只有一条：`site_settings.values` 里非空的路径，源包里既没有 `{{它}}`
       * 也没有 `data-repeat` / `data-if` 用它 —— 那就是"改了也不会变"。
       * 派生值算消费：`{{site.footer}}` 用到了站名与法务主体。
       */
      unusedSettings: string[];
    }
  | { ok: false; code: string; message: string; issues?: string[] };

const fail = (code: string, message: string, issues?: string[]): BakeResult => ({
  ok: false,
  code,
  message,
  ...(issues ? { issues } : {}),
});

/**
 * 烘焙一份源包。**只写 `art/`，不动指针、不记账** —— 谁调它谁负责切指针。
 */
export async function bakeSite(
  env: Env,
  tenantId: string,
  input: BakeInput,
): Promise<BakeResult> {
  const sites = env.SITES;
  if (!sites) {
    return fail("r2_not_configured", "没有绑定 SITES（R2）：站点产物无处可放。见 docs/self-host.md 的站点一节");
  }
  if (!tenantId) return fail("no_tenant", "拿不到租户 ID，不知道往哪个前缀写");

  const apiBase = (input.apiBase ?? "").trim().replace(/\/+$/, "");
  if (!/^https?:\/\/[^/]+$/.test(apiBase)) {
    return fail("api_base_missing", "不知道该告诉站点去哪个地址调 CRM（apiBase 缺失或格式不对）");
  }

  // ── 1) 源包：种子在代码里，租户源包在 R2（内容寻址）───────────────
  const seed = await seedSha();
  const sourceIsSeed = !input.sourceSha || input.sourceSha === seed;
  const sha = sourceIsSeed ? seed : input.sourceSha;
  const raw = sourceIsSeed
    ? seedFiles().map((f) => ({
        path: f.path,
        body:
          typeof f.body === "string"
            ? (new TextEncoder().encode(f.body).buffer as ArrayBuffer)
            : (f.body.buffer.slice(0) as ArrayBuffer),
      }))
    : await readSource(env, sha);
  if (raw.length === 0) {
    return fail("source_missing", `找不到源包 \`${sha}\`：内容存储被清过，或者 sha 写错了`);
  }

  // ── 2) L0：服务端最后一道（studio 可以被绕过）─────────────────────
  const issues = lintManifest(raw.map((f) => ({ key: f.path, size: f.body.byteLength })));
  if (issues.length > 0) return fail("l0_failed", "产物没有通过发布前检查", issues);

  // ── 3) 渲染：设置是**现在**的值（这就是"设置改了就重烘焙"的意义）────
  const settings = await readSiteSettings(env);
  const flat = setValues(settings.values);
  const scope = buildScope(settings, input.brandFallback ?? "我的站点");
  const rendered: Array<[string, string | ArrayBuffer, string]> = [];
  const entries: Entry[] = [];
  for (const file of raw) {
    if (!isTextPath(file.path)) {
      entries.push({
        path: file.path,
        sha256: await sha256Hex(new Uint8Array(file.body)),
        bytes: file.body.byteLength,
      });
      rendered.push([file.path, file.body, contentTypeOfPath(file.path)]);
      continue;
    }
    const text = new TextDecoder().decode(new Uint8Array(file.body));
    const r = renderTemplate(text, scope);
    if (r.missing.length > 0) {
      return fail("template_token_unknown", `模板里有未定义的占位符：${r.missing.join("、")}`, [
        "对照 GET /api/site/meta 的 capabilities 补齐数据，或从源包里删掉这段",
      ]);
    }
    /**
     * 集成开关：只对 HTML 插，**缺省不开**。
     *
     * 为什么缺省关：Zaraz 只在"租户域名自己也在 Cloudflare 上"时才有效（官方兼容表：
     * Zaraz 在 SaaS 提供方 zone 上是 No）。对不在 CF 的租户，这行 loader 只会 404，
     * 甚至可能把事件送进**我们自己的** GA 配置里。所以它必须是显式选择。
     *
     * 不满足条件的租户要统计/客服时，走对话让 AI 加外链脚本（规则在 studio 的 system prompt）。
     * 注意 `values` 是**嵌套**的，要先摊平再查。
     */
    const body = file.path.endsWith(".html")
      ? injectZaraz(r.html, flat["site.integrations.zaraz"] === "1")
      : r.html;
    const bytes = enc.encode(body);
    entries.push({ path: file.path, sha256: await sha256Hex(bytes), bytes: bytes.byteLength });
    // 类型必须按扩展名给：全写 text/plain 会让浏览器把整页 HTML 当源码显示。
    // 真实事故：第一次发布后线上 `index.html` 的 Content-Type 是 text/plain。
    rendered.push([file.path, body, contentTypeOfPath(file.path)]);
  }

  // 平台文件也算进产物（`/_crm/config.js` 里是租户的 CRM 地址，换域名 artifact 就得换）
  for (const [path, body, type] of platformFiles(apiBase)) {
    const bytes = enc.encode(body);
    entries.push({ path, sha256: await sha256Hex(bytes), bytes: bytes.byteLength });
    rendered.push([path, body, type]);
  }

  const artifactSha = await digestOf(entries);

  // ── 4) 写 `art/<sha>/`。同内容重复写是幂等的（字节完全一样）────────
  const target = artPrefix(artifactSha);
  let bytes = 0;
  for (const [path, body, type] of rendered) {
    const platform = path.startsWith("_crm/");
    await sites.put(`${target}${path}`, body, {
      httpMetadata: {
        contentType: type,
        ...(platform ? { cacheControl: "public, max-age=300" } : {}),
      },
      // 血缘：这堆字节是从哪份源包烘出来的（排障时不用翻数据库）
      customMetadata: platform ? { platform: "1" } : { source_sha: sha },
    });
    bytes += typeof body === "string" ? body.length : body.byteLength;
  }

  return {
    ok: true,
    artifactSha,
    files: rendered.length,
    bytes,
    settingsRev: settings.rev,
    unusedSettings: unusedOf(raw, settings.values),
  };
}

type BakeBody = string | Uint8Array | ArrayBuffer;

/**
 * Cloudflare Zaraz 的加载器。
 *
 * 为什么由我们插：Zaraz 的**自动注入只改写源站响应**，而我们的站点是 Worker
 * 返回的 HTML —— 实测（2026-11-19）自动注入完全不碰它；官方给这种情况的方案
 * 就是手动加载这一行。工具（GA4 / 客服）仍在租户的 CF 后台配，我们不碰。
 *
 * 插在渲染之后、写产物之前：源码保持干净，AI 编辑也删不掉它。
 */
const ZARAZ_TAG =
  '<script src="/cdn-cgi/zaraz/i.js" referrerpolicy="origin"></script>';

export function injectZaraz(html: string, on: boolean): string {
  if (!on || html.includes("/cdn-cgi/zaraz/i.js")) return html;
  const head = html.search(/<\/head\s*>/i);
  if (head >= 0) return html.slice(0, head) + ZARAZ_TAG + "\n" + html.slice(head);
  // 没有 </head>（畸形页面）：L0 会在发布前拦下缺少 doctype 的情况，这里只做兜底
  const open = html.search(/<head[^>]*>/i);
  if (open >= 0) {
    const end = html.indexOf(">", open);
    return html.slice(0, end + 1) + ZARAZ_TAG + html.slice(end + 1);
  }
  return ZARAZ_TAG + "\n" + html;
}

/** 源包里出现过的数据路径（`{{x}}`、`data-repeat`、`data-if`）。只看文本文件 */
function referencedPaths(files: { path: string; body: BakeBody }[]): Set<string> {
  const out = new Set<string>();
  const token = /\{\{\s*([a-zA-Z0-9_.]+)\s*\}\}/g;
  const attr = /\bdata-(?:repeat|if)\s*=\s*"([^"]*)"/g;
  for (const file of files) {
    if (!isTextPath(file.path)) continue;
    const text =
      typeof file.body === "string"
        ? file.body
        : new TextDecoder().decode(
            file.body instanceof ArrayBuffer ? new Uint8Array(file.body) : file.body,
          );
    for (const m of text.matchAll(token)) {
      if (m[1]?.startsWith("site.")) out.add(m[1]);
    }
    for (const m of text.matchAll(attr)) {
      const path = (m[1] ?? "").trim();
      if (path.startsWith("site.")) out.add(path);
    }
  }
  return out;
}

/**
 * S2：设了值但产物没用到。
 *
 * 只从**设了值的路径**出发（没填的字段当然不会出现在产物里，那不是问题）。
 * 派生值算消费：`{{site.footer}}` 内部用到 `site.name` / `site.legal_name`，
 * 模板不需要也不应该直接引用那两个 —— 否则页脚就会变成两个地方各写一段。
 */
export function unusedOf(
  files: { path: string; body: BakeBody }[],
  values: Record<string, unknown>,
): string[] {
  const refs = referencedPaths(files);
  const footer = refs.has("site.footer");
  return Object.keys(setValues(values)).filter((path) => {
    // 站点工程配置本来就不该出现在页面里，别把它报成"模板没用到"
    if (isInternalSetting(path)) return false;
    if (refs.has(path)) return false;
    if (footer && (path === "site.name" || path === "site.legal_name")) return false;
    return true;
  });
}

/** 允许的扩展名：平台产出的静态资源。**没有 `.php` / `.exe` / 无扩展名可执行** */
export const ALLOWED_EXT = new Set([
  "html",
  "css",
  "js",
  "mjs",
  "json",
  "txt",
  "xml",
  "svg",
  "png",
  "jpg",
  "jpeg",
  "webp",
  "gif",
  "ico",
  "woff2",
  "webmanifest",
]);

/** 扩展名（小写，不带点）；无扩展名返回空串 */
export function extOf(key: string): string {
  const base = key.slice(key.lastIndexOf("/") + 1);
  const dot = base.lastIndexOf(".");
  return dot < 0 ? "" : base.slice(dot + 1).toLowerCase();
}

/**
 * 发布前检查（产物口径）：路径、扩展名、体积、必须有 `index.html`。
 *
 * 与 studio 侧共用同一套判据；CRM 这份是服务端最后一道，不能因为前端已经检过就跳过
 * —— studio 可以被绕过，指针一翻就是线上。
 */
export function lintManifest(files: { key: string; size: number }[]): string[] {
  const issues: string[] = [];
  if (files.length === 0) issues.push("产物为空");
  if (files.length > SITE_LIMITS.files) {
    issues.push(`文件数 ${files.length} 超过上限 ${SITE_LIMITS.files}`);
  }

  let total = 0;
  for (const f of files) {
    total += f.size;
    if (f.key.includes("..") || f.key.startsWith("/")) {
      issues.push(`非法路径：${f.key}`);
    }
    if (f.size > SITE_LIMITS.fileBytes) {
      issues.push(
        `单文件超限：${f.key}（${Math.round(f.size / 1024)} KB > ${
          SITE_LIMITS.fileBytes / 1024
        } KB）`,
      );
    }
    const ext = extOf(f.key);
    if (!ALLOWED_EXT.has(ext)) issues.push(`不允许的文件类型：${f.key}`);
  }
  if (total > SITE_LIMITS.totalBytes) {
    issues.push(
      `总体积 ${(total / 1024 / 1024).toFixed(1)} MB 超过上限 ${
        SITE_LIMITS.totalBytes / 1024 / 1024
      } MB`,
    );
  }
  if (!files.some((f) => f.key === "index.html")) {
    issues.push("缺少 index.html（根路径无处可服务）");
  }
  return issues;
}
