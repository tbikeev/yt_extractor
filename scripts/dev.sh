#!/usr/bin/env bash
# Run the web app locally. Prefers Docker jauderho/yt-dlp when Docker is available
# (same image as ~/…/ytdl-docker). Falls back to host yt-dlp + Node.
# Uses a project .venv (required on Homebrew Python 3.11+ / PEP 668).
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

# Ensure Homebrew binaries are visible even in minimal PATH shells (macOS GUI/IDE).
export PATH="/opt/homebrew/bin:/usr/local/bin:${HOME}/.local/bin:${PATH}"

export YT_EXTRACTOR_ROOT="$ROOT"
export DATA_DIR="${DATA_DIR:-$ROOT/data}"
export DOWNLOADER_IMAGE="${DOWNLOADER_IMAGE:-jauderho/yt-dlp}"
export USE_DOCKER="${USE_DOCKER:-auto}"
export HOST="${HOST:-0.0.0.0}"
export PORT="${PORT:-8080}"
VENV_DIR="${VENV_DIR:-$ROOT/.venv}"

pick_python() {
  if [[ -n "${PYTHON:-}" ]]; then
    echo "$PYTHON"
    return
  fi
  # Prefer stable Homebrew Pythons over the latest (e.g. 3.14) when unset.
  for cmd in python3.12 python3.13 python3.11 python3; do
    if command -v "$cmd" >/dev/null 2>&1; then
      echo "$cmd"
      return
    fi
  done
  echo "python3"
}

ensure_venv() {
  local bootstrap_py
  bootstrap_py="$(pick_python)"
  if ! command -v "$bootstrap_py" >/dev/null 2>&1; then
    echo "ERROR: python3 not found. Install Python 3.9+ (e.g. brew install python)."
    exit 1
  fi

  local py_ver py_major py_minor
  py_ver="$("$bootstrap_py" -c 'import sys; print("%d.%d" % sys.version_info[:2])')"
  py_major="$("$bootstrap_py" -c 'import sys; print(sys.version_info[0])')"
  py_minor="$("$bootstrap_py" -c 'import sys; print(sys.version_info[1])')"
  echo "Bootstrap Python: $bootstrap_py ($py_ver)"

  if [[ "$py_major" -lt 3 || "$py_minor" -lt 8 ]]; then
    echo "ERROR: Python 3.8+ is required (found $py_ver)."
    exit 1
  fi

  if [[ ! -d "$VENV_DIR" ]]; then
    echo "Creating virtualenv at ${VENV_DIR} …"
    "$bootstrap_py" -m venv "$VENV_DIR"
  fi

  # shellcheck disable=SC1091
  source "$VENV_DIR/bin/activate"

  echo "Using venv Python: $(python -c 'import sys; print(sys.executable)')"
  python -m pip install -q -U pip setuptools wheel
  python -m pip install -q -r backend/requirements.txt
}

ensure_venv

HAVE_DOCKER=0
if command -v docker >/dev/null 2>&1 && docker info >/dev/null 2>&1; then
  HAVE_DOCKER=1
fi

if [[ "$USE_DOCKER" != "never" && "$HAVE_DOCKER" -eq 1 ]]; then
  echo "Downloader: Docker image ${DOWNLOADER_IMAGE}"
  if ! docker image inspect "$DOWNLOADER_IMAGE" >/dev/null 2>&1; then
    echo "Pulling ${DOWNLOADER_IMAGE}…"
    docker pull "$DOWNLOADER_IMAGE"
  fi
  export USE_DOCKER=auto
elif [[ "$USE_DOCKER" == "always" ]]; then
  echo "ERROR: USE_DOCKER=always but Docker is not available."
  exit 1
else
  export USE_DOCKER=never
  echo "Downloader: local yt-dlp (Docker unavailable)"
  python -m pip install -q -U yt-dlp curl_cffi >/dev/null 2>&1 || true
  if ! command -v node >/dev/null 2>&1 && ! command -v deno >/dev/null 2>&1; then
    echo ""
    echo "ERROR: No JavaScript runtime found (node/deno), and Docker is unavailable."
    echo "  brew install node"
    echo "  # or: brew install --cask docker  && docker pull jauderho/yt-dlp"
    exit 1
  fi
  echo "JS runtime: $(command -v node || command -v deno)"
fi

if ! command -v ffmpeg >/dev/null 2>&1; then
  echo "ERROR: ffmpeg is required on the host for MP4 conversion (e.g. brew install ffmpeg)."
  exit 1
fi

mkdir -p "$DATA_DIR/videos" "$DATA_DIR/thumbs" "$DATA_DIR/jobs"
echo "Starting YT Extractor on http://${HOST}:${PORT}"
echo "Check: curl -s http://127.0.0.1:${PORT}/api/health"
if [[ "${NO_RELOAD:-}" == "1" ]]; then
  exec python -m uvicorn backend.app.main:app --host "$HOST" --port "$PORT"
fi
exec python -m uvicorn backend.app.main:app --host "$HOST" --port "$PORT" --reload
