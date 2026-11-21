/**
 * 数据库就绪探测（**不执行迁移**）—— 兜底，不是门禁
 *
 * 迁移有两种执行者，取决于部署模式：
 *
 *   single（自部署，默认）—— CI 执行：`.github/workflows/deploy.yml` 在
 *     `wrangler deploy` 之前跑 `wrangler d1 migrations apply --remote`；本地开发跑
 *     `npm run db:migrate:local`。**先迁移、再切流量**，失败在 CI 里红叉。
 *
 *   multi（SaaS 分片）—— shard **自己**在租户第一次请求时按需执行
 *     （`src/db/schema-guard.ts`）：判据是租户库 `d1_migrations` 台账里的文件名集合
 *     与代码内嵌 bundle 是否相等，缺就 `batch` 原子补齐，多就 503。cf-api 不再执行
 *     租户 SQL。为什么不放在 CI：一个分片成百上千个库，逐库扫既慢又与"发布"耦合；
 *     每个库真正需要迁移的时刻就是它自己下一次被访问的时刻。
 *
 * 所以这里**只做一次只读探测**：核心表不存在 ⇒ 给出能照做的报错。
 * 它是兜底（比如 multi 下门禁已保证 schema，这里只是万一），不是迁移判据 ——
 * 判据只有一处：台账 + 内嵌文件名集合。
 */

/** 核心表：只要它不存在，说明这个库根本没迁移过 */
const PROBE_TABLE = "admin_users";

/**
 * 每个 D1 只探测一次。
 *
 * 必须按 `db` 而不是按 isolate 缓存：multi 下同一个 isolate 会服务很多租户库，
 * 用一个全局 `ready` 会把"第一个租户探测通过"当成所有租户的结论 ——
 * 那正好把要报的错吞掉。`WeakMap` 让绑定回收后条目自然消失。
 */
let ready: WeakMap<D1Database, Promise<void>> = new WeakMap();

export function ensureSchema(db: D1Database): Promise<void> {
  let probe$ = ready.get(db);
  if (!probe$) {
    probe$ = probe(db).catch((e: unknown) => {
      ready.delete(db); // 失败不缓存：迁移补上后不必等实例回收
      throw e;
    });
    ready.set(db, probe$);
  }
  return probe$;
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
      `  多租户分片：由 CRM 自己的门禁懒升级（见 src/db/schema-guard.ts）\n` +
      `  详见 docs/schema.md §4`,
  );
}

/** 仅测试用：重置探测缓存 */
export function __resetSchemaCacheForTests(): void {
  ready = new WeakMap();
}

