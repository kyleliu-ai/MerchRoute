#!/bin/bash
set -euo pipefail
cd "$(dirname "$0")/.."

RUNTIME_ENV_FILE="${MERCHROUTE_ENV_FILE:-${MERCHROUTE_RUNTIME_ENV_FILE:-$(pwd)/.env.runtime}}"
export MERCHROUTE_ENV_FILE="$RUNTIME_ENV_FILE"
for runtime_variable in MERCHROUTE_RUNTIME_KEY MERCHROUTE_CREDENTIAL_ENCRYPTION_KEY; do
  if [[ -z "${!runtime_variable:-}" && -f "$RUNTIME_ENV_FILE" ]]; then
    runtime_line="$(grep -m 1 "^${runtime_variable}=" "$RUNTIME_ENV_FILE" || true)"
    runtime_value="${runtime_line#*=}"
    if [[ "$runtime_line" == *=* && -n "$runtime_value" ]]; then
      export "$runtime_variable=$runtime_value"
    fi
  fi
  if [[ -z "${!runtime_variable:-}" ]]; then
    echo "缺少 $runtime_variable。请设置环境变量，或写入 $RUNTIME_ENV_FILE。"
    read -r -p "按 Enter 退出"
    exit 1
  fi
done

# Optional fail-closed capability. It is loaded only after the controlled OZON
# multistore fleet deployment; an absent value intentionally leaves publishing
# disabled.
fleet_capability_variable="MERCHROUTE_OZON_MULTISTORE_FLEET_READY"
if [[ -z "${!fleet_capability_variable:-}" && -f "$RUNTIME_ENV_FILE" ]]; then
  fleet_capability_line="$(grep -m 1 "^${fleet_capability_variable}=" "$RUNTIME_ENV_FILE" || true)"
  fleet_capability_value="${fleet_capability_line#*=}"
  if [[ "$fleet_capability_line" == *=* && -n "$fleet_capability_value" ]]; then
    export "$fleet_capability_variable=$fleet_capability_value"
  fi
fi
if [[ -n "${!fleet_capability_variable:-}" && ! "${!fleet_capability_variable}" =~ ^(1|true|yes|on|0|false|no|off)$ ]]; then
  echo "$fleet_capability_variable 必须是布尔值。"
  read -r -p "按 Enter 退出"
  exit 1
fi

runtime_file_value() { grep -m 1 "^$1=" "$RUNTIME_ENV_FILE" 2>/dev/null | cut -d= -f2- || true; }
MERCHROUTE_PORT="${MERCHROUTE_PORT:-${PORT:-$(runtime_file_value MERCHROUTE_PORT)}}"
MERCHROUTE_PORT="${MERCHROUTE_PORT:-$(runtime_file_value PORT)}"
MERCHROUTE_PORT="${MERCHROUTE_PORT:-43173}"
if [[ ! "$MERCHROUTE_PORT" =~ ^[0-9]+$ ]] || (( MERCHROUTE_PORT < 1024 || MERCHROUTE_PORT > 49151 )); then echo 'MERCHROUTE_PORT 必须是 1024–49151 的整数'; exit 1; fi
case "$MERCHROUTE_PORT" in 4183|4184|5173|5432|5678|8000) echo 'MERCHROUTE_PORT 与依赖或隔离端口冲突'; exit 1;; esac
MERCHROUTE_RUNTIME_BASE_URL="${MERCHROUTE_RUNTIME_BASE_URL:-$(runtime_file_value MERCHROUTE_RUNTIME_BASE_URL)}"
expected_origin="http://127.0.0.1:${MERCHROUTE_PORT}"
if [[ -n "$MERCHROUTE_RUNTIME_BASE_URL" && "${MERCHROUTE_RUNTIME_BASE_URL%/}" != "$expected_origin" ]]; then echo 'MERCHROUTE_RUNTIME_BASE_URL 与 MERCHROUTE_PORT 不一致'; exit 1; fi
export HOST=127.0.0.1 PORT="$MERCHROUTE_PORT" MERCHROUTE_PORT MERCHROUTE_RUNTIME_BASE_URL="$expected_origin"

if ! command -v node >/dev/null 2>&1; then
  echo "未检测到 Node.js。请安装 Node.js 22.23.1。"
  read -r -p "按 Enter 退出"
  exit 1
fi

NODE_VERSION="$(node -p 'process.versions.node')"
if [[ "$NODE_VERSION" != "22.23.1" ]]; then
  echo "当前 Node.js 为 $(node -v)，本项目固定使用 Node.js 22.23.1。"
  read -r -p "按 Enter 退出"
  exit 1
fi

NPM_VERSION="$(npm --version)"
if [[ "$NPM_VERSION" != "10.9.8" ]]; then
  echo "当前 npm 为 $NPM_VERSION，本项目固定使用 npm 10.9.8。"
  read -r -p "按 Enter 退出"
  exit 1
fi

if [[ ! -d node_modules ]]; then
  echo "尚未安装依赖，请先执行 npm ci。"
  read -r -p "按 Enter 退出"
  exit 1
fi

if lsof -nP -iTCP:"$MERCHROUTE_PORT" -sTCP:LISTEN >/dev/null 2>&1; then echo "端口 $MERCHROUTE_PORT 已被占用，禁止自动漂移"; exit 1; fi
node -e "const n=require('net'),s=n.createServer();s.once('error',e=>{console.error(e.code);process.exit(1)});s.listen({host:'127.0.0.1',port:Number(process.env.MERCHROUTE_PORT),exclusive:true},()=>s.close())"

if [[ ! -f apps/server/dist/index.js ]]; then
  npm run build
fi

(sleep 2 && open "$expected_origin") &
npm start
