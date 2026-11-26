/**
 * **发布**：把「一份源包 + 当前设置」烘焙成产物，记一个版本号，**最后一步**切 KV 指针。
 *
 * 契约 `site-studio.md` §0.1（Contract 16）：
 *
 *   · **发布** = 设计交付：有签收、产生版本号（`site_releases` 一行）、切指针。
 *   · **烘焙** = 用现在的设置把现在这份设计渲染一遍（`src/site/bake.ts`），不记账。
 *
 * 设置一改就要重烘焙（`reprintSite`），指针只换 `artifact_sha`，`template_seq` 不动
 * —— 换一个主色不该占一个设计版本号。回滚反过来：`template_seq` 指回旧设计，
 * 用**当前**设置重烘焙（设计回滚、身份不回滚）。
 *
 * 四条纪律：
 *  1. **渲染只发生在烘焙时**：`site-serve` 只做「读指针 → 取 `art/<sha>/` 的文件」。
 *  2. **顺序不可交换**：产物全量写完、发布记录插好，**最后**才切指针。任何一步失败，
 *     线上仍是上一版。
 *  3. **产物按内容寻址**：`art/<artifact_sha>/`，写进去就不再改 —— 于是"发布中途失败"
 *     与"回滚时读到的半新半旧"都不可能发生。
 *  4. **幂等键 = 渲染后的整版内容**（studio 算的 `contentSha`）：同内容重复提交返回
 *     **已有** `seq`。版本号是租户唯一看到的数字，双击/重试不许让它跳号。
 *
 * 与 cf-api 的分工：域名/证书/KV 写穿归 cf-api；**站点产物与 active 指针归这里**。
 */
import { bakeSite } from "./bake";
import { readSiteSettings } from "./settings";
import { seedSha } from "./source";

import type { BakeResult } from "./bake";
import type { Env } from "../env";

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
   * 幂等键：studio 传的 `contentSha`（渲染后的整版内容）。
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
   * **必须由发布方给**：`/_crm/config.js` 在烘焙时写死它，站点与 CRM 不同域，
   * 发上去之后没人能改。
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
  /** 这版产物的地址（`art/<sha>/` 的那个 sha） */
  artifactSha: string;
  /** S2：设了值但这份模板没用到（见 `bake.ts` 的 `unusedOf`） */
  unusedSettings: string[];
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

/**
 * 线上指针：**设计是哪一版 + 线上跑的是哪份产物**。
 *
 * 两个 sha 各管一件事，合起来才能"设计回滚、身份不回滚"：
 *   · `template_seq` → `site_releases.seq`（哪一版设计）
 *   · `artifact_sha` → `art/<sha>/`（哪份烘焙结果，已经带上当时的设置）
 *
 * `baked_at` / `settings_rev` 是给后台显示「最后烘焙 …，设置 rev N」用的 ——
 * 不建表（D5）：它们是这次烘焙的事实，跟着指针走正好。
 */
export interface SitePointer {
  templateSeq: number | null;
  artifactSha: string;
  bakedAt: string;
  settingsRev: number;
}

/** 指针 key：`site-serve` 读的就是它 */
export const activeKey = (tenantId: string): string => `site:${tenantId}:active`;

/** 读指针；没发布过就是 `null` */
export async function readPointer(env: Env, tenantId: string): Promise<SitePointer | null> {
  if (!env.HOSTS) return null;
  const raw = (await env.HOSTS.get(activeKey(tenantId), "json")) as Partial<SitePointer> | null;
  if (!raw || !raw.artifactSha) return null;
  return {
    templateSeq: typeof raw.templateSeq === "number" ? raw.templateSeq : null,
    artifactSha: raw.artifactSha,
    bakedAt: String(raw.bakedAt ?? ""),
    settingsRev: Number(raw.settingsRev ?? 0),
  };
}

/** 只写指针（**不写审计**）：重烘焙用它，因为设计版本没变 */
async function writePointer(env: Env, tenantId: string, pointer: SitePointer): Promise<void> {
  if (!env.HOSTS) return;
  await env.HOSTS.put(activeKey(tenantId), JSON.stringify(pointer));
}

interface ReleaseRow {
  seq: number;
  sourceSha: string;
  artifactSha: string;
  seedSha: string;
}

/** 最近一次发布（没有就是 null） */
export async function latestRelease(env: Env, tenantId: string): Promise<ReleaseRow | null> {
  const row = await env.DB.prepare(
    `SELECT seq, source_sha, artifact_sha, seed_sha FROM site_releases
      WHERE tenant_id = ? ORDER BY seq DESC LIMIT 1`,
  )
    .bind(tenantId)
    .first<{ seq: number; source_sha: string; artifact_sha: string; seed_sha: string }>();
  return row
    ? {
        seq: Number(row.seq),
        sourceSha: row.source_sha,
        artifactSha: row.artifact_sha,
        seedSha: row.seed_sha,
      }
    : null;
}

/** 某一版发布记录（回滚要用它的源包重烘焙） */
async function releaseOf(env: Env, tenantId: string, seq: number): Promise<ReleaseRow | null> {
  const row = await env.DB.prepare(
    `SELECT seq, source_sha, artifact_sha, seed_sha FROM site_releases
      WHERE tenant_id = ? AND seq = ?`,
  )
    .bind(tenantId, seq)
    .first<{ seq: number; source_sha: string; artifact_sha: string; seed_sha: string }>();
  return row
    ? {
        seq: Number(row.seq),
        sourceSha: row.source_sha,
        artifactSha: row.artifact_sha,
        seedSha: row.seed_sha,
      }
    : null;
}

/**
 * 发布一版。
 *
 * 顺序：烘焙（写 `art/<sha>/`）→ 分配版本号 → 插发布记录 → **最后**切指针。
 * 任何一步失败，线上仍是上一版，发布记录也不会多一行。
 */
export async function publishSite(
  env: Env,
  tenantId: string,
  input: PublishInput = {},
): Promise<PublishResult> {
  if (!env.SITES) {
    return err("r2_not_configured", "没有绑定 SITES（R2）：站点产物无处可放。见 docs/self-host.md 的站点一节");
  }
  if (!env.HOSTS) {
    return err("kv_not_configured", "没有绑定 HOSTS（KV）：发布完切不了指针，站点点不开");
  }
  if (!tenantId) return err("no_tenant", "拿不到租户 ID，不知道往哪个前缀写");

  // ── 1) 这次发哪份源包：显式给的 > 上次发的 ──────────────────────────
  const seed = await seedSha();
  const latest = await latestRelease(env, tenantId);
  const wanted = (input.sourceSha ?? "").trim();
  const sha = wanted || latest?.sourceSha || "";

  /**
   * **种子不是可发布的内容**：它只是设计器里的起点。
   *
   * 判据是"**有没有租户源包**"，不是"这份源包像不像种子"：
   *
   *   · 后台「发布站点」不带源文件，只能重发已有设计 —— 新站点没有源包，
   *     拒绝（否则点一下就能把通用模板发上线，租户会以为"这就是我的站"）；
   *   · 设计器发布**先交付**一份租户源包（`tpl/<sha>/`）再发。哪怕一个字都没改
   *     （内容与种子逐字节相同、sha 也相同），那也是一份**签收过的**源包 ——
   *     拦它等于"让用户先随便改一个字才能发布第一版"，没有道理。
   */
  if (!sha) {
    return err(
      "no_template",
      "还没有模板：新站点要在设计器里发布第一版（后台不能直接发布起点模板）",
    );
  }

  // ── 2) 幂等：同键直接返回已有版本（不新增、不重写字节）────────────────
  //
  //   **只认最新那一版**。幂等说的是"同一个请求重复提交"，不是"内容等于历史上
  //   某一版"：租户把站点改回三天前的样子再发布，是**一次新的发布**，该产生新
  //   版本并把指针挪过去。早先按 `idem_key` 全表查，改回旧内容会命中旧那一行
  //   —— 于是接口回 200 + 旧 seq、指针不动，界面上"发布成功"而线上没变。
  const idemKey = (input.idemKey ?? "").trim();
  if (idemKey) {
    const hit = await env.DB.prepare(
      `SELECT seq, source_sha, artifact_sha, seed_sha, files, bytes FROM site_releases
        WHERE tenant_id = ? AND idem_key = ? ORDER BY seq DESC LIMIT 1`,
    )
      .bind(tenantId, idemKey)
      .first<Record<string, unknown>>();
    if (hit && (!latest || Number(hit.seq) === Number(latest.seq))) {
      return {
        ok: true,
        version: Number(hit.seq),
        files: Number(hit.files),
        bytes: Number(hit.bytes),
        sourceSha: String(hit.source_sha),
        artifactSha: String(hit.artifact_sha),
        seedSha: String(hit.seed_sha),
        // 幂等命中没重新烘焙：S2 是"这次渲染"的结论，这里不猜（空 = 不提示）
        unusedSettings: [],
        idempotent: true,
      };
    }
  }

  // ── 3) 烘焙：写内容寻址的 `art/<sha>/`（设计 + 当前设置 → 字节）──────
  const baked = await bakeSite(env, tenantId, {
    apiBase: input.apiBase ?? "",
    sourceSha: sha,
    ...(input.brandFallback ? { brandFallback: input.brandFallback } : {}),
  });
  if (!baked.ok) {
    return err(baked.code, baked.message, baked.issues);
  }

  // ── 4) 版本号：以 D1 为准（KV 只是指针，不能当计数器用）──────────────
  const maxRow = await env.DB.prepare(
    `SELECT COALESCE(MAX(seq), 0) AS n FROM site_releases WHERE tenant_id = ?`,
  )
    .bind(tenantId)
    .first<{ n: number }>();
  const version = Number(maxRow?.n ?? 0) + 1;

  // ── 5) 记账。seq 唯一索引会挡住并发发布撞号 ────────────────────────
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
        baked.artifactSha,
        seed,
        baked.files,
        baked.bytes,
        idemKey,
        input.actor ?? input.trigger ?? null,
        new Date().toISOString(),
      )
      .run();
  } catch {
    return err("version_conflict", "有人同时在发布，请重试");
  }

  // ── 6) **最后一步**：切指针（site-serve 的指针缓存 5 s，最多 5 秒生效）──
  await switchPointer(
    env,
    tenantId,
    { templateSeq: version, artifactSha: baked.artifactSha, bakedAt: new Date().toISOString(), settingsRev: baked.settingsRev },
    "publish",
    input.actor ?? input.trigger ?? null,
  );

  return {
    ok: true,
    version,
    files: baked.files,
    bytes: baked.bytes,
    sourceSha: sha,
    artifactSha: baked.artifactSha,
    seedSha: seed,
    unusedSettings: baked.unusedSettings,
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
  next: SitePointer,
  reason: "publish" | "rollback",
  actor: string | null,
): Promise<void> {
  const before = await readPointer(env, tenantId);
  await env.DB.prepare(
    `INSERT INTO site_pointer_log (tenant_id, from_n, to_n, reason, created_by, created_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
  )
    .bind(
      tenantId,
      before?.templateSeq ?? null,
      next.templateSeq,
      reason,
      actor,
      new Date().toISOString(),
    )
    .run();
  await writePointer(env, tenantId, next);
}

export type ReprintResult =
  | {
      ok: true;
      /** 这次真的重烘焙了吗（从没发布过 = false：没有线上设计可烘） */
      baked: boolean;
      artifactSha: string | null;
      bakedAt: string | null;
      settingsRev: number;
      /** S2：设了值但模板没用到（没烘焙时为空） */
      unusedSettings: string[];
    }
  | { ok: false; code: string; message: string; issues?: string[] };

/**
 * **重烘焙**：用**现在的设置**把**线上那一份设计**重新渲染一遍。
 *
 * 触发点：保存设置之后（`PUT /api/site/settings` 与后台同一件事）。设计版本不动
 * —— 换颜色不是发新版；线上指针只换 `artifact_sha`，`site-serve` 5 秒内就换成新的。
 *
 * 还没发布过 ⇒ 什么都不做（没有线上设计可烘）：第一次发布才产生 v1。
 */
export async function reprintSite(
  env: Env,
  tenantId: string,
  input: { apiBase: string; brandFallback?: string },
): Promise<ReprintResult> {
  const baked0 = await readSiteSettings(env);
  const pointer = await readPointer(env, tenantId);
  if (!pointer || pointer.templateSeq === null) {
    return {
      ok: true,
      baked: false,
      artifactSha: null,
      bakedAt: null,
      settingsRev: baked0.rev,
      unusedSettings: [],
    };
  }
  const release = await releaseOf(env, tenantId, pointer.templateSeq);
  if (!release) {
    return {
      ok: false,
      code: "template_missing",
      message: `线上指的是第 ${pointer.templateSeq} 版，但发布记录里没有它（数据库被清过？）`,
    };
  }

  const baked = await bakeSite(env, tenantId, {
    apiBase: input.apiBase,
    sourceSha: release.sourceSha,
    ...(input.brandFallback ? { brandFallback: input.brandFallback } : {}),
  });
  if (!baked.ok) {
    // 设置已经存下了，但渲染不出来：指针不动，线上继续服务上一份产物。
    // 调用方要把这句话如实告诉租户（"设置已保存，但线上没换"）。
    return { ok: false, code: baked.code, message: baked.message, ...(baked.issues ? { issues: baked.issues } : {}) };
  }

  const bakedAt = new Date().toISOString();
  await writePointer(env, tenantId, {
    templateSeq: pointer.templateSeq,
    artifactSha: baked.artifactSha,
    bakedAt,
    settingsRev: baked.settingsRev,
  });
  return {
    ok: true,
    baked: true,
    artifactSha: baked.artifactSha,
    bakedAt,
    settingsRev: baked.settingsRev,
    unusedSettings: baked.unusedSettings,
  };
}

/** 回滚：设计回到 `seq`，但用**当前**设置重烘焙（身份不回滚） */
export async function rollbackSite(
  env: Env,
  tenantId: string,
  seq: number,
  input: { apiBase: string; actor: string | null; brandFallback?: string },
): Promise<ReprintResult> {
  if (!env.HOSTS) return { ok: false, code: "kv_not_configured", message: "没有绑定 HOSTS（KV）" };
  const release = await releaseOf(env, tenantId, seq);
  if (!release) {
    return { ok: false, code: "unknown_version", message: `没有 ${seq} 这一版` };
  }
  const baked = await bakeSite(env, tenantId, {
    apiBase: input.apiBase,
    sourceSha: release.sourceSha,
    ...(input.brandFallback ? { brandFallback: input.brandFallback } : {}),
  });
  if (!baked.ok) return baked;

  const bakedAt = new Date().toISOString();
  await switchPointer(
    env,
    tenantId,
    { templateSeq: seq, artifactSha: baked.artifactSha, bakedAt, settingsRev: baked.settingsRev },
    "rollback",
    input.actor,
  );
  return {
    ok: true,
    baked: true,
    artifactSha: baked.artifactSha,
    bakedAt,
    settingsRev: baked.settingsRev,
    unusedSettings: baked.unusedSettings,
  };
}

export interface SiteState {
  /** 当前线上设计版本；从未发布过是 null */
  active: number | null;
  /** 源包从哪来：`release:v7` = 线上那一版；`seed` = 还没发布过 */
  sourceFrom: string;
  /** 线上正在服务的那份产物（`art/<sha>/`）+ 它是什么时候、用哪版设置烘出来的 */
  live: { artifactSha: string; bakedAt: string; settingsRev: number } | null;
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
  const pointer = await readPointer(env, tenantId);

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

  const active = pointer?.templateSeq ?? null;
  return {
    active,
    sourceFrom: active ? `release:v${active}` : "seed",
    live: pointer
      ? {
          artifactSha: pointer.artifactSha,
          bakedAt: pointer.bakedAt,
          settingsRev: pointer.settingsRev,
        }
      : null,
    releases: rows.results ?? [],
  };
}
