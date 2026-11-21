/**
 * 每个 test 文件跑一次：把生产迁移链 apply 到这份**隔离的**测试 D1 上。
 *
 * 存储隔离按 test 文件划分 —— 每个文件拿到一份全新的空库，所以 setup 必须建表。
 *
 * 测试跑的是 `MODE=single`（`wrangler.jsonc` 里没有 `MODE`），这条路径上 Worker 不会
 * 自迁移（门禁只在 multi 生效，见 `src/db/schema-guard.ts`），所以建表只能在这里做。
 * 门禁自己的行为（含"空库整条链一次补齐"）在 `schema-guard.test.ts` 里单独验。
 */
import { env as rawEnv } from "cloudflare:workers";
import { applyD1Migrations } from "cloudflare:test";

import type { D1Migration } from "cloudflare:test";
import type { Env } from "../../src/env";

/** 测试专用绑定（在 `vitest.workers.config.ts` 里注入） */
export type TestEnv = Env & { TEST_MIGRATIONS: D1Migration[] };

export const env = rawEnv as unknown as TestEnv;

await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
