/**
 * 数据库就绪校验（**不执行迁移**）
 *
 * 迁移由 CI 执行：`.github/workflows/deploy.yml` 在 `wrangler deploy` 之前跑
 * `wrangler d1 migrations apply --remote`；本地开发跑 `npm run db:migrate:local`。
 *
 * 为什么不在 Worker 里自迁移：
 *   - 部署的唯一路径是 GitHub Actions，迁移放在那里才能"先迁移、再切流量"；
 *   - 冷启动跑 DDL 既慢又危险（一次超时就是半迁移状态）；
 *   - 迁移失败应该在 CI 里红叉，而不是等用户访问时才 500。
 *
 * 这里只做一次**只读探测**：核心表不存在 ⇒ 迁移没跑，给出能照做的报错。
 */

/** 核心表：只要它不存在，说明这个库根本没迁移过 */
const PROBE_TABLE = "admin_users";

/** isolate 级缓存：同一实例只探测一次 */
let ready: Promise<void> | null = null;

export function ensureSchema(db: D1Database): Promise<void> {
  if (!ready) {
    ready = probe(db).catch((e: unknown) => {
      ready = null; // 失败不缓存：迁移补上后不必等实例回收
      throw e;
    });
  }
  return ready;
}

async function probe(db: D1Database): Promise<void> {
  const row = await db
    .prepare(`SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?`)
    .bind(PROBE_TABLE)
    .first<{ name: string }>();

  if (row) return;

  throw new Error(
    `数据库未初始化：缺少表 ${PROBE_TABLE}。\n` +
      `  本地开发：npm run db:migrate:local\n` +
      `  线上部署：由 deploy 工作流自动执行（wrangler d1 migrations apply --remote）\n` +
      `  详见 docs/schema.md §4`,
  );
}

/** 仅测试用：重置 isolate 缓存 */
export function __resetSchemaCacheForTests(): void {
  ready = null;
}
