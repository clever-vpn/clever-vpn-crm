#!/usr/bin/env bash
# 本地 single 模式 CRM：Vite(5181) + wrangler dev(8788)，不启动 Caddy。
# 线上 cf-api 由 .dev.vars 的 CF_API_BASE + 设置页 token 决定。
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT"

WEB_LOG="/tmp/crm-single-web.log"
WORKER_LOG="/tmp/crm-single-worker.log"
WEB_PID=""
WORKER_PID=""

cleanup() {
  if [[ -n "$WEB_PID" ]] && kill -0 "$WEB_PID" 2>/dev/null; then
    kill "$WEB_PID" 2>/dev/null || true
  fi
  if [[ -n "$WORKER_PID" ]] && kill -0 "$WORKER_PID" 2>/dev/null; then
    kill "$WORKER_PID" 2>/dev/null || true
  fi
  wait 2>/dev/null || true
}
trap cleanup EXIT INT TERM

fail() {
  echo "✘ $*" >&2
  exit 1
}

[[ -d node_modules ]] || fail "缺 node_modules：先 npm install"
[[ -f .dev.vars ]] || fail "缺 .dev.vars：按 docs/local-dev-single.md §1 配好"
[[ -x node_modules/.bin/wrangler ]] || fail "缺 wrangler：npm install"
[[ -x node_modules/.bin/vite ]] || fail "缺 vite：npm install"

if grep -q '^CF_API_BASE=http://127.0.0.1:8899' .dev.vars 2>/dev/null; then
  echo "⚠️ .dev.vars 里 CF_API_BASE 还是 fake（127.0.0.1:8899）"
  echo "   要接线上 cf-api，请改成 https://api.clever-vpn.org"
fi
if ! grep -q '^APP_SECRET=..' .dev.vars 2>/dev/null; then
  echo "⚠️ .dev.vars 里没有 APP_SECRET：无法加密保存 cf-api token"
fi

for port in 5181 8788; do
  if lsof -nP -iTCP:"$port" -sTCP:LISTEN >/dev/null 2>&1; then
    fail "端口 $port 已被占用，先停掉旧进程"
  fi
done

if [[ ! -d web/dist/admin ]]; then
  echo "→ web/dist 不存在，先构建一次前端…"
  npm run build:web
fi

echo "→ 启动 Vite（5181）…"
npm run dev:web >"$WEB_LOG" 2>&1 &
WEB_PID=$!

# AI 配置助手：默认连线上网关 studio（与 site-studio 一致，wrangler dev 用本机登录身份）。
# 想分开开发期的账/日志：CLOUDFLARE_GATEWAY_ID=studio-dev npm run dev:local；
# 设空 = 关闭 AI（面板显示未配置）。AI binding 没有本地模拟，未 `wrangler login` 时
# wrangler dev 会直接报错，见 docs/local-dev-single.md §5。
GATEWAY="${CLOUDFLARE_GATEWAY_ID-studio}"
MODEL="${CLOUDFLARE_AI_MODEL-}"
echo "→ 启动 CRM Worker（8788，AI 网关=${GATEWAY:-关闭}，模型=${MODEL:-deepseek/deepseek-flash}）…"
./node_modules/.bin/wrangler dev --port 8788   --var "CLOUDFLARE_GATEWAY_ID:${GATEWAY}"   --var "CLOUDFLARE_AI_MODEL:${MODEL}" >"$WORKER_LOG" 2>&1 &
WORKER_PID=$!

ready() {
  local url=$1
  for _ in $(seq 1 40); do
    if curl -fsS --max-time 2 "$url" >/dev/null 2>&1; then
      return 0
    fi
    sleep 1
  done
  return 1
}

if ! ready "http://127.0.0.1:8788/__version"; then
  echo "✘ Worker 没起来，最近日志：" >&2
  tail -30 "$WORKER_LOG" >&2 || true
  exit 1
fi
if ! ready "http://localhost:5181/admin/"; then
  echo "✘ Vite 没起来，最近日志：" >&2
  tail -30 "$WEB_LOG" >&2 || true
  exit 1
fi

cat <<TXT

✔ 本地 CRM 已启动

后台: http://localhost:5181/admin/
接口: http://127.0.0.1:8788

首次使用：
  npm run db:reset   # 如果还没初始化本地库
  Settings → cf-api 对接 → https://api.clever-vpn.org + tenant token

日志：
  $WEB_LOG
  $WORKER_LOG

Ctrl+C 停止
TXT

# 任意一个退出就停另一个（macOS 的 bash 没有 wait -n）
while kill -0 "$WEB_PID" 2>/dev/null && kill -0 "$WORKER_PID" 2>/dev/null; do
  sleep 1
done
echo "✘ 有进程退出，查看日志：$WEB_LOG / $WORKER_LOG" >&2
exit 1
