# YT Extractor

Local web app that downloads YouTube videos, converts them to MP4, extracts timestamped subtitles, and lets you watch + full-text search them from an iPhone or laptop on your network.

Project path on your machine: `~/Projects/yt_extractor`  
GitHub: https://github.com/tbikeev/yt_extractor

## What it does

1. **Download** — YouTube video via Docker **`jauderho/yt-dlp`** (same image as `ytdl-docker`) or local `yt-dlp`
2. **Convert** — remux/encode to **MP4** with `ffmpeg`
3. **Subtitles** — pull original (or auto) captions, store as VTT + searchable cues
4. **Watch offline** — HTML5 player with clickable timestamped transcript
5. **Search** — SQLite FTS5 across all library transcripts; jump straight to the hit

## Quick start (Docker — recommended)

Requires Docker Desktop (or Docker Engine). Downloads use the public image you already have:

```bash
docker pull jauderho/yt-dlp   # once; same as ytdl-docker
cd ~/Projects/yt_extractor
chmod +x scripts/*.sh
./scripts/dev.sh              # web on host, downloads via jauderho/yt-dlp
# or fully containerized web:
./scripts/start.sh
```

Then open:

- This machine: http://127.0.0.1:8080  
- Phone / other devices (same Wi‑Fi): `http://<your-lan-ip>:8080`

`./scripts/dev.sh` defaults to `USE_DOCKER=auto` and will call:

```text
docker run --rm -u $(id -u):$(id -g) -v <video-dir>:/workdir jauderho/yt-dlp -P /workdir …
```

That image includes **deno** + **curl_cffi**, which fixes modern YouTube JS / impersonation requirements.

Data (videos, thumbs, SQLite DB) lives in `./data/` on the host.

### macOS: “keychain cannot be accessed” / credential errors

If `docker pull` fails on a locked keychain, unlock it or use an image you already pulled via `ytdl-docker`:

```bash
security unlock-keychain ~/Library/Keychains/login.keychain-db
docker pull jauderho/yt-dlp
./scripts/dev.sh
```

## Dev mode without Docker downloads

Force host yt-dlp (needs **Node.js** for YouTube):

```bash
USE_DOCKER=never brew install python ffmpeg yt-dlp node
USE_DOCKER=never ./scripts/dev.sh
```

**Note:** Subtitles are fetched separately with retries — a YouTube 429 on captions will still keep the MP4.

## Usage

1. Paste a YouTube URL on the home screen → **Download**
2. Wait for the job to finish (status updates live)
3. Open **Watch** — tap any transcript line to seek
4. Use **Search** to find phrases across all downloaded videos

## API (brief)

| Method | Path | Purpose |
|--------|------|---------|
| GET | `/api/health` | Health + docker/yt-dlp status |
| GET | `/api/videos` | Library |
| POST | `/api/download` | `{ "url": "...", "language": "en" }` |
| GET | `/api/jobs/{id}` | Job status |
| GET | `/api/videos/{id}/cues` | Timestamped cues |
| GET | `/api/search?q=` | Full-text subtitle search |
| GET | `/media/videos/{youtube_id}/{file}.mp4` | Video file |

## Layout

```
yt_extractor/
├── backend/app/main.py      # FastAPI app (spawns jauderho/yt-dlp)
├── frontend/                # Mobile-friendly UI
├── docker-compose.yml
├── scripts/start.sh         # Docker web + jauderho/yt-dlp
├── scripts/dev.sh           # Local web; Docker downloads when available
└── data/                    # Local media + DB (gitignored)
```

Override the downloader image if needed:

```bash
DOWNLOADER_IMAGE=jauderho/yt-dlp USE_DOCKER=auto ./scripts/dev.sh
```

## Notes

- Prefer official / uploaded captions when available; falls back to auto-captions.
- Re-downloading the same YouTube id updates the existing library entry.
- Bind address is `0.0.0.0` so devices on your LAN can reach the app.
- For personal offline use of content you are allowed to download.
