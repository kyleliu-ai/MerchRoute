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

if [[ ! -f apps/server/dist/index.js ]]; then
  npm run build
fi

(sleep 2 && open "http://127.0.0.1:4173") &
npm start
