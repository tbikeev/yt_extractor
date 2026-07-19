#!/usr/bin/env bash
# Start the web app. Downloads use jauderho/yt-dlp via Docker (same as ytdl-docker).
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

FORCE_DOCKER_WEB="${FORCE_DOCKER_WEB:-0}"
FALLBACK_LOCAL="${FALLBACK_LOCAL:-1}"
export DOWNLOADER_IMAGE="${DOWNLOADER_IMAGE:-jauderho/yt-dlp}"

print_keychain_help() {
  cat <<'EOF'

Docker could not pull images because macOS Keychain credentials are locked
or unavailable in this terminal session.

Fix (pick one), then re-run ./scripts/start.sh:

  1) Unlock the login keychain:
       security unlock-keychain ~/Library/Keychains/login.keychain-db

  2) Or open Docker Desktop, ensure you're signed in, then retry.

Or skip building the web image and run the API on the host (still uses
jauderho/yt-dlp for downloads when Docker works):
       ./scripts/dev.sh

EOF
}

is_cred_error() {
  local log="$1"
  grep -qiE 'keychain|credentials|credStore|credsStore|error getting credentials' <<<"$log"
}

lan_ip() {
  if command -v ipconfig >/dev/null 2>&1; then
    ipconfig getifaddr en0 2>/dev/null || ipconfig getifaddr en1 2>/dev/null || true
  else
    hostname -I 2>/dev/null | awk '{print $1}' || true
  fi
}

start_local_fallback() {
  echo ""
  echo "==> Falling back to local web app (downloads still use ${DOWNLOADER_IMAGE} when Docker is up)…"
  exec "$ROOT/scripts/dev.sh"
}

if ! command -v docker >/dev/null 2>&1; then
  echo "Docker is not installed or not on PATH."
  if [[ "$FALLBACK_LOCAL" == "1" && "$FORCE_DOCKER_WEB" != "1" ]]; then
    start_local_fallback
  fi
  exit 1
fi

echo "==> Ensuring downloader image (${DOWNLOADER_IMAGE})"
PULL_LOG="$(mktemp)"
if ! docker pull "$DOWNLOADER_IMAGE" 2>&1 | tee "$PULL_LOG"; then
  if is_cred_error "$(cat "$PULL_LOG")"; then
    print_keychain_help
  fi
  # Image may already exist locally (e.g. from ytdl-docker)
  if ! docker image inspect "$DOWNLOADER_IMAGE" >/dev/null 2>&1; then
    rm -f "$PULL_LOG"
    if [[ "$FALLBACK_LOCAL" == "1" && "$FORCE_DOCKER_WEB" != "1" ]]; then
      start_local_fallback
    fi
    exit 1
  fi
  echo "Using existing local image ${DOWNLOADER_IMAGE}"
fi
rm -f "$PULL_LOG"

echo "==> Building & starting web app on :8080"
COMPOSE_LOG="$(mktemp)"
if ! docker compose up -d --build web 2>&1 | tee "$COMPOSE_LOG"; then
  if is_cred_error "$(cat "$COMPOSE_LOG")"; then
    print_keychain_help
    if [[ "$FALLBACK_LOCAL" == "1" && "$FORCE_DOCKER_WEB" != "1" ]]; then
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
echo "  Downloader image: ${DOWNLOADER_IMAGE}"
echo ""
echo "Open that URL on your iPhone or laptop (same Wi‑Fi)."
echo "Videos and the library DB are stored in: ${ROOT}/data"
