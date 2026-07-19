#!/usr/bin/env bash
# Build the Docker yt-dlp downloader image and start the web app.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

echo "==> Building downloader image (yt-extractor-downloader)"
docker build -t yt-extractor-downloader -f downloader/Dockerfile .

echo "==> Building & starting web app on :8080"
docker compose up -d --build web

LAN_IP="$(hostname -I 2>/dev/null | awk '{print $1}')"
echo ""
echo "YT Extractor is running."
echo "  Local:   http://127.0.0.1:8080"
if [[ -n "${LAN_IP}" ]]; then
  echo "  Network: http://${LAN_IP}:8080"
fi
echo ""
echo "Open that URL on your iPhone or laptop (same Wi‑Fi)."
echo "Videos and the library DB are stored in: ${ROOT}/data"
