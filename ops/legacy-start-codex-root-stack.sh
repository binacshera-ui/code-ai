#!/usr/bin/env bash

set -euo pipefail

# Historical monorepo launcher kept only as migration evidence.
# Its source paths were retired; do not use it for the live standalone service.
if [[ "${ALLOW_RETIRED_MONOREPO_LAUNCHER:-false}" != "true" ]]; then
  echo "Retired launcher. Use /root/projects/code-ai/ecosystem.config.cjs instead."
  exit 2
fi

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
APP_DIR="$SCRIPT_DIR/web/app"
GATEWAY_DIR="$SCRIPT_DIR/services-gateway"

ROOT_PM2_HOME="/root/.pm2"
LEGACY_PM2_HOME="/home/developer/.pm2"
DEVELOPER2_PM2_HOME="/home/developer2/.pm2"
PM2_BIN="${PM2_BIN:-/root/.nvm/versions/node/v24.12.0/bin/pm2}"
BASE_PATH="/root/.nvm/versions/node/v24.12.0/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin"

if [[ "$(id -u)" -ne 0 ]]; then
  echo "Run this script as root."
  exit 1
fi

if [[ ! -x "$PM2_BIN" ]]; then
  echo "Missing PM2 binary: $PM2_BIN"
  exit 1
fi

log() {
  printf '[%s] %s\n' "$(date '+%F %T')" "$*"
}

run_pm2() {
  local home="$1"
  shift

  env -i \
    HOME=/root \
    USER=root \
    LOGNAME=root \
    PM2_HOME="$home" \
    PATH="$BASE_PATH" \
    "$PM2_BIN" "$@"
}

run_root_pm2() {
  run_pm2 "$ROOT_PM2_HOME" "$@"
}

run_legacy_pm2() {
  run_pm2 "$LEGACY_PM2_HOME" "$@"
}

run_developer2_pm2() {
  run_pm2 "$DEVELOPER2_PM2_HOME" "$@"
}

delete_pm2_apps() {
  local runner="$1"
  shift

  local app_name
  for app_name in "$@"; do
    "$runner" delete "$app_name" >/dev/null 2>&1 || true
  done
}

start_root_app() {
  local cwd="$1"
  local config="$2"
  local app_name="$3"

  env -i \
    HOME=/root \
    USER=root \
    LOGNAME=root \
    PATH="$BASE_PATH" \
    PM2_HOME="$ROOT_PM2_HOME" \
    PM2_APP_NAME="$app_name" \
    "$PM2_BIN" start "$config" --only "$app_name" --update-env --cwd "$cwd"
}

log "Stopping legacy PM2 home for /home/developer to avoid port conflicts"
delete_pm2_apps run_legacy_pm2 bina-cshera-app services-gateway
run_legacy_pm2 save >/dev/null 2>&1 || true
run_legacy_pm2 kill >/dev/null 2>&1 || true

log "Removing stale root-managed copies if they exist"
delete_pm2_apps run_root_pm2 bina-cshera-app services-gateway

log "Stopping the legacy developer2 PM2 daemon if it exists"
run_developer2_pm2 kill >/dev/null 2>&1 || true

log "Starting bina-cshera-app under root PM2"
start_root_app "$APP_DIR" "$APP_DIR/ecosystem.config.cjs" "bina-cshera-app"

log "Starting services-gateway under root PM2"
start_root_app "$GATEWAY_DIR" "$GATEWAY_DIR/ecosystem.config.js" "services-gateway"

log "Saving root PM2 process list"
run_root_pm2 save

log "Restarting pm2-root.service so the daemon matches the fixed PM2 binary"
systemctl restart pm2-root.service

log "PM2 status"
run_root_pm2 ls --no-color

log "Listening ports"
ss -ltnp '( sport = :3000 or sport = :4000 )' || true

log "Local health checks"
curl -fsSI http://127.0.0.1:4000/ | sed -n '1,5p' || true
echo "---"
curl -fsSI http://127.0.0.1:3000/ | sed -n '1,5p' || true

log "External health check"
curl -fsSI https://app-codex.bina-cshera.co.il/ | sed -n '1,5p' || true

log "Done"
