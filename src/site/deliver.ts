/**
 * 源包**入库前**的校验（契约 `site-studio-crm.md` §4、§5.1）。
 *
 * 一句话：把 studio 交上来的文件变成"内容寻址的源包"，只做校验 + 存字节，
 * **不分配版本号**（那是发布记录的事，见 `publish.ts`）。
 *
 * 这个文件几乎全是**校验**，因为它是唯一一个"外部内容进入我们存储"的入口：
 *
 *   · `engine` 不一致 ⇒ 拒。渲染器不同，"预览长这样"就没有意义（§4.2）。
 *   · `contract` 不一致 ⇒ 拒。模板引用的字段在当前契约里没了，不做"尽力渲染"。
 *   · 逐文件 `sha256`/`bytes` 与 `content_b64` 不符 ⇒ 拒。**整包拒**，不留半份。
 *   · 用**当前数据**渲染一遍 `.html`：出现 `missing` 路径（H1）⇒ 拒，并列出路径。
 *   · 渲染结果算一次 `artifact_sha256`，与 `manifest.preview.artifact_sha256` 比
 *     （§5.1）。不相等 = 租户看到的和真实数据渲染出来的不是同一页 ⇒ 拒。
 *
 * 校验顺序是刻意的：**先便宜后昂贵**（形状 → 摘要 → 渲染），渲染只发生在前面都过了之后。
 */

import { ENGINE_ID } from "./engine.generated";
import { SITE_CONTRACT } from "./meta";
import { renderTemplate } from "./render";
import { ALLOWED_EXT } from "./publish";
import { getSiteAsset, readSiteAssetBytes } from "./assets";
import { buildScope, readSiteSettings } from "./settings";
import { TPL_LIMITS, checkSourcePath, storeSource } from "./source";

import type { SourceFileInput } from "./source";
import type { Env } from "../env";

const enc = new TextEncoder();

/** 平台保留前缀：模板不许占（H4），交上来就拒 */
const RESERVED = ["_crm/"];

/** 素材 MIME → 产物扩展名：指针送上来时校验“路径与内容是不是同一种东西” */
const EXT_OF_MIME: Record<string, string> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/webp": "webp",
  "image/svg+xml": "svg",
};

export interface DeliveryFileIn {
  path?: unknown;
  content_b64?: unknown;
  /**
   * 素材指针：字节在 R2 的 blob 里，**不上行**（契约 `site-assets.md` §3）。
   * 给了它就忽略 `content_b64`；两者必居其一。
   */
  asset_id?: unknown;
}

export interface DeliveryManifestIn {
  package?: unknown;
  engine?: unknown;
  contract?: unknown;
  studio_rev?: unknown;
  base_package?: unknown;
  preview?: { artifact_sha256?: unknown } | null;
  signoff?: { by?: unknown; at?: unknown } | null;
  files?: { path?: unknown; sha256?: unknown; bytes?: unknown }[] | null;
}

export interface DeliveryInput {
  manifest?: DeliveryManifestIn | null;
  files?: DeliveryFileIn[] | null;
}

export interface DeliveryOk {
  ok: true;
  /** 源包指纹（内容寻址）；`tpl/<hex>/files/` */
  sha: string;
  files: number;
  bytes: number;
}

export interface DeliveryErr {
  ok: false;
  status: number;
  code: string;
  message: string;
  issues?: string[];
}

export type DeliveryResult = DeliveryOk | DeliveryErr;

const fail = (
  status: number,
  code: string,
  message: string,
  issues?: string[],
): DeliveryErr => ({ ok: false, status, code, message, ...(issues ? { issues } : {}) });

const b64ToBytes = (text: string): Uint8Array => {
  const raw = atob(text);
  const out = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i += 1) out[i] = raw.charCodeAt(i);
  return out;
};

async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/**
 * 渲染后产物的指纹（契约 §5.1）：**只算 `.html` 页面**。
 *
 * CSS/JS/图片不算：它们不经渲染，算进去只是把同样的信息抄一遍。
 * `config.js` 与 `_crm/*` 也不算：一个在发布时被写死 CRM 地址，一个每次发布重新注入，
 * 算进去会让"同一版模板"的 sha 跟着部署地址变。
 */
export async function artifactShaOf(
  files: { path: string; text: string }[],
  scope: Record<string, unknown>,
): Promise<{ sha: string; missing: string[] }> {
  const missing = new Set<string>();
  const entries: { path: string; sha256: string; bytes: number }[] = [];
  for (const file of files) {
    if (!/\.html?$/i.test(file.path)) continue;
    const rendered = renderTemplate(file.text, scope);
    for (const m of rendered.missing) missing.add(m);
    const bytes = enc.encode(rendered.html);
    entries.push({ path: file.path, sha256: await sha256Hex(bytes), bytes: bytes.byteLength });
  }
  const lines = entries
    .sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))
    .map((e) => `${e.path}\u0000${e.sha256}\u0000${e.bytes}`)
    .join("\n");
  return { sha: `sha256:${await sha256Hex(enc.encode(lines))}`, missing: [...missing] };
}

export async function deliverSite(
  env: Env,
  tenantId: string,
  input: DeliveryInput,
): Promise<DeliveryResult> {
  const manifest = input.manifest ?? null;
  if (!manifest || typeof manifest !== "object") {
    return fail(400, "site_manifest_invalid", "缺少 manifest");
  }
  const list = Array.isArray(input.files) ? input.files : [];
  if (list.length === 0) return fail(400, "site_manifest_invalid", "files 为空");

  // ── 1) 形状：包格式 / 引擎 / 契约 ─────────────────────────────────────
  if (Number(manifest.package) !== 1) {
    return fail(400, "site_manifest_invalid", "package 必须是 1");
  }
  const engine = String(manifest.engine ?? "");
  if (engine !== ENGINE_ID) {
    return fail(422, "site_engine_unsupported", `引擎不一致：模板 ${engine || "(空)"}，本 CRM ${ENGINE_ID}`);
  }
  if (Number(manifest.contract) !== SITE_CONTRACT) {
    return fail(
      422,
      "site_contract_unsupported",
      `数据契约不一致：模板 ${String(manifest.contract ?? "")}，本 CRM ${SITE_CONTRACT}`,
    );
  }
  const signoffBy = String(manifest.signoff?.by ?? "").trim();
  if (!signoffBy) return fail(422, "site_signoff_missing", "缺租户签收（manifest.signoff.by）");
  const claimedArtifact = String(manifest.preview?.artifact_sha256 ?? "").trim();
  if (!/^sha256:[0-9a-f]{64}$/i.test(claimedArtifact)) {
    return fail(422, "site_manifest_invalid", "manifest.preview.artifact_sha256 缺失或格式不对");
  }

  // ── 2) 文件：路径、保留前缀、体积 ────────────────────────────────────
  const files: SourceFileInput[] = [];
  const texts = new Map<string, string>();
  const actual = new Map<string, { sha256: string; bytes: number }>();
  let total = 0;

  for (const item of list) {
    const path = String(item?.path ?? "");
    const b64 = String(item?.content_b64 ?? "");
    const assetId = String(item?.asset_id ?? "");
    if (!path || (!b64 && !assetId)) {
      return fail(400, "site_manifest_invalid", `每个文件都要 path 与 content_b64（或 asset_id）：${path || "(空)"}`);
    }
    if (RESERVED.some((prefix) => path.startsWith(prefix))) {
      return fail(400, "site_path_rejected", `${path} 是平台保留路径（/_crm/*）`);
    }
    const problem = checkSourcePath(path);
    if (problem) return fail(400, "site_path_rejected", problem);

    let bytes: Uint8Array;
    if (assetId) {
      // 指针：字节从 blob 取（服务端读，不经 studio），类型要与路径扩展名对得上
      const asset = await getSiteAsset(env, tenantId, assetId);
      if (!asset) {
        return fail(422, "site_asset_missing", `${path} 引用的素材不存在或已被删除`);
      }
      const ext = path.slice(path.lastIndexOf(".") + 1).toLowerCase();
      const want = EXT_OF_MIME[asset.mime];
      if (want && want !== ext && !(want === "jpg" && ext === "jpeg")) {
        return fail(400, "site_asset_mismatch", `${path} 是 ${ext}，但素材是 ${asset.mime}`);
      }
      const obj = await readSiteAssetBytes(env, tenantId, assetId);
      if (!obj) return fail(422, "site_asset_missing", `${path} 的素材字节丢了（R2 里没有）`);
      bytes = new Uint8Array(await obj.arrayBuffer());
    } else {
      try {
        bytes = b64ToBytes(b64);
      } catch {
        return fail(400, "site_manifest_invalid", `${path} 的 content_b64 不是合法 base64`);
      }
    }
    if (bytes.byteLength > TPL_LIMITS.fileBytes) {
      return fail(413, "site_bundle_too_large", `${path} 超过单文件上限 ${TPL_LIMITS.fileBytes} 字节`);
    }
    total += bytes.byteLength;
    if (total > TPL_LIMITS.totalBytes) {
      return fail(413, "site_bundle_too_large", `整包超过上限 ${TPL_LIMITS.totalBytes} 字节`);
    }
    if (actual.has(path)) return fail(400, "site_manifest_invalid", `重复路径：${path}`);

    const ext = path.slice(path.lastIndexOf(".") + 1).toLowerCase();
    if (!ALLOWED_EXT.has(ext)) return fail(400, "site_path_rejected", `不允许的文件类型：${path}`);

    actual.set(path, { sha256: await sha256Hex(bytes), bytes: bytes.byteLength });
    // 记下"这个文件是素材物化来的"：重置草稿时按它还原成指针（见 source.ts）
    files.push({ path, body: bytes, ...(assetId ? { assetId } : {}) });
    texts.set(path, new TextDecoder().decode(bytes));
  }

  if (!actual.has("index.html")) {
    return fail(422, "site_gate_hard_failed", "模板没有 index.html", ["根路径无处可服务"]);
  }

  // ── 3) 摘要：manifest 说的必须与实际字节一致（整包拒，不留半份）────────
  const declared = Array.isArray(manifest.files) ? manifest.files : [];
  if (declared.length !== files.length) {
    return fail(400, "site_manifest_invalid", `manifest.files 有 ${declared.length} 个，实际 ${files.length} 个`);
  }
  for (const entry of declared) {
    const path = String(entry?.path ?? "");
    const got = actual.get(path);
    if (!got) return fail(400, "site_hash_mismatch", `manifest 里有 ${path}，但没交这份文件`);
    if (String(entry?.sha256 ?? "").toLowerCase() !== got.sha256) {
      return fail(400, "site_hash_mismatch", `${path} 的 sha256 与内容不符`);
    }
    if (Number(entry?.bytes ?? -1) !== got.bytes) {
      return fail(400, "site_hash_mismatch", `${path} 的 bytes 与内容不符`);
    }
  }

  // ── 4) 渲染：H1（未知路径）+ 预览与真实数据是否同一页（§5.1）──────────
  const settings = await readSiteSettings(env);
  const scope = buildScope(settings, "我的站点");
  const artifact = await artifactShaOf(
    [...texts.entries()].map(([path, text]) => ({ path, text })),
    scope,
  );
  if (artifact.missing.length > 0) {
    return fail(422, "site_gate_hard_failed", "模板用了当前数据里没有的字段", [
      `未声明的路径：${artifact.missing.join("、")}`,
      "字段清单在 GET /api/site/meta 的 capabilities 里；不能用模板自带的值补齐",
    ]);
  }
  if (artifact.sha !== claimedArtifact.toLowerCase()) {
    return fail(
      422,
      "site_preview_mismatch",
      "你签收的那一版与当前数据渲染出来的不是同一页",
      [`你看到的：${claimedArtifact}`, `现在渲染：${artifact.sha}`, "数据改动过就重新预览再交付"],
    );
  }

  // ── 5) 入库：内容寻址（同内容只存一份），**不记账、不分配版本** ──────────
  const stored = await storeSource(env, files);
  if (!stored.ok) {
    return fail(400, stored.code, stored.message);
  }

  return {
    ok: true,
    sha: stored.sha,
    files: stored.entries.length,
    bytes: stored.totalBytes,
  };
}
