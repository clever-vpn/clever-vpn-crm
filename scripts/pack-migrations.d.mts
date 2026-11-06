/**
 * `scripts/pack-migrations.mjs` 的类型声明。
 *
 * 为什么需要它：脚本是 `.mjs`（CI 里由 `node` 直接跑，不经过 tsc），而 `test/**`
 * 会被 `tsc --noEmit` 检查。没有声明文件时 `npm run typecheck` 报 TS7016
 * （隐式 any），release workflow 就挂在 typecheck 上。
 *
 * 这里的形状 = release asset `migrations.json` 的形状，也就是 cf-api 消费的契约：
 * `clever-vpn-docs/docs/contracts/site-hosting.md` §4.5.4。
 */

export interface MigrationBundleFile {
  /** 文件名，如 `0000_init.sql`；排序即执行顺序，同时是 `d1_migrations.name` */
  name: string;
  /** 该文件 `sql` 的 sha256（hex）。对不上说明资产被替换过 */
  sha256: string;
  /** **执行单位**：归一化后的整文件原文，消费方一次 `/query` 提交一个 */
  sql: string;
  /** 语句条数，仅供审计，不参与执行 */
  statement_count: number;
}

export interface MigrationBundle {
  tag: string;
  /** 内容指纹，`sha256:<16hex>`；与 `slots.schema_version` 比较 */
  schema_version: string;
  generated_at: string;
  files: MigrationBundleFile[];
  statement_count: number;
}

/** 按 `--> statement-breakpoint` 拆语句；仅用于计数 */
export declare function splitStatements(sql: string): string[];

/** 剔掉事务控制语句；多段事务抛错 */
export declare function normalizeSql(sql: string, name?: string): string;

/** 纯函数：文件列表 → 资产对象 */
export declare function buildBundle(
  files: Array<{ name: string; sql: string }>,
  opts?: { tag?: string; now?: string },
): MigrationBundle;
