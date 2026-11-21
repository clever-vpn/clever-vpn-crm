/**
 * 租户库的 schema 门禁：**懒升级** + 领先拒绝（多租户分片专用）
 *
 * 一句话：请求进来先确认"这个租户库的 `d1_migrations` 台账 = 这份代码内嵌的
 * 迁移文件名集合"，缺的就地补（`batch` 原子），多的直接拒绝服务。
 *
 * 为什么执行位置在 Worker（而不是 cf-api / CI）：
 *   - 分片里成百上千个租户库，CI 逐库扫一遍既慢又与"发布"耦合；而每个库真正需要
 *     迁移的时刻，就是**它自己**下一次被访问的时刻；
 *   - 写这个库的绑定（`DB_<slot>`）只在这个 shard 里，执行者与数据面在同一个
 *     Worker 里，不需要第二套云凭证、也不会有"执行到一半网络断了"的跨服务窗口。
 *
 * 三条不能让步的规则：
 *   1. **判据是文件名集合**，不是 release tag / `schema_version` / 日期。发版但不改
 *      迁移时集合不变 ⇒ 零动作；tag 每次都变，拿它判会天天"落后"。
 *   2. **一个文件 = 一次 `batch`**，DDL 与该文件的台账 INSERT **同批**提交。
 *      理由有两条，都不依赖"`exec` 恰好表现得像事务"这种没被承诺的事：
 *      ① D1 文档明确承诺 `batch` 内的语句是**一个 SQL 事务**（任一失败回滚整个序列），
 *         而对 `exec()` 只承诺"出错即停"，**没有回滚承诺**；
 *      ② 台账 INSERT 要绑参数（文件名），`exec()` 不支持参数绑定，只能拼字符串。
 *      真正把"跑了一半"变成不可能的，是 ①＋② 同时满足 —— 全项目只有 `batch` 一处。
 *   3. **库比代码新就 503**，不猜兼容、不回滚 schema。旧 isolate 在新代码迁移后
 *      短暂看到"领先"是预期的，下次部署/回收即自愈。
 *   4. **先确认"这个库是不是它该服务的那个"**：比对库内 `d1_identity` 与 KV 期望的
 *      `d1_uuid`，不一致就 503 `db_binding_mismatch` —— 绑定指错库时宁可不服务，
 *      也不能读到别的租户的数据。身份读与台账读放在同一个 `batch` 里，冷路径只多一次
 *      探针、不多一次往返。
 *
 * 门禁只在 `MODE=multi` 生效：自部署（single）由 CI 在部署前
 * `wrangler d1 migrations apply --remote`，行为不变（见 `src/db.ts`）。
 *
 * 契约：`cf-api-hosting` §4.5.4（台账协议）、`registry-schema` §4.5.4；
 * 决策记录：`clever-vpn-docs/docs/adr/0007-tenant-migration-execution.md`。
 */
import { EXPECTED_NAMES, MIGRATION_BUNDLE } from "./migrations.generated";
import type { EmbeddedMigrationFile } from "./migrations.generated";

/**
 * 台账 DDL —— **必须与 wrangler / cf-api 的逐字节相同**（表名双引号、两个 tab 缩进）。
 *
 * 改一个字，`sqlite_master` 就开始与 wrangler 建的库不一致：以后有人拿
 * `wrangler d1 migrations apply` 接手同一个库时，会认不出这张表而重跑整条链。
 * 注意：cf-api 侧的执行器已退役（ADR 0007 Phase 2），台账现在只由 shard 与 wrangler 维护。
 */
const LEDGER_TABLE = "d1_migrations";
const LEDGER_DDL = `CREATE TABLE IF NOT EXISTS "d1_migrations"(
\t\tid         INTEGER PRIMARY KEY AUTOINCREMENT,
\t\tname       TEXT UNIQUE,
\t\tapplied_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP NOT NULL
);`;

/** 对齐成功后 30 分钟内不再读台账/身份（热路径零 I/O）。绑定变更只在 PATCH/部署时发生 */
const OK_TTL_MS = 30 * 60_000;
/** 领先只缓存 30 s：运维把库改回去/重新开通后，不该再等 5 分钟才恢复 */
const AHEAD_TTL_MS = 30_000;
/** 身份不一致只缓存 60 s：重绑（reconcile）后应尽快恢复，而不是等半小时 */
const MISMATCH_TTL_MS = 60_000;

/** 库内身份表：cf-api 建库时写入，运行期用它自检"这个 DB_<slot> 指向的库对不对" */
const IDENTITY_TABLE = "d1_identity";

interface MemoEntry {
  ok: boolean;
  at: number;
  /** 失败时的完整错误：TTL 内重复请求也拿到同一条能照做的信息 */
  error?: SchemaGateError;
  /** 失败结论的缓存时长（按错误类型区分） */
  badTtlMs?: number;
}

/** per-slot 结论缓存。slot 在 `scopeToTenant` 里解析出来，与 `DB_<slot>` 一一对应 */
const memo = new Map<number, MemoEntry>();
/** per-slot 单飞：同一 isolate 内并发请求只跑一次检查/迁移 */
const inflight = new Map<number, Promise<void>>();

/**
 * 门禁失败：带一个**能直接当接口错误码**的 code。
 *
 * `schema_ahead`          库里有这份代码不认识的迁移（比代码新）——拒绝服务，等新代码；
 * `schema_migration_failed` 补迁移失败，批次已回滚、台账未记 —— 下次请求重试；
 * `db_binding_mismatch`   这个 `DB_<slot>` 指向的库不是它该服务的那个（库内身份 ≠ KV 期望）。
 */
export class SchemaGateError extends Error {
  constructor(
    readonly code: "schema_ahead" | "schema_migration_failed" | "db_binding_mismatch",
    message: string,
  ) {
    super(message);
    this.name = "SchemaGateError";
  }
}

/**
 * 门禁入口：保证 `db` 的 schema 与这份代码对齐，并做**库身份自检**。
 *
 * `expectedD1Uuid` 来自 KV（`HostMap.d1_uuid`，cf-api 写）。给了就必须与库内
 * `d1_identity` 一致；不一致说明绑定指错了库 ⇒ 拒绝服务（宁可 503 也不读别人的数据）。
 *
 * 热路径（30 分钟内判过 OK）：一次 `Map.get`，零 I/O。
 * 冷路径：一次探针（两张表在不在）→ 台账 + 身份**同一次 batch** → 缺则逐文件 `batch`。
 */
export async function ensureTenantSchema(
  db: D1Database,
  slot: number,
  expectedD1Uuid?: string,
): Promise<void> {
  const hit = memo.get(slot);
  if (hit) {
    if (hit.ok) {
      if (Date.now() - hit.at < OK_TTL_MS) return;
    } else if (hit.error && Date.now() - hit.at < (hit.badTtlMs ?? AHEAD_TTL_MS)) {
      throw hit.error;
    }
  }

  let running = inflight.get(slot);
  if (!running) {
    running = checkAndMigrate(db, slot, expectedD1Uuid).finally(() => inflight.delete(slot));
    inflight.set(slot, running);
  }
  await running;
}

async function checkAndMigrate(
  db: D1Database,
  slot: number,
  expectedD1Uuid?: string,
): Promise<void> {
  // ① 一次探针：台账表与身份表是否存在（一条 SELECT，永不因缺表报错）
  const probe = await db
    .prepare(
      `SELECT
         (SELECT name FROM sqlite_master WHERE type='table' AND name = ?) AS ledger,
         (SELECT name FROM sqlite_master WHERE type='table' AND name = ?) AS identity`,
    )
    .bind(LEDGER_TABLE, IDENTITY_TABLE)
    .first<{ ledger: string | null; identity: string | null }>();
  const hasLedger = probe?.ledger === LEDGER_TABLE;
  const hasIdentity = probe?.identity === IDENTITY_TABLE;

  let applied: Set<string>;
  let actual: string | null = null;

  if (hasLedger && hasIdentity) {
    // ② 台账 + 身份放同一个 batch：冷路径少一次往返
    const results = await db.batch([
      db.prepare(`SELECT "name" FROM "${LEDGER_TABLE}" ORDER BY "id"`),
      db.prepare(`SELECT d1_uuid FROM ${IDENTITY_TABLE} LIMIT 1`),
    ]);
    const ledgerRows = ((results[0]?.results ?? []) as { name: unknown }[]).map((r) => String(r.name));
    const identityRows = (results[1]?.results ?? []) as { d1_uuid?: unknown }[];
    applied = new Set(ledgerRows);
    actual = identityRows[0]?.d1_uuid != null ? String(identityRows[0].d1_uuid) : null;
  } else if (hasLedger) {
    applied = await ledgerNames(db);
  } else {
    await db.prepare(LEDGER_DDL).run();
    applied = new Set();
  }

  if (!(hasLedger && hasIdentity) && hasIdentity) {
    try {
      const row = await db
        .prepare(`SELECT d1_uuid FROM ${IDENTITY_TABLE} LIMIT 1`)
        .first<{ d1_uuid: string }>();
      actual = row?.d1_uuid ?? null;
    } catch {
      actual = null;
    }
  }

  // ③ 身份比对放在迁移之前：库都不对，就不要在里面建表/写数据
  if (expectedD1Uuid && actual !== expectedD1Uuid) {
    const error = new SchemaGateError(
      "db_binding_mismatch",
      `DB_${slot} 指向的库不是它该服务的那个（期望 ${expectedD1Uuid}，库内 ${actual ?? "未知"}）——` +
        `请对该片跑 reconcile 重绑`,
    );
    memo.set(slot, { ok: false, at: Date.now(), error, badTtlMs: MISMATCH_TTL_MS });
    throw error;
  }

  /**
   * 领先判定：台账里有**这份代码不认识**的名字。
   *
   * 这是"库比代码新"的可靠信号 —— 例如滚动部署期间旧 isolate 遇到刚迁移过的库，
   * 或者有人手工往租户库塞了迁移。此时绝不能继续跑（真跑下去就是 `CREATE TABLE`
   * 撞表 / 写坏数据），也绝不猜"多出来的应该兼容"。
   */
  const ahead = [...applied].filter((name) => !EXPECTED_NAMES.has(name));
  if (ahead.length > 0) {
    const error = new SchemaGateError(
      "schema_ahead",
      `租户库（slot=${slot}）里有这份代码不认识的迁移：${ahead.join(", ")}` +
        `（代码内嵌 ${MIGRATION_BUNDLE.schemaVersion}）。拒绝服务，等新代码部署或重新开通该租户`,
    );
    memo.set(slot, { ok: false, at: Date.now(), error });
    throw error;
  }

  // 按文件名升序执行：文件名是零填充 ASCII，**不用 localeCompare**（它会随语言环境变序）
  const missing = MIGRATION_BUNDLE.files
    .filter((file) => !applied.has(file.name))
    .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));

  for (const file of missing) {
    await applyFile(db, file);
  }
  if (missing.length > 0) {
    console.log(
      `[schema] slot=${slot} 懒升级完成（${MIGRATION_BUNDLE.schemaVersion}）：` +
        missing.map((file) => file.name).join(", "),
    );
  }

  memo.set(slot, { ok: true, at: Date.now() });
}

/**
 * 应用一个文件：**DDL + 台账 INSERT 同一次 `batch`**。
 *
 * 这是 Worker 侧唯一能把「多语句 + 带参数的台账 INSERT」放进同一个事务的原语
 * （见文件头规则 2）。因此失败时整文件回滚、台账不变，重试从同一个文件再来 ——
 * 不存在"记了账却没跑完"或"跑了一半"的中间态。
 */
async function applyFile(db: D1Database, file: EmbeddedMigrationFile): Promise<void> {
  const statements = [
    ...file.statements.map((sql) => db.prepare(sql)),
    db.prepare(`INSERT INTO "${LEDGER_TABLE}" ("name") VALUES (?)`).bind(file.name),
  ];

  try {
    await db.batch(statements);
    return;
  } catch (error) {
    /**
     * 跨 isolate 的竞争：同片两个 isolate 可能同时发现"缺这个文件"，各自 `batch`。
     * 赢的家记上了账，输的家看到"表已存在" —— 那是**成功**，不是失败。
     * 所以失败后重读一次台账再定性（只有失败路径多这一次读）。
     */
    const now = await ledgerNames(db).catch(() => null);
    if (now?.has(file.name)) return;

    throw new SchemaGateError(
      "schema_migration_failed",
      `迁移 ${file.name}（sha256:${file.sha256.slice(0, 12)}）失败，整批已回滚、台账未记：` +
        `${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

/**
 * 读台账里的文件名集合；表还不存在就建空台账并返回空集。
 *
 * 空库有两种正常来源：池里刚建出来的库、按计划清空重开的库（压基线之前留下的旧台账
 * 一律重开，不写兼容补丁）。两者都该"从第一个文件开始跑"，不是错误。
 */
async function ledgerNames(db: D1Database): Promise<Set<string>> {
  const exists = await db
    .prepare(`SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?`)
    .bind(LEDGER_TABLE)
    .first<{ name: string }>();
  if (!exists) {
    await db.prepare(LEDGER_DDL).run();
    return new Set();
  }

  const { results } = await db
    .prepare(`SELECT "name" FROM "${LEDGER_TABLE}" ORDER BY "id"`)
    .all<{ name: string }>();
  return new Set(results.map((row) => String(row.name)));
}

/** 仅供测试：清掉 per-slot 缓存与单飞 */
export function __resetSchemaGuardForTests(): void {
  memo.clear();
  inflight.clear();
}
