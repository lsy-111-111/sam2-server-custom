#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PYTHON_ENV="${PYTHON_ENV:-/datau/SiyuanLv/.conda/env/myenv}"
BACKEND_PORT="${BACKEND_PORT:-7263}"
FRONTEND_PORT="${FRONTEND_PORT:-7262}"
TARGET="${1:-all}"

pids_for_port() {
  local port="$1"
  ss -ltnp 2>/dev/null |
    sed -n "s/.*:$port[[:space:]].*pid=\([0-9][0-9]*\).*/\\1/p" |
    sort -u
}

kill_pids() {
  local pids="$*"
  if [[ -z "$pids" ]]; then
    return 0
  fi

  kill $pids 2>/dev/null || true
  sleep 1

  for pid in $pids; do
    if kill -0 "$pid" 2>/dev/null; then
      kill -9 "$pid" 2>/dev/null || true
    fi
  done
}

stop_frontend() {
  kill_pids "$(pids_for_port "$FRONTEND_PORT")"
  pkill -u "$(id -un)" -f "$ROOT_DIR/demo/frontend/node_modules/vite/bin/vite.js" 2>/dev/null || true
  pkill -u "$(id -un)" -f "$PYTHON_ENV/bin/yarn.js dev" 2>/dev/null || true
}

stop_backend() {
  kill_pids "$(pids_for_port "$BACKEND_PORT")"
  pkill -u "$(id -un)" -f "gunicorn .*app:app.*$BACKEND_PORT" 2>/dev/null || true
}

case "$TARGET" in
  frontend)
    stop_frontend
    ;;
  backend)
    stop_backend
    ;;
  all)
    stop_frontend
    stop_backend
    ;;
  *)
    echo "Usage: $0 [frontend|backend|all]" >&2
    exit 2
    ;;
esac
