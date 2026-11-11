/**
 * **发布**：站点源包 → 渲染 → 写 R2 → 记账 → **最后一步**切 KV 指针。
 *
 * 契约 `site-studio-crm.md` §0.1（Contract 14）：这是**唯一一次跨服务写**。studio
 * 只交源文件，渲染、记账、切指针全在这里 —— 设置是发布时烘焙的，studio 自己渲染会
 * 让"只改设置"发不出去。
 *
 * 四条纪律：
 *  1. **渲染发生在发布时，不在请求时**：`site-serve` 只做「读指针 → 取文件」。
 *  2. **顺序不可交换**：产物全量写完、发布记录插好，**最后**才切指针。任何一步失败，
 *     线上仍是上一版。
 *  3. **版本不可变**：每次发布是一个新的 `seq`；回滚 = 把指针指回旧 `seq`，
 *     不重建、不经过 studio、不计费。
 *  4. **幂等键 = 源包 sha + 设置 rev**：同内容重复提交返回**已有** `seq`。
 *     版本号是租户唯一看到的数字，双击/重试不许让它跳号。
 *
 * 与 cf-api 的分工：域名/证书/KV 写穿归 cf-api；**站点产物与 active 指针归这里**。
 */
import { renderTemplate } from "./render";
import { FILES_PREFIX, isTextPath, readSource, seedFiles, seedSha, sourceSha, tplPrefix } from "./source";
import { artifactShaOf } from "./deliver";
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
export const ALLOWED_EXT = new Set([
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
  /**
   * 发哪一份源包。
   *
   * 不传 = 用**最近一次发布的那一份**（后台只改设置、不改源文件时的路径）；
   * 从来没有过发布 = 用当前部署的种子。
   */
  sourceSha?: string;
  /** 触发者（写进发布记录，便于"这版是谁发的"） */
  actor?: string | null;
  /** 谁发起的：`studio` / `crm`（只作审计） */
  trigger?: "studio" | "crm";
  /**
   * 幂等键：`<source_sha>:<settings.rev>`。
   *
   * 同一个键重复发布 ⇒ 返回已有 `seq`（`idempotent: true`），不新增版本。
   * 空 = 不判幂等（后台"再发一版"这种显式动作）。
   */
  idemKey?: string;
  /** 站点名为空时的兜底名（一般是 CRM 自己的品牌名） */
  brandFallback?: string;
  /**
   * 站点调 CRM 的基址（= CRM 自己的 origin）。
   *
   * **必须由发布方给**：`config.js` 在发布时写死它，站点与 CRM 不同域，发上去之后
   * 没人能改。
   */
  apiBase?: string;
}

export interface PublishOk {
  ok: true;
  /** 对外唯一版本号 `v<version>` */
  version: number;
  files: number;
  bytes: number;
  /** 这次发布的源包 */
  sourceSha: string;
  /** 渲染后的产物指纹 */
  artifactSha: string;
  /** 血缘戳：建站时那个种子 */
  seedSha: string;
  /** 同内容重复发布 ⇒ true（返回的是已有版本） */
  idempotent: boolean;
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

/** 最近一次发布（没有就是 null） */
export async function latestRelease(
  env: Env,
  tenantId: string,
): Promise<{ seq: number; sourceSha: string; artifactSha: string; seedSha: string } | null> {
  const row = await env.DB.prepare(
    `SELECT seq, source_sha, artifact_sha, seed_sha FROM site_releases
      WHERE tenant_id = ? ORDER BY seq DESC LIMIT 1`,
  )
    .bind(tenantId)
    .first<{ seq: number; source_sha: string; artifact_sha: string; seed_sha: string }>();
  return row
    ? { seq: Number(row.seq), sourceSha: row.source_sha, artifactSha: row.artifact_sha, seedSha: row.seed_sha }
    : null;
}

/**
 * 发布一版。
 *
 * 顺序（契约 §0.1.5）：存源包（调用方先 `storeSource`）→ 渲染 → 算 artifact_sha →
 * 写产物 → 插发布记录 → **最后**切指针。任何一步失败，线上仍是上一版，发布记录也不会
 * 多一行。
 */
export async function publishSite(
  env: Env,
  tenantId: string,
  input: PublishInput = {},
): Promise<PublishResult> {
  const sites = env.SITES;
  if (!sites) {
    return err("r2_not_configured", "没有绑定 SITES（R2）：站点产物无处可放。见 docs/self-host.md 的站点一节");
  }
  if (!env.HOSTS) {
    return err("kv_not_configured", "没有绑定 HOSTS（KV）：发布完切不了指针，站点点不开");
  }
  if (!tenantId) return err("no_tenant", "拿不到租户 ID，不知道往哪个前缀写");

  const apiBase = (input.apiBase ?? "").trim().replace(/\/+$/, "");
  if (!/^https?:\/\/[^/]+$/.test(apiBase)) {
    return err("api_base_missing", "不知道该告诉站点去哪个地址调 CRM（apiBase 缺失或格式不对）");
  }

  // ── 1) 这次发哪份源包：显式给的 > 上次发的 > 种子 ────────────────────
  const seed = await seedSha();
  const latest = await latestRelease(env, tenantId);
  const wanted = (input.sourceSha ?? "").trim();
  const sourceIsSeed = wanted ? wanted === seed : !latest;
  const sha = wanted || latest?.sourceSha || seed;

  // ── 2) 幂等：同键直接返回已有版本（不新增、不重写字节）────────────────
  const idemKey = (input.idemKey ?? "").trim();
  if (idemKey) {
    const hit = await env.DB.prepare(
      `SELECT seq, source_sha, artifact_sha, seed_sha, files, bytes FROM site_releases
        WHERE tenant_id = ? AND idem_key = ? LIMIT 1`,
    )
      .bind(tenantId, idemKey)
      .first<Record<string, unknown>>();
    if (hit) {
      return {
        ok: true,
        version: Number(hit.seq),
        files: Number(hit.files),
        bytes: Number(hit.bytes),
        sourceSha: String(hit.source_sha),
        artifactSha: String(hit.artifact_sha),
        seedSha: String(hit.seed_sha),
        idempotent: true,
      };
    }
  }

  // ── 3) 取源文件：种子在代码里，租户源包在 R2 ────────────────────────
  const raw =
    sourceIsSeed
      ? seedFiles().map((f) => ({
          path: f.path,
          body:
            typeof f.body === "string"
              ? (new TextEncoder().encode(f.body).buffer as ArrayBuffer)
              : (f.body.buffer.slice(0) as ArrayBuffer),
        }))
      : await readSource(env, sha);
  if (raw.length === 0) {
    return err("source_missing", `找不到源包 \`${sha}\`：内容存储被清过，或者 sha 写错了`);
  }
  const entries = raw.map((f) => ({ key: f.path, size: f.body.byteLength }));
  const issues = lintManifest(entries);
  if (issues.length > 0) return err("l0_failed", "产物没有通过发布前检查", issues);

  // 品牌设置：**发布时烘焙**（site-crm.md §0.1）。读不到就用空值，绝不因此失败。
  const settings = await readSiteSettings(env);
  const scope = buildScope(settings, input.brandFallback ?? "我的站点");

  // ── 4) 渲染 + 产物指纹（先算再写：指纹不过就别写半个站）────────────────
  const rendered = new Map<string, string | ArrayBuffer>();
  const texts: { path: string; text: string }[] = [];
  for (const file of raw) {
    // `config.js` 是源包里**唯一需要外部输入**的文件：发布时把 CRM 地址写死。
    if (file.path === "config.js") {
      const body = `// 由 CRM 在发布时写入（不要手改；改 CRM 地址请重新发布）\nwindow.CRM_API_BASE = ${JSON.stringify(apiBase)};\n`;
      rendered.set(file.path, body);
      texts.push({ path: file.path, text: body });
      continue;
    }
    if (!isTextPath(file.path)) {
      rendered.set(file.path, file.body);
      continue;
    }
    const text = new TextDecoder().decode(new Uint8Array(file.body));
    const r = renderTemplate(text, scope);
    if (r.missing.length > 0) {
      return err("template_token_unknown", `模板里有未定义的占位符：${r.missing.join("、")}`, [
        "对照 GET /api/site/meta 的 capabilities 补齐数据，或从源包里删掉这段",
      ]);
    }
    rendered.set(file.path, r.html);
    texts.push({ path: file.path, text: r.html });
  }
  const artifact = await artifactShaOf(texts, scope);

  // ── 5) 版本号：以 D1 为准（KV 只是指针，不能当计数器用）──────────────
  const maxRow = await env.DB.prepare(
    `SELECT COALESCE(MAX(seq), 0) AS n FROM site_releases WHERE tenant_id = ?`,
  )
    .bind(tenantId)
    .first<{ n: number }>();
  const version = Number(maxRow?.n ?? 0) + 1;

  // ── 6) 写产物（先写 R2，失败就什么都没有）──────────────────────────
  const target = publicPrefix(tenantId, version);
  let bytes = 0;
  for (const [path, body] of rendered) {
    await sites.put(`${target}${path}`, body, {
      httpMetadata: { contentType: isTextPath(path) ? "text/plain; charset=utf-8" : undefined },
      customMetadata: { source_sha: sha },
    });
    bytes += typeof body === "string" ? body.length : body.byteLength;
  }

  // 6b) **平台文件**：SDK 与支付回跳页，每次发布都写进产物（理由见 docs/site-storage.md）
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

  // ── 7) 记账。seq 唯一索引会挡住并发发布撞号 ────────────────────────
  try {
    await env.DB.prepare(
      `INSERT INTO site_releases
         (tenant_id, seq, source_sha, artifact_sha, seed_sha, files, bytes, idem_key, created_by, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
      .bind(
        tenantId,
        version,
        sha,
        artifact.sha,
        seed,
        rendered.size + platform.length,
        bytes,
        idemKey,
        input.actor ?? input.trigger ?? null,
        new Date().toISOString(),
      )
      .run();
  } catch {
    return err("version_conflict", "有人同时在发布，请重试");
  }

  // ── 8) **最后一步**：切指针（site-serve 的指针缓存 5 s，最多 5 秒生效）──
  await switchPointer(env, tenantId, version, "publish", input.actor ?? input.trigger ?? null);

  return {
    ok: true,
    version,
    files: rendered.size + platform.length,
    bytes,
    sourceSha: sha,
    artifactSha: artifact.sha,
    seedSha: seed,
    idempotent: false,
  };
}

/**
 * 切指针 + 写审计。
 *
 * **回滚不产生新版本**，所以"线上曾经变过"只能靠 `site_pointer_log` 回答；少了它，
 * 事后查不出"谁在什么时候把线上从 v3 切回 v2"（契约 §0.1.3）。
 */
export async function switchPointer(
  env: Env,
  tenantId: string,
  toN: number,
  reason: "publish" | "rollback",
  actor: string | null,
): Promise<void> {
  const before = env.HOSTS
    ? ((await env.HOSTS.get(activeKey(tenantId), "json")) as { n?: number } | null)
    : null;
  const from = before?.n ?? null;
  await env.DB.prepare(
    `INSERT INTO site_pointer_log (tenant_id, from_n, to_n, reason, created_by, created_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
  )
    .bind(tenantId, from, toN, reason, actor, new Date().toISOString())
    .run();
  if (env.HOSTS) await env.HOSTS.put(activeKey(tenantId), JSON.stringify({ n: toN }));
}

export interface SiteState {
  /** 当前线上版本；从未发布过是 null */
  active: number | null;
  /** 源包从哪来：`release:v7` = 线上那一版；`seed` = 还没发布过 */
  sourceFrom: string;
  /** 最近若干版，最新在前 */
  releases: {
    seq: number;
    source_sha: string;
    artifact_sha: string;
    files: number;
    bytes: number;
    created_at: string;
  }[];
}

export async function siteState(env: Env, tenantId: string): Promise<SiteState> {
  const pointer = env.HOSTS
    ? ((await env.HOSTS.get(activeKey(tenantId), "json")) as { n?: number } | null)
    : null;

  const rows = await env.DB.prepare(
    `SELECT seq, source_sha, artifact_sha, files, bytes, created_at
       FROM site_releases WHERE tenant_id = ? ORDER BY seq DESC LIMIT 20`,
  )
    .bind(tenantId)
    .all<{
      seq: number;
      source_sha: string;
      artifact_sha: string;
      files: number;
      bytes: number;
      created_at: string;
    }>();

  const active = pointer?.n ?? null;
  return {
    active,
    sourceFrom: active ? `release:v${active}` : "seed",
    releases: rows.results ?? [],
  };
}
