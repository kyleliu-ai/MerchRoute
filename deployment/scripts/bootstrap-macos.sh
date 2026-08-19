#!/bin/bash
set -euo pipefail

PROJECT_ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
cd "$PROJECT_ROOT"
APP_HOME="${MERCHROUTE_APP_HOME:-$HOME/Library/Application Support/MerchRoute}"
export MERCHROUTE_APP_HOME="$APP_HOME"
DATA_ROOT="${MERCHROUTE_DATA_ROOT:-}"
DRY_RUN="${MERCHROUTE_DEPLOY_DRY_RUN:-0}"

if [[ "$DRY_RUN" == '1' ]]; then
  command -v node >/dev/null 2>&1 || { echo 'Dry-run requires an existing Node.js command.' >&2; exit 1; }
  node deployment/scripts/bootstrap.mjs prepare "--app-home=$APP_HOME" --dry-run
  node deployment/scripts/preflight.mjs --dry-run
  exit 0
fi

if ! command -v brew >/dev/null 2>&1; then
  /bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"
  if [[ -x /opt/homebrew/bin/brew ]]; then eval "$(/opt/homebrew/bin/brew shellenv)"; fi
fi
brew install git nvm ffmpeg
[[ -d /Applications/Docker.app ]] || brew install --cask docker
[[ -d '/Applications/Google Chrome.app' ]] || brew install --cask google-chrome
mkdir -p "$HOME/.nvm"
export NVM_DIR="$HOME/.nvm"
source "$(brew --prefix nvm)/nvm.sh"
nvm install 22.23.1
nvm use 22.23.1
npm install --global npm@10.9.8
[[ "$(node -p 'process.versions.node')" == '22.23.1' ]]
[[ "$(npm --version)" == '10.9.8' ]]
node deployment/scripts/preflight.mjs
npm install --global n8n@2.32.6
[[ "$(n8n --version)" == '2.32.6' ]]

PREPARE_ARGS=(deployment/scripts/bootstrap.mjs prepare "--app-home=$APP_HOME")
[[ -n "$DATA_ROOT" ]] && PREPARE_ARGS+=("--data-root=$DATA_ROOT")
node "${PREPARE_ARGS[@]}"

N8N_NODES="$APP_HOME/n8n/.n8n/nodes"
mkdir -p "$N8N_NODES"
npm install --prefix "$N8N_NODES" n8n-nodes-globals@1.1.0
npm ci --prefix "$APP_HOME/n8n-runtime/scripts"
node deployment/scripts/bootstrap.mjs browser-profiles "--app-home=$APP_HOME"
node deployment/scripts/bootstrap.mjs verify-browser-profiles "--app-home=$APP_HOME"

if ! docker info >/dev/null 2>&1; then open -a Docker; fi
for _ in {1..60}; do docker info >/dev/null 2>&1 && break; sleep 5; done
docker info >/dev/null

DEPLOYMENT_ENV="$APP_HOME/secrets/deployment.env"
docker compose --env-file "$DEPLOYMENT_ENV" -f deployment/postgres/compose.yaml up -d
docker compose -f integrations/jimeng-free-api-all/compose.yaml up -d --build
npm ci
npm run build

mkdir -p "$APP_HOME/logs"
nohup node deployment/scripts/start-merchroute.mjs >"$APP_HOME/logs/merchroute.out.log" 2>"$APP_HOME/logs/merchroute.err.log" &
nohup node deployment/scripts/start-n8n.mjs >"$APP_HOME/logs/n8n.out.log" 2>"$APP_HOME/logs/n8n.err.log" &

for health in http://127.0.0.1:4173/api/v1/health http://127.0.0.1:5678/healthz http://127.0.0.1:8000/ping; do
  ready=0
  for _ in {1..60}; do curl -fsS "$health" >/dev/null && { ready=1; break; }; sleep 3; done
  [[ "$ready" == '1' ]] || { echo "Health check failed: $health" >&2; exit 1; }
done

node deployment/scripts/bootstrap.mjs configure-merchroute "--app-home=$APP_HOME"

open http://127.0.0.1:5678
read -r -p 'Complete the local n8n owner setup, then press Enter: '
CREDENTIAL_FILE="$APP_HOME/secrets/credentials.local.json"
open -e "$CREDENTIAL_FILE"
read -r -p 'Save the credential file and close TextEdit, then press Enter: '
node deployment/scripts/bootstrap.mjs import-n8n "--app-home=$APP_HOME"
node deployment/scripts/bootstrap.mjs probe "--app-home=$APP_HOME" --allow-network-probes=true
node deployment/scripts/bootstrap.mjs verify "--app-home=$APP_HOME"
echo 'MerchRoute deployment completed. All 36 n8n workflows remain inactive.'
