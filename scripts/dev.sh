#!/usr/bin/env bash
# Run the web app locally without Docker (uses host yt-dlp + ffmpeg).
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

# Ensure Homebrew Node/ffmpeg are visible even in minimal PATH shells (macOS GUI/IDE).
export PATH="/opt/homebrew/bin:/usr/local/bin:${HOME}/.local/bin:${PATH}"

export YT_EXTRACTOR_ROOT="$ROOT"
export DATA_DIR="${DATA_DIR:-$ROOT/data}"
export USE_DOCKER="${USE_DOCKER:-never}"
export HOST="${HOST:-0.0.0.0}"
export PORT="${PORT:-8080}"

PYTHON="${PYTHON:-python3}"
if ! command -v "$PYTHON" >/dev/null 2>&1; then
  echo "ERROR: python3 not found. Install Python 3.9+ (e.g. brew install python)."
  exit 1
fi

PY_VER="$("$PYTHON" -c 'import sys; print("%d.%d" % sys.version_info[:2])')"
PY_MAJOR="$("$PYTHON" -c 'import sys; print(sys.version_info[0])')"
PY_MINOR="$("$PYTHON" -c 'import sys; print(sys.version_info[1])')"
echo "Using $PYTHON ($PY_VER)"

if [[ "$PY_MAJOR" -lt 3 || "$PY_MINOR" -lt 8 ]]; then
  echo "ERROR: Python 3.8+ is required (found $PY_VER)."
  echo "  brew install python && PYTHON=python3.12 ./scripts/dev.sh"
  exit 1
fi

"$PYTHON" -m pip install -q -U pip setuptools wheel
"$PYTHON" -m pip install -q -r backend/requirements.txt
"$PYTHON" -m pip install -q -U yt-dlp curl_cffi >/dev/null 2>&1 || true

if ! command -v node >/dev/null 2>&1 && ! command -v deno >/dev/null 2>&1; then
  echo ""
  echo "ERROR: No JavaScript runtime found (node/deno)."
  echo "  Modern YouTube downloads require Node.js."
  echo "  brew install node"
  echo "  Then re-run ./scripts/dev.sh"
  exit 1
fi

echo "JS runtime: $(command -v node || command -v deno)"

if ! command -v ffmpeg >/dev/null 2>&1; then
  echo "ERROR: ffmpeg is required. Install it (e.g. brew install ffmpeg)."
  exit 1
fi

mkdir -p "$DATA_DIR/videos" "$DATA_DIR/thumbs" "$DATA_DIR/jobs"
echo "Starting YT Extractor on http://${HOST}:${PORT}"
echo "Health check should show js_runtime=node: curl -s http://127.0.0.1:${PORT}/api/health"
exec "$PYTHON" -m uvicorn backend.app.main:app --host "$HOST" --port "$PORT" --reload
