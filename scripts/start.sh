#!/usr/bin/env bash
# Build the Docker yt-dlp downloader image and start the web app.
# If Docker Hub auth/keychain fails on macOS, falls back to scripts/dev.sh
# unless FORCE_DOCKER=1.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

FORCE_DOCKER="${FORCE_DOCKER:-0}"
FALLBACK_LOCAL="${FALLBACK_LOCAL:-1}"

print_keychain_help() {
  cat <<'EOF'

Docker could not pull images because macOS Keychain credentials are locked
or unavailable in this terminal session.

Fix (pick one), then re-run ./scripts/start.sh:

  1) Unlock the login keychain:
       security unlock-keychain ~/Library/Keychains/login.keychain-db

  2) Or open Docker Desktop, ensure you're signed in, then retry.

  3) Or temporarily bypass the credential helper:
       # backup first
       cp ~/.docker/config.json ~/.docker/config.json.bak
       # remove the "credsStore" / "credStore" line(s), save, retry
       # restore later: mv ~/.docker/config.json.bak ~/.docker/config.json

Or skip Docker and run locally (needs Python 3, ffmpeg, yt-dlp):
       ./scripts/dev.sh

EOF
}

is_cred_error() {
  local log="$1"
  grep -qiE 'keychain|credentials|credStore|credsStore|error getting credentials' <<<"$log"
}

lan_ip() {
  if command -v ipconfig >/dev/null 2>&1; then
    # macOS
    ipconfig getifaddr en0 2>/dev/null || ipconfig getifaddr en1 2>/dev/null || true
  else
    hostname -I 2>/dev/null | awk '{print $1}' || true
  fi
}

start_local_fallback() {
  echo ""
  echo "==> Falling back to local mode (no Docker image pull)…"
  exec "$ROOT/scripts/dev.sh"
}

if ! command -v docker >/dev/null 2>&1; then
  echo "Docker is not installed or not on PATH."
  if [[ "$FALLBACK_LOCAL" == "1" && "$FORCE_DOCKER" != "1" ]]; then
    start_local_fallback
  fi
  exit 1
fi

echo "==> Building downloader image (yt-extractor-downloader)"
BUILD_LOG="$(mktemp)"
if ! docker build -t yt-extractor-downloader -f downloader/Dockerfile . 2>&1 | tee "$BUILD_LOG"; then
  if is_cred_error "$(cat "$BUILD_LOG")"; then
    print_keychain_help
    if [[ "$FALLBACK_LOCAL" == "1" && "$FORCE_DOCKER" != "1" ]]; then
      rm -f "$BUILD_LOG"
      start_local_fallback
    fi
  fi
  rm -f "$BUILD_LOG"
  exit 1
fi
rm -f "$BUILD_LOG"

echo "==> Building & starting web app on :8080"
COMPOSE_LOG="$(mktemp)"
if ! docker compose up -d --build web 2>&1 | tee "$COMPOSE_LOG"; then
  if is_cred_error "$(cat "$COMPOSE_LOG")"; then
    print_keychain_help
    if [[ "$FALLBACK_LOCAL" == "1" && "$FORCE_DOCKER" != "1" ]]; then
      rm -f "$COMPOSE_LOG"
      start_local_fallback
    fi
  fi
  rm -f "$COMPOSE_LOG"
  exit 1
fi
rm -f "$COMPOSE_LOG"

LAN_IP="$(lan_ip)"
echo ""
echo "YT Extractor is running."
echo "  Local:   http://127.0.0.1:8080"
if [[ -n "${LAN_IP}" ]]; then
  echo "  Network: http://${LAN_IP}:8080"
fi
echo ""
echo "Open that URL on your iPhone or laptop (same Wi‑Fi)."
echo "Videos and the library DB are stored in: ${ROOT}/data"
