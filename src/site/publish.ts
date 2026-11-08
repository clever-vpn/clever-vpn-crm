/**
 * 站点发布：**模板实例化 → 写 R2 → 最后一步切 KV 指针**。
 *
 * 契约：`contracts/site-studio-crm.md` §6.1 / §6.3、`contracts/cf-api-hosting.md` §3、
 * `contracts/site-crm.md` §0.1。
 *
 * 三条纪律：
 *  1. **渲染发生在发布时，不在请求时**：`site-serve` 只做「读指针 → 取文件」，
 *     不给它任何模板逻辑，也就不会两个地方各渲染一遍。
 *  2. **顺序不可交换**：`public/` 全量写完、D1 记完账，**最后**才切指针。
 *     任何一步失败，线上仍是上一版（用户看不到半成品）。
 *  3. **版本不可变**：每次发布是一个新 `n`，回滚 = 把指针指回旧 `n`，
 *     不重建、不经过 studio、不计费。
 *
 * 与 cf-api 的分工：域名/证书/KV 写穿归 cf-api；**站点产物与 active 指针归这里**
 * （指针是 CRM 自己的东西，site-serve 只读它）。
 */
import { renderTemplate } from "./render";
import { RETURN_HTML, SDK_JS } from "./sdk";
import { buildScope, readSiteSettings } from "./settings";

import type { Env } from "../env";

/** 与 `clever-vpn-app/scripts/check-web.mjs` 的 `LIMITS` 同源；改这里就是改契约 */
export const SITE_LIMITS = {
  /** 单个产物文件 */
  fileBytes: 1 << 20,
  /** 一版产物总大小 */
  totalBytes: 8 << 20,
  /** 一版最多几个文件 */
  files: 200,
} as const;

/** 允许的扩展名：平台产出的静态资源。**没有 `.php` / `.exe` / 无扩展名可执行** */
const ALLOWED_EXT = new Set([
  "html",
  "css",
  "js",
  "json",
  "txt",
  "xml",
  "svg",
  "png",
  "jpg",
  "jpeg",
  "webp",
  "ico",
  "woff2",
  "map",
]);

export interface PublishInput {
  /** 模板名，默认 `basic`（仓库里的 `site-template/`） */
  template?: string;
  /** 模板版本，默认 `v1` */
  templateVersion?: string;
  /** 触发者（写进 D1，便于"这版是谁发的"） */
  actor?: string;
  /**
   * 站点名为空时的兜底名（一般是 CRM 自己的品牌名）。
   * 只在模板里写了 `{{site.name}}` 而租户还没设名字时用得上。
   */
  brandFallback?: string;
  /**
   * 站点调 CRM 的基址（= CRM 自己的 origin，如 `https://acme.clever-panel.win`）。
   *
   * **必须由发布方给**：模板里的 `config.js` 只有占位值，站点与 CRM 不同域，
   * 发上去之后没人能改它。渲染发生在发布时，就必须在这一步把它定死。
   */
  apiBase?: string;
}

export interface PublishOk {
  ok: true;
  version: number;
  files: number;
  bytes: number;
  template: string;
  templateVersion: string;
}

export interface PublishErr {
  ok: false;
  code: string;
  message: string;
  /** L0 闸门的具体问题；前端可直接展示 */
  issues?: string[];
}

export type PublishResult = PublishOk | PublishErr;

const err = (code: string, message: string, issues?: string[]): PublishErr => ({
  ok: false,
  code,
  message,
  ...(issues ? { issues } : {}),
});

/** `sites/{tenant}/versions/{n}/public/` —— 与 `workers/site/src/index.ts` 严格一致 */
export const publicPrefix = (tenantId: string, version: number): string =>
  `sites/${tenantId}/versions/${version}/public/`;

const templatePrefix = (template: string, version: string): string =>
  `g/templates/${template}/${version}/`;

/** 指针 key：`site-serve` 读的就是它，读的是 `{ n }` */
export const activeKey = (tenantId: string): string => `site:${tenantId}:active`;

/** 需要做占位符替换的类型；其余（png/woff2/ico…）原样透传 */
const isText = (key: string): boolean =>
  /[.](html|css|js|json|txt|xml|svg)$/i.test(key);

const extOf = (key: string): string => {
  const base = key.slice(key.lastIndexOf("/") + 1);
  const dot = base.lastIndexOf(".");
  return dot < 0 ? "" : base.slice(dot + 1).toLowerCase();
};

/**
 * L0 闸门（**只判技术有效性**，不判"设计好不好"）。
 *
 * 与 studio 侧共用同一套判据；CRM 这份是服务端最后一道，不能因为前端已经检过就跳过
 * —— studio 可以被绕过，指针一翻就是线上。
 */
export function lintManifest(
  files: { key: string; size: number }[],
): string[] {
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

/**
 * 发布一版。**幂等性靠"每次都是新版本"**：连点两次会发两版（内容一样），
 * 这是刻意的——流水线里"重试"和"再发一版"本来就分不清，宁可多一版也不要
 * 半成品覆盖旧版。回收由 §9.3 的保留策略做。
 */
export async function publishSite(
  env: Env,
  tenantId: string,
  input: PublishInput = {},
): Promise<PublishResult> {
  const sites = env.SITES;
  if (!sites) {
    return err(
      "r2_not_configured",
      "没有绑定 SITES（R2）：站点产物无处可放。见 docs/self-host.md 的站点一节",
    );
  }
  if (!env.HOSTS) {
    return err(
      "kv_not_configured",
      "没有绑定 HOSTS（KV）：发布完切不了指针，站点点不开",
    );
  }
  if (!tenantId) return err("no_tenant", "拿不到租户 ID，不知道往哪个前缀写");

  const apiBase = (input.apiBase ?? "").trim().replace(/\/+$/, "");
  if (!/^https?:\/\/[^/]+$/.test(apiBase)) {
    return err(
      "api_base_missing",
      "不知道该告诉站点去哪个地址调 CRM（apiBase 缺失或格式不对）",
    );
  }

  const template = input.template ?? "basic";
  const templateVersion = input.templateVersion ?? "v1";
  const prefix = templatePrefix(template, templateVersion);

  const listed = await sites.list({ prefix, limit: SITE_LIMITS.files + 1 });
  const objects = listed.objects.filter((o) => !o.key.endsWith("/"));
  if (objects.length === 0) {
    return err(
      "template_missing",
      `R2 里没有模板 \`${prefix}\`：先把 site-template 上传上去（npm run site:template:upload）`,
    );
  }

  const entries = objects.map((o) => ({
    key: o.key.slice(prefix.length),
    size: o.size,
  }));
  const issues = lintManifest(entries);
  if (issues.length > 0) {
    return err("l0_failed", "产物没有通过发布前检查", issues);
  }

  // 品牌设置：**发布时烘焙**（site-crm.md §0.1）。读不到就用空值，绝不因此失败 ——
  // 站点名留空时回落到模板里写死的名字（替换表里给空串，占位符会被清掉）。
  const settings = await readSiteSettings(env);
  const scope = buildScope(settings.values, input.brandFallback ?? "我的站点");

  // 版本号：以 D1 为准（KV 只是指针，不能当计数器用）
  const maxRow = await env.DB.prepare(
    `SELECT COALESCE(MAX(seq), 0) AS n FROM site_versions`,
  ).first<{ n: number }>();
  const version = Number(maxRow?.n ?? 0) + 1;

  // 1) 先写产物（失败就什么都没有，线上仍是上一版）
  const target = publicPrefix(tenantId, version);
  let bytes = 0;
  // 产物文件数 = 模板文件 + 平台文件（记账与返回都用它）
  const files = objects.length + 2;
  for (const o of objects) {
    const rel = o.key.slice(prefix.length);
    const obj = await sites.get(o.key);
    if (!obj) return err("read_failed", `读不到模板对象：${o.key}`);

    // `config.js` 是模板里**唯一需要外部输入**的文件：发布时把 CRM 地址写死。
    // 站点与 CRM 不同域，发上去了就没人能改，所以这步必须在发布时做。
    let body: ReadableStream | string =
      rel === "config.js"
        ? `// 由 CRM 在发布时写入（不要手改；改 CRM 地址请重新发布）\nwindow.CRM_API_BASE = ${JSON.stringify(apiBase)};\n`
        : obj.body;

    // 文本类产物做 `{{site.*}}` 替换（**发布时烘焙**，见 site-crm.md §0.1）。
    // 二进制（png / woff2）原样透传，不做解码。
    if (isText(rel)) {
      const text =
        typeof body === "string" ? body : await new Response(body).text();
      // 三个指令 + 取值（standards/site-template.md §1）：
      // 先 data-if 后 data-repeat，开标签在条目作用域里重算，只删引擎自己的属性。
      const r = renderTemplate(text, scope);
      // 模板用了没有数据的路径 ⇒ 发布前就拦（否则线上会露出 `{{site.xxx}}`）
      if (r.missing.length > 0) {
        return err(
          "template_token_unknown",
          `模板里有未定义的占位符：${r.missing.join("、")}`,
          ["对照模板包的 data.schema.json 补齐字段，或从模板里删掉这段"],
        );
      }
      body = r.html;
    }

    await sites.put(`${target}${rel}`, body, {
      httpMetadata: obj.httpMetadata,
      customMetadata: { template: `${template}@${templateVersion}` },
    });
    bytes += o.size;
  }

  // 1b) **平台文件**：SDK 与支付回跳页，每次发布都写进产物。
  //
  //  为什么不放站点 Worker 里：站点出口有两份实现（自部署 `workers/site`、
  //  托管 `site-serve`）。同一段 SDK 抄两遍必然漂移，而它恰恰是"凭证只有一处"
  //  的那一处。写进产物后两边都只是读 R2，谁也不用知道 SDK 长什么样。
  //  代价：改 SDK 要重新发布才生效（一次点击，可接受）。
  //
  //  `/_crm/` 是平台保留前缀（L0 硬项 H4 禁止模板占用），所以这里先 lint 再注入。
  const platform: Array<[string, string, string]> = [
    ["_crm/sdk.js", SDK_JS, "text/javascript; charset=utf-8"],
    ["_crm/return.html", RETURN_HTML, "text/html; charset=utf-8"],
  ];
  for (const [rel, body, type] of platform) {
    await sites.put(`${target}${rel}`, body, {
      httpMetadata: { contentType: type, cacheControl: "public, max-age=300" },
      customMetadata: { platform: "1" },
    });
    bytes += body.length;
  }

  // 2) 记账。seq 唯一索引会挡住并发发布撞号
  try {
    await env.DB.prepare(
      `INSERT INTO site_versions (seq, template, template_version, files, bytes, created_by, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    )
      .bind(
        version,
        template,
        templateVersion,
        files,
        bytes,
        input.actor ?? null,
        new Date().toISOString(),
      )
      .run();
  } catch {
    return err("version_conflict", "有人同时在发布，请重试");
  }

  // 3) **最后一步**：切指针。site-serve 的指针缓存 5 s，最多 5 秒生效
  await env.HOSTS.put(activeKey(tenantId), JSON.stringify({ n: version }));

  return {
    ok: true,
    version,
    files,
    bytes,
    template,
    templateVersion,
  };
}

export interface SiteState {
  /** 当前线上版本；从未发布过是 null */
  active: number | null;
  /** 最近若干版，最新在前 */
  versions: {
    seq: number;
    template: string;
    template_version: string;
    files: number;
    bytes: number;
    created_at: string;
  }[];
  /** 模板是否已在 R2（没上传过时发布必然失败，提前告诉后台） */
  templateReady: boolean;
}

export async function siteState(env: Env, tenantId: string): Promise<SiteState> {
  const pointer = env.HOSTS
    ? ((await env.HOSTS.get(activeKey(tenantId), "json")) as { n?: number } | null)
    : null;

  const rows = await env.DB.prepare(
    `SELECT seq, template, template_version, files, bytes, created_at
       FROM site_versions ORDER BY seq DESC LIMIT 20`,
  ).all<{
    seq: number;
    template: string;
    template_version: string;
    files: number;
    bytes: number;
    created_at: string;
  }>();

  let templateReady = false;
  if (env.SITES) {
    const probe = await env.SITES.list({
      prefix: templatePrefix("basic", "v1"),
      limit: 1,
    });
    templateReady = probe.objects.length > 0;
  }

  return {
    active: pointer?.n ?? null,
    versions: rows.results ?? [],
    templateReady,
  };
}
