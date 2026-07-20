#!/usr/bin/env bash
# Stop any running YT Extractor instance and start in the background (macOS/Linux).
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

export PATH="/opt/homebrew/bin:/usr/local/bin:${HOME}/.local/bin:${PATH}"
PORT="${PORT:-8080}"
LOG="${LOG:-$ROOT/data/yt-extractor.log}"
PIDFILE="${PIDFILE:-$ROOT/data/yt-extractor.pid}"

mkdir -p "$ROOT/data"

stop_existing() {
  if [[ -f "$PIDFILE" ]]; then
    OLD_PID="$(cat "$PIDFILE" 2>/dev/null || true)"
    if [[ -n "${OLD_PID}" ]] && kill -0 "$OLD_PID" 2>/dev/null; then
      echo "Stopping PID ${OLD_PID}…"
      kill "$OLD_PID" 2>/dev/null || true
      sleep 1
      kill -9 "$OLD_PID" 2>/dev/null || true
    fi
    rm -f "$PIDFILE"
  fi

  # Also stop anything still bound to the port.
  if command -v lsof >/dev/null 2>&1; then
    PIDS="$(lsof -ti tcp:"$PORT" 2>/dev/null || true)"
    if [[ -n "${PIDS}" ]]; then
      echo "Stopping process(es) on port ${PORT}: ${PIDS}"
      kill ${PIDS} 2>/dev/null || true
      sleep 1
      kill -9 ${PIDS} 2>/dev/null || true
    fi
  fi
}

start_background() {
  echo "Starting YT Extractor in background (port ${PORT})…"
  echo "Log: ${LOG}"
  nohup "$ROOT/scripts/dev.sh" >>"$LOG" 2>&1 &
  echo $! >"$PIDFILE"
  sleep 2

  if curl -sf "http://127.0.0.1:${PORT}/api/health" >/dev/null 2>&1; then
    echo "OK — http://127.0.0.1:${PORT}"
    curl -s "http://127.0.0.1:${PORT}/api/health" | python3 -m json.tool 2>/dev/null || true
  else
    echo "Server not responding yet. Check log:"
    echo "  tail -f ${LOG}"
    exit 1
  fi
}

case "${1:-restart}" in
  stop)
    stop_existing
    echo "Stopped."
    ;;
  start)
    start_background
    ;;
  status)
    if [[ -f "$PIDFILE" ]] && kill -0 "$(cat "$PIDFILE")" 2>/dev/null; then
      echo "Running (PID $(cat "$PIDFILE"))"
      curl -s "http://127.0.0.1:${PORT}/api/health" 2>/dev/null || echo "Health check failed"
    else
      echo "Not running"
      exit 1
    fi
    ;;
  restart|*)
    stop_existing
    start_background
    ;;
esac
