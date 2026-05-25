#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PYTHON_ENV="${PYTHON_ENV:-/datau/SiyuanLv/.conda/env/myenv}"
YARN_BIN="${YARN_BIN:-$PYTHON_ENV/bin/yarn}"
BACKEND_HOST="${BACKEND_HOST:-127.0.0.1}"
BACKEND_PORT="${BACKEND_PORT:-7263}"
FRONTEND_HOST="${FRONTEND_HOST:-0.0.0.0}"
FRONTEND_PORT="${FRONTEND_PORT:-7262}"
BACKEND_THREADS="${BACKEND_THREADS:-16}"
LOG_DIR="${LOG_DIR:-/datau/SiyuanLv/sam2_runtime_logs}"
mkdir -p "$LOG_DIR"

pids_for_port() {
  local port="$1"
  ss -ltnp 2>/dev/null |
    sed -n "s/.*:$port[[:space:]].*pid=\([0-9][0-9]*\).*/\1/p" |
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

ensure_port_free() {
  local port="$1"
  local name="$2"
  local pids

  pids="$(pids_for_port "$port" || true)"
  if [[ -n "$pids" ]]; then
    printf 'stopping lingering %s listener(s) on port %s: %s\n' "$name" "$port" "$pids"
    kill_pids "$pids"
  fi

  for _ in $(seq 1 15); do
    pids="$(pids_for_port "$port" || true)"
    if [[ -z "$pids" ]]; then
      return 0
    fi
    kill_pids "$pids"
    sleep 1
  done

  pids="$(pids_for_port "$port" || true)"
  printf 'ERROR: %s port %s is still in use by: %s\n' "$name" "$port" "$pids" >&2
  return 1
}

wait_for_listener() {
  local port="$1"
  local pid="$2"
  local name="$3"

  for _ in $(seq 1 30); do
    if [[ -n "$(pids_for_port "$port" || true)" ]]; then
      return 0
    fi
    if ! kill -0 "$pid" 2>/dev/null; then
      printf 'ERROR: %s process %s exited before listening on port %s\n' "$name" "$pid" "$port" >&2
      return 1
    fi
    sleep 1
  done

  printf 'ERROR: timed out waiting for %s process %s to listen on port %s\n' "$name" "$pid" "$port" >&2
  return 1
}

select_freest_gpu() {
  nvidia-smi --query-gpu=index,memory.free --format=csv,noheader,nounits 2>/dev/null |
    awk -F, 'BEGIN { best = ""; free = -1 } { gsub(/ /, "", $1); gsub(/ /, "", $2); if ($2 + 0 > free) { free = $2 + 0; best = $1 } } END { if (best != "") print best }'
}

BACKEND_CUDA_VISIBLE_DEVICES="${BACKEND_CUDA_VISIBLE_DEVICES:-auto}"
if [[ "$BACKEND_CUDA_VISIBLE_DEVICES" == "auto" ]]; then
  BACKEND_CUDA_VISIBLE_DEVICES="$(select_freest_gpu || true)"
fi

if [[ -n "$BACKEND_CUDA_VISIBLE_DEVICES" ]]; then
  export CUDA_VISIBLE_DEVICES="$BACKEND_CUDA_VISIBLE_DEVICES"
  printf 'selected backend CUDA_VISIBLE_DEVICES=%s\n' "$CUDA_VISIBLE_DEVICES"
else
  printf 'WARNING: no GPU selected; backend will use the default CUDA device visibility\n' >&2
fi

if [[ -n "${CUDA_VISIBLE_DEVICES:-}" ]]; then
  VIDEO_TRANSCODE_GPU_INDEX="${VIDEO_TRANSCODE_GPU_INDEX:-0}"
else
  VIDEO_TRANSCODE_GPU_INDEX="${VIDEO_TRANSCODE_GPU_INDEX:-3}"
fi
PYTORCH_CUDA_ALLOC_CONF="${PYTORCH_CUDA_ALLOC_CONF:-expandable_segments:True}"

"$ROOT_DIR/demo/stop_remote_dev.sh" all
ensure_port_free "$BACKEND_PORT" backend
ensure_port_free "$FRONTEND_PORT" frontend

cd "$ROOT_DIR/demo/backend/server"
APP_ROOT="$ROOT_DIR" \
API_URL="" \
MODEL_SIZE="${MODEL_SIZE:-base_plus}" \
DATA_PATH="$ROOT_DIR/demo/data" \
DEFAULT_VIDEO_PATH="${DEFAULT_VIDEO_PATH:-gallery/05_default_juggle.mp4}" \
SERVER_VIDEO_BROWSER_ROOT="${SERVER_VIDEO_BROWSER_ROOT:-/datau/SiyuanLv}" \
VIDEO_TRANSCODE_BACKEND="${VIDEO_TRANSCODE_BACKEND:-gpu}" \
VIDEO_TRANSCODE_GPU_INDEX="$VIDEO_TRANSCODE_GPU_INDEX" \
PYTORCH_CUDA_ALLOC_CONF="$PYTORCH_CUDA_ALLOC_CONF" \
TQDM_DISABLE="${TQDM_DISABLE:-1}" \
PYTHONUNBUFFERED="${PYTHONUNBUFFERED:-1}" \
SAM2_DEMO_MAX_SESSIONS="${SAM2_DEMO_MAX_SESSIONS:-10}" \
SAM2_DEMO_PROPAGATE_QUEUE_SIZE="${SAM2_DEMO_PROPAGATE_QUEUE_SIZE:-8}" \
SAM2_DEMO_PROPAGATE_MAX_SECONDS="${SAM2_DEMO_PROPAGATE_MAX_SECONDS:-300}" \
"$PYTHON_ENV/bin/gunicorn" \
  --worker-class gthread app:app \
  --workers 1 \
  --threads "$BACKEND_THREADS" \
  --bind "$BACKEND_HOST:$BACKEND_PORT" \
  --timeout 120 \
  > "$LOG_DIR/backend-$BACKEND_PORT.log" 2>&1 &
BACKEND_PID=$!
wait_for_listener "$BACKEND_PORT" "$BACKEND_PID" backend

cd "$ROOT_DIR/demo/frontend"
PATH="$PYTHON_ENV/bin:$PATH" \
VITE_BACKEND_PROXY_TARGET="http://$BACKEND_HOST:$BACKEND_PORT" \
VITE_HOST="$FRONTEND_HOST" \
VITE_PORT="$FRONTEND_PORT" \
"$YARN_BIN" dev \
  > "$LOG_DIR/frontend-$FRONTEND_PORT.log" 2>&1 &
FRONTEND_PID=$!
wait_for_listener "$FRONTEND_PORT" "$FRONTEND_PID" frontend

printf 'backend pid: %s, url: http://%s:%s\n' "$BACKEND_PID" "$BACKEND_HOST" "$BACKEND_PORT"
printf 'frontend pid: %s, url: http://%s:%s\n' "$FRONTEND_PID" "$FRONTEND_HOST" "$FRONTEND_PORT"
printf 'logs: %s\n' "$LOG_DIR"
