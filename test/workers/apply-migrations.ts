/**
 * 每个 test 文件跑一次：把生产迁移链 apply 到这份**隔离的**测试 D1 上。
 *
 * 存储隔离按 test 文件划分 —— 每个文件拿到一份全新的空库，所以 setup 必须建表。
 * Worker 本身不做自迁移（见 `src/db.ts`），这里也不能指望它。
 */
import { env as rawEnv } from "cloudflare:workers";
import { applyD1Migrations } from "cloudflare:test";

import type { D1Migration } from "cloudflare:test";
import type { Env } from "../../src/env";

/** 测试专用绑定（在 `vitest.workers.config.ts` 里注入） */
export type TestEnv = Env & { TEST_MIGRATIONS: D1Migration[] };

export const env = rawEnv as unknown as TestEnv;

await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
