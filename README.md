# YT Extractor

Local web app that downloads YouTube videos, converts them to MP4, extracts timestamped subtitles, and lets you watch + full-text search them from an iPhone or laptop on your network.

Project path on your machine: `~/Projects/yt_extractor`  
GitHub: https://github.com/tbikeev/yt_extractor

## What it does

1. **Download** — YouTube video via a Docker `yt-dlp` downloader (or local `yt-dlp`)
2. **Convert** — remux/encode to **MP4** with `ffmpeg`
3. **Subtitles** — pull original (or auto) captions, store as VTT + searchable cues
4. **Watch offline** — HTML5 player with clickable timestamped transcript
5. **Search** — SQLite FTS5 across all library transcripts; jump straight to the hit

## Quick start (Docker — recommended)

Requires Docker Desktop (or Docker Engine) and `docker compose`.

```bash
cd ~/Projects/yt_extractor   # or clone into that path
chmod +x scripts/*.sh
./scripts/start.sh
```

Then open:

- This machine: http://127.0.0.1:8080  
- Phone / other devices (same Wi‑Fi): `http://<your-lan-ip>:8080`

The start script builds:

- `yt-extractor-downloader` — yt-dlp + ffmpeg image used for downloads  
- `yt-extractor-web` — FastAPI app + UI, port **8080**

Data (videos, thumbs, SQLite DB) lives in `./data/` on the host.

### macOS: “keychain cannot be accessed” / credential errors

Docker Desktop stores Hub credentials in the login keychain. If the keychain is locked (common in some terminal sessions), image pulls fail.

```bash
security unlock-keychain ~/Library/Keychains/login.keychain-db
./scripts/start.sh
```

Or open Docker Desktop and sign in, then retry.  
`./scripts/start.sh` will automatically fall back to local mode if the pull still fails (unless you set `FORCE_DOCKER=1`).

## Dev mode (no Docker)

Needs **Python 3.8+** (3.11/3.12 recommended), `ffmpeg`, and `yt-dlp`:

```bash
./scripts/dev.sh
```

On macOS with Homebrew:

```bash
brew install python ffmpeg yt-dlp
PYTHON=python3.12 ./scripts/dev.sh   # if `python3` is still an old system build
```

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
├── backend/app/main.py      # FastAPI app
├── frontend/                # Mobile-friendly UI
├── downloader/Dockerfile    # yt-dlp + ffmpeg image
├── docker-compose.yml
├── scripts/start.sh         # Docker start
├── scripts/dev.sh           # Local start
└── data/                    # Local media + DB (gitignored)
```

## Notes

- Prefer official / uploaded captions when available; falls back to auto-captions.
- Re-downloading the same YouTube id updates the existing library entry.
- Bind address is `0.0.0.0` so devices on your LAN can reach the app.
- For personal offline use of content you are allowed to download.
