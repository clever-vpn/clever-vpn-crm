#!/usr/bin/env node
/**
 * 迁移链校验（照 cf-api `scripts/migrations-check.mjs` 的简化版）
 *
 * 为什么需要：这类事故编译/类型/单测**都不会报**
 *   · 手写的 sql 混进生产链（同一套表两种列名，谁都看不出来）；
 *   · 改了 `src/db/schema.ts` 却忘了跑 `npm run db:generate`（部署时生产库静默落后）；
 *   · 把 `migrations-dev/` 的产物提交进仓库（那是 reset 脚本生成的临时链）。
 *
 * 三段判据：
 *   A 结构   每个 `.sql` ↔ `meta/_journal.json` 一一对应；序号连续；dev 链不入库。
 *   B 不可变 相对**最近一次发布 tag**：已发布的迁移不得修改/删除（租户库已 apply）。
 *            没有任何 `v*` tag 时跳段 B —— 那是"还没发布"，整条链可以随时重写（压成 baseline）。
 *   C 漂移   重跑 `drizzle-kit generate`，若产出任何东西 ⇒ schema 与迁移链不同步。
 *
 * 用法：
 *   node scripts/migrations-check.mjs           # 全跑，失败退出码 1
 *   node scripts/migrations-check.mjs --list    # 只看现状
 *   node scripts/migrations-check.mjs --force   # B 段降级为告警
 */
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = process.cwd();
const PROD_DIR = "migrations";
const DEV_DIR = "migrations-dev";
// 基线 = 最近一次发布 tag。迁移一旦随 release 发出去，租户库就 apply 过了，
// 那时再改它 = 改历史；而没有 tag 的时候，改它只是还没定稿。
const BASE_REF = process.env.MIGRATIONS_BASE_REF ?? latestReleaseTag();
const args = new Set(process.argv.slice(2));
const LIST_ONLY = args.has("--list");
const FORCE = args.has("--force");

const problems = [];
const notes = [];

function git(cmdArgs, allowFail = false) {
  try {
    return execFileSync("git", cmdArgs, {
      cwd: ROOT,
      encoding: "utf8",
      // `git describe` 在没有 tag 时会往 stderr 喷 "No names found"，那是预期情况，别吓人。
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch (e) {
    if (allowFail) return null;
    throw e;
  }
}

function latestReleaseTag() {
  return git(["describe", "--tags", "--abbrev=0", "--match", "v[0-9]*"], true) || null;
}

function sqlFiles() {
  return readdirSync(join(ROOT, PROD_DIR))
    .filter((f) => f.endsWith(".sql"))
    .sort();
}

function journalTags() {
  const raw = readFileSync(join(ROOT, PROD_DIR, "meta", "_journal.json"), "utf8");
  return JSON.parse(raw).entries.map((e) => `${e.tag}.sql`);
}

function listStatus() {
  const files = sqlFiles();
  const tags = journalTags();
  console.log(`生产链 ${files.length} 条：`);
  files.forEach((f, i) => console.log(`  ${i}. ${f}${tags.includes(f) ? "" : "  ← 不在 journal 里"}`));
  console.log(`dev 链：${existsSync(join(ROOT, DEV_DIR)) ? readdirSync(join(ROOT, DEV_DIR)).join(", ") : "（尚未生成）"}`);
}

// ── A 结构 ────────────────────────────────────────────────────────
function checkStructure() {
  const files = sqlFiles();
  const tags = journalTags();

  files.forEach((f, i) => {
    if (!/^\d{4}_[a-z0-9_]+\.sql$/.test(f)) {
      problems.push(`[A] 文件名不合规：${f}（应为 0000_xxx.sql）`);
    }
    if (f.slice(0, 4) !== String(i).padStart(4, "0")) {
      problems.push(`[A] 序号不连续：第 ${i} 个文件是 ${f}`);
    }
  });

  if (files.join() !== tags.join()) {
    problems.push(`[A] sql 与 meta/_journal.json 不一致：\n    sql:   ${files.join(", ")}\n    journal: ${tags.join(", ")}`);
  }

  // dev 链是产物，不能入库
  const tracked = git(["ls-files", DEV_DIR], true);
  if (tracked) {
    problems.push(`[A] ${DEV_DIR}/ 被提交进仓库了（它由 scripts/reset-db.sh 生成）`);
  }
  if (!existsSync(join(ROOT, ".gitignore")) || !readFileSync(join(ROOT, ".gitignore"), "utf8").includes(`${DEV_DIR}/`)) {
    problems.push(`[A] .gitignore 里缺少 ${DEV_DIR}/`);
  }
}

// ── B 不可变 ──────────────────────────────────────────────────────
function checkImmutable() {
  if (!BASE_REF) {
    notes.push("[B] 仓库还没有 v* 发布 tag（尚未发布）⇒ 迁移链可自由重写，跳过不可变检查");
    return;
  }
  if (!git(["rev-parse", "--verify", BASE_REF], true)) {
    notes.push(`[B] 找不到基线 ${BASE_REF}，跳过不可变检查`);
    return;
  }
  const diff = git(["diff", "--name-status", `${BASE_REF}...HEAD`, "--", PROD_DIR], true);
  if (!diff) return;
  for (const line of diff.split("\n").filter(Boolean)) {
    const [status, file] = line.split("\t");
    if (status !== "M" && status !== "D") continue;
    // `meta/` 是记账（journal + 每个迁移的 snapshot），**新增迁移时必然被改**，
    // 不能算"篡改历史"。真正要守的是 `.sql` 本身：改了它就等于改已 apply 的 DDL。
    if (file.includes("/meta/")) continue;
    (FORCE ? notes : problems).push(
      `[B] 已发布的迁移被${status === "M" ? "修改" : "删除"}：${file}（租户库已 apply，请新增一条迁移）`,
    );
  }
}

// ── C 漂移 ────────────────────────────────────────────────────────
function checkDrift() {
  const before = new Set(sqlFiles());
  const journalBefore = readFileSync(join(ROOT, PROD_DIR, "meta", "_journal.json"), "utf8");
  try {
    execFileSync("./node_modules/.bin/drizzle-kit", ["generate", "--name", "__drift_check"], {
      cwd: ROOT,
      stdio: "pipe",
    });
  } catch {
    problems.push("[C] drizzle-kit generate 执行失败");
    return;
  }
  const after = sqlFiles();
  const fresh = after.filter((f) => !before.has(f));
  if (fresh.length > 0) {
    problems.push(
      `[C] schema.ts 与迁移链不同步：generate 产出了新迁移 ${fresh.join(", ")}。\n` +
        `    请运行 npm run db:generate 并提交产物。`,
    );
  }
  // 还原现场：**只删本次 generate 新产出的东西**（含它的 snapshot），journal 用内存原文写回。
  // 千万别用 `git clean -fd migrations` —— 那会连开发者还没来得及 `git add` 的合法迁移一起删掉
  // （本项目实测踩过：刚生成的迁移被静默删除，check 还报"正常"）。
  fresh.forEach((f) => {
    unlinkSync(join(ROOT, PROD_DIR, f));
    const snap = join(ROOT, PROD_DIR, "meta", `${f.slice(0, 4)}_snapshot.json`);
    if (existsSync(snap)) unlinkSync(snap);
  });
  writeFileSync(join(ROOT, PROD_DIR, "meta", "_journal.json"), journalBefore);
  if (readFileSync(join(ROOT, PROD_DIR, "meta", "_journal.json"), "utf8") !== journalBefore) {
    notes.push("[C] journal 未能自动还原，请检查 git status");
  }
}

if (LIST_ONLY) {
  listStatus();
  process.exit(0);
}

checkStructure();
checkImmutable();
checkDrift();

if (notes.length) {
  console.log(notes.map((n) => `ℹ️  ${n}`).join("\n"));
}
if (problems.length) {
  console.error(problems.map((p) => `❌ ${p}`).join("\n"));
  process.exit(1);
}
console.log(`✅ 迁移链正常（${sqlFiles().length} 条生产迁移）`);
