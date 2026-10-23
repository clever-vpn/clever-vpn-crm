#!/usr/bin/env bash
# 重建本地 D1（dev）。参照 cf-api `scripts/reset-db.sh`。
#
# 两套迁移目录：
#   migrations/       生产链 —— drizzle-kit 追加式历史，**入库**，由 deploy 工作流
#                     用 `wrangler d1 migrations apply --remote` 应用（见 docs/schema.md）。
#   migrations-dev/   开发链 —— **gitignore 的产物**，每次 reset 重建：
#                      0000_schema.sql  从 src/db/schema.ts 全量生成（勿手改）
#                      0001_seed.sql    dev 种子（本脚本 dev_seed() 维护）
#                     开发时想重置就重置，不用维护"第 N 个增量"。
#
# 模式：
#   reset-db.sh          # 默认：停 dev → 清本地 D1 → 重建 dev 链 → apply
#   reset-db.sh --apply  # 只重建 dev 链 → apply（不清库）
#   reset-db.sh --ddl    # 只把全量 DDL 打到 stdout（排查用，不写文件不碰库）
#
# 用法：npm run db:reset，然后重新 npm run dev。
set -euo pipefail
cd "$(dirname "$0")/.."

D1_NAME="clever-vpn-crm"
DEV_DIR="migrations-dev"
SCHEMA_FILE="$DEV_DIR/0000_schema.sql"
SEED_FILE="$DEV_DIR/0001_seed.sql"
TMP_CONFIG=".wrangler/drizzle-dev.config.ts"
TMP_OUT=".wrangler/ddl-dev"
WRANGLER="./node_modules/.bin/wrangler"
DRIZZLE="./node_modules/.bin/drizzle-kit"

MODE="reset"
case "${1:-}" in
  "" | reset) MODE="reset" ;;
  --apply) MODE="apply" ;;
  --ddl) MODE="ddl" ;;
  *) echo "用法: $0 [reset|--apply|--ddl]" >&2; exit 2 ;;
esac

# ---- dev 种子（与生产链完全独立；要更多测试数据直接在这里追加）--------------
dev_seed() {
  cat <<'SQL'
-- ================================================================
-- dev 种子（在 scripts/reset-db.sh 的 dev_seed() 中维护，勿手改此产物）
-- 管理员：ops@example.com / crm-admin-2026
-- ================================================================

INSERT OR IGNORE INTO admin_users
  (email, password_hash, totp_enabled, created_at, updated_at)
VALUES
  ('ops@example.com',
   'pbkdf2$sha256$50000$Y2xldmVydnBuLWRldi1zYQ$pNN_GLa4DQySXqMVpf9UB8ETxhsV6Z64uKaqiB190Mo',
   0,
   strftime('%Y-%m-%dT%H:%M:%fZ','now'),
   strftime('%Y-%m-%dT%H:%M:%fZ','now'));

-- 套餐：周期 / 流量 / 加量 + 一个礼品包（price=0 且 hidden）
INSERT OR IGNORE INTO plans
  (id, name, kind, price_minor, currency, licence_limit, term_days, monthly_quota_gb,
   traffic_gb, validity_days, allow_addons, line_ids, sort_order, status, visibility,
   created_at, updated_at)
VALUES
  ('dev_period_100g',  '月付 · 100GB · 1 设备', 'period',  1500, 'CNY', 1, 30, 100, NULL, NULL, 1, '[]', 10, 'active', 'public',
   strftime('%Y-%m-%dT%H:%M:%fZ','now'), strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  ('dev_traffic_500g','流量包 · 500GB',        'traffic', 5000, 'CNY', 1, NULL, NULL, 500, 365,  0, '[]', 20, 'active', 'public',
   strftime('%Y-%m-%dT%H:%M:%fZ','now'), strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  ('dev_addon_50g',    '加量包 · 50GB',        'addon',    800, 'CNY', 1, NULL, NULL,  50, NULL, 0, '[]', 30, 'active', 'public',
   strftime('%Y-%m-%dT%H:%M:%fZ','now'), strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  ('dev_gift_20g',     '赠送 · 20GB（礼品包）', 'addon',      0, 'CNY', 1, NULL, NULL,  20, NULL, 0, '[]', 90, 'active', 'hidden',
   strftime('%Y-%m-%dT%H:%M:%fZ','now'), strftime('%Y-%m-%dT%H:%M:%fZ','now'));

-- 客户（cf_customer_id 留空：本地还没绑定 cf-api 行的场景）
INSERT OR IGNORE INTO customers (email, status, created_at) VALUES
  ('alice@example.com', 'active', strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  ('bob@example.com',   'active', strftime('%Y-%m-%dT%H:%M:%fZ','now'));

-- 一笔已支付的周期订阅（alice）
INSERT INTO platform_subscriptions
  (customer_id, plan_id, kind, status, paid_minor, currency, licence_limit, term_days,
   quota_gb, started_at, expires_at, anchor_day, balance_gb, last_settled_at,
   created_at, updated_at)
SELECT c.id, 'dev_period_100g', 'period', 'active', 1500, 'CNY', 1, 30,
       100, strftime('%Y-%m-%dT%H:%M:%fZ','now'),
       strftime('%Y-%m-%dT%H:%M:%fZ','now','+30 days'), 23, 0,
       strftime('%Y-%m-%dT%H:%M:%fZ','now'),
       strftime('%Y-%m-%dT%H:%M:%fZ','now'), strftime('%Y-%m-%dT%H:%M:%fZ','now')
FROM customers c
WHERE c.email = 'alice@example.com'
  AND NOT EXISTS (SELECT 1 FROM platform_subscriptions s WHERE s.customer_id = c.id);

-- 两张订单：一张自助购买、一张 0 元赠单（给 UI 开发用）
INSERT INTO orders
  (code, customer_id, plan_id, kind, plan_snapshot, amount_minor, currency, source,
   channel, status, paid_at, created_at, updated_at)
SELECT 'ORD-DEV-0001', c.id, 'dev_period_100g', 'period',
       '{"name":"月付 · 100GB · 1 设备","kind":"period","price_minor":1500,"quota_gb":100,"term_days":30}',
       1500, 'CNY', 'purchase', 'manual', 'paid',
       strftime('%Y-%m-%dT%H:%M:%fZ','now'),
       strftime('%Y-%m-%dT%H:%M:%fZ','now'), strftime('%Y-%m-%dT%H:%M:%fZ','now')
FROM customers c WHERE c.email = 'alice@example.com'
  AND NOT EXISTS (SELECT 1 FROM orders o WHERE o.code = 'ORD-DEV-0001');

INSERT INTO orders
  (code, customer_id, plan_id, kind, plan_snapshot, amount_minor, currency, source,
   channel, status, paid_at, operator, note, created_at, updated_at)
SELECT 'ORD-DEV-0002', c.id, 'dev_gift_20g', 'addon',
       '{"name":"赠送 · 20GB（礼品包）","kind":"addon","price_minor":0,"traffic_gb":20}',
       0, 'CNY', 'gift', 'gift', 'paid',
       strftime('%Y-%m-%dT%H:%M:%fZ','now'), 'ops@example.com', 'dev 种子：赠送 20GB',
       strftime('%Y-%m-%dT%H:%M:%fZ','now'), strftime('%Y-%m-%dT%H:%M:%fZ','now')
FROM customers c WHERE c.email = 'bob@example.com'
  AND NOT EXISTS (SELECT 1 FROM orders o WHERE o.code = 'ORD-DEV-0002');
SQL
}

# ---- 从 schema.ts 生成全量 DDL（临时配置 → 临时目录，不碰 migrations/ 快照）----
gen_schema() {
  mkdir -p .wrangler
  cat > "$TMP_CONFIG" <<EOF
import { defineConfig } from "drizzle-kit";
export default defineConfig({
  dialect: "sqlite",
  schema: "$PWD/src/db/schema.ts",
  out: "$PWD/$TMP_OUT",
});
EOF
  rm -rf "$TMP_OUT"
  if ! "$DRIZZLE" generate --config "$TMP_CONFIG" >/dev/null 2>&1; then
    echo "drizzle-kit generate 失败" >&2
    rm -f "$TMP_CONFIG"; rm -rf "$TMP_OUT"
    exit 1
  fi
  local sql_file
  sql_file="$(ls "$TMP_OUT"/0000_*.sql 2>/dev/null | head -1 || true)"
  if [ -z "$sql_file" ]; then
    echo "未找到生成的迁移文件" >&2
    rm -f "$TMP_CONFIG"; rm -rf "$TMP_OUT"
    exit 1
  fi
  sed -E 's/[[:space:]]*--> statement-breakpoint//' "$sql_file"
  rm -f "$TMP_CONFIG"; rm -rf "$TMP_OUT"
}

if [ "$MODE" = "ddl" ]; then
  echo "-- 全量 DDL（由 drizzle-kit 从 src/db/schema.ts 生成，$(date -u +%Y-%m-%dT%H:%M:%SZ)）"
  gen_schema
  exit 0
fi

if [ "$MODE" = "reset" ]; then
  echo "==> 停止 dev server（如有）"
  pkill -f "wrangler dev --port 8788" 2>/dev/null || true
  sleep 1
  echo "==> 删除本地 D1 状态（仅 dev）"
  rm -rf .wrangler/state/v3/d1
fi

echo "==> 重建 dev 迁移链（${SCHEMA_FILE} + ${SEED_FILE}）"
# 整目录重建：避免残留旧文件被 wrangler 当成迁移重复建表
rm -rf "$DEV_DIR"
mkdir -p "$DEV_DIR"
{
  printf '%s\n\n' "-- dev 全量 schema（自动生成，勿手改；src/db/schema.ts 是唯一事实来源）"
  gen_schema
} > "$SCHEMA_FILE"
dev_seed > "$SEED_FILE"

echo "==> 应用 dev 迁移链"
"$WRANGLER" d1 migrations apply "$D1_NAME" --local

echo "==> 完成。管理员：ops@example.com / crm-admin-2026；重新 npm run dev 即可。"
