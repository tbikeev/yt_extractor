#!/usr/bin/env bash
# Run the web app locally without Docker (uses host yt-dlp + ffmpeg).
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

export YT_EXTRACTOR_ROOT="$ROOT"
export DATA_DIR="${DATA_DIR:-$ROOT/data}"
export USE_DOCKER="${USE_DOCKER:-never}"
export HOST="${HOST:-0.0.0.0}"
export PORT="${PORT:-8080}"

python3 -m pip install -q -r backend/requirements.txt

if ! command -v yt-dlp >/dev/null 2>&1; then
  echo "Installing yt-dlp locally…"
  python3 -m pip install -q yt-dlp
fi

if ! command -v ffmpeg >/dev/null 2>&1; then
  echo "ERROR: ffmpeg is required. Install it (e.g. apt install ffmpeg / brew install ffmpeg)."
  exit 1
fi

mkdir -p "$DATA_DIR/videos" "$DATA_DIR/thumbs" "$DATA_DIR/jobs"
echo "Starting YT Extractor on http://${HOST}:${PORT}"
exec python3 -m uvicorn backend.app.main:app --host "$HOST" --port "$PORT" --reload
