"""YT Extractor — download YouTube videos, convert to MP4, extract timestamped subs."""

from __future__ import annotations

import asyncio
import json
import os
import re
import shutil
import sqlite3
import subprocess
import uuid
from contextlib import asynccontextmanager
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from fastapi import FastAPI, HTTPException, Query
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, HTMLResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field

ROOT = Path(os.environ.get("YT_EXTRACTOR_ROOT", Path(__file__).resolve().parents[2]))
DATA_DIR = Path(os.environ.get("DATA_DIR", ROOT / "data"))
VIDEOS_DIR = DATA_DIR / "videos"
THUMBS_DIR = DATA_DIR / "thumbs"
JOBS_DIR = DATA_DIR / "jobs"
DB_PATH = DATA_DIR / "library.db"
FRONTEND_DIR = ROOT / "frontend"

DOWNLOADER_IMAGE = os.environ.get("DOWNLOADER_IMAGE", "yt-extractor-downloader")
USE_DOCKER = os.environ.get("USE_DOCKER", "auto")  # auto | always | never
HOST = os.environ.get("HOST", "0.0.0.0")
PORT = int(os.environ.get("PORT", "8080"))

YOUTUBE_ID_RE = re.compile(
    r"(?:youtu\.be/|youtube\.com/(?:watch\?v=|embed/|shorts/|live/)|[?&]v=)([A-Za-z0-9_-]{11})"
)
BARE_ID_RE = re.compile(r"^[A-Za-z0-9_-]{11}$")


# ---------------------------------------------------------------------------
# Models
# ---------------------------------------------------------------------------


class DownloadRequest(BaseModel):
    url: str = Field(..., min_length=5, description="YouTube URL or 11-char video id")
    language: str = Field(default="en", description="Preferred subtitle language")


class Cue(BaseModel):
    start: float
    end: float
    text: str


class VideoOut(BaseModel):
    id: str
    youtube_id: str
    title: str
    duration: float | None
    language: str | None
    status: str
    has_video: bool
    has_subs: bool
    thumbnail_url: str | None
    video_url: str | None
    created_at: str
    error: str | None = None


class JobOut(BaseModel):
    id: str
    youtube_id: str | None
    url: str
    status: str
    stage: str
    message: str
    video_id: str | None = None
    error: str | None = None
    created_at: str
    updated_at: str


class SearchHit(BaseModel):
    video_id: str
    youtube_id: str
    title: str
    start: float
    end: float
    text: str
    snippet: str


# ---------------------------------------------------------------------------
# Database
# ---------------------------------------------------------------------------


def get_db() -> sqlite3.Connection:
    conn = sqlite3.connect(DB_PATH, check_same_thread=False)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA foreign_keys = ON")
    return conn


def init_db() -> None:
    DATA_DIR.mkdir(parents=True, exist_ok=True)
    VIDEOS_DIR.mkdir(parents=True, exist_ok=True)
    THUMBS_DIR.mkdir(parents=True, exist_ok=True)
    JOBS_DIR.mkdir(parents=True, exist_ok=True)

    with get_db() as conn:
        conn.executescript(
            """
            CREATE TABLE IF NOT EXISTS videos (
                id TEXT PRIMARY KEY,
                youtube_id TEXT NOT NULL UNIQUE,
                title TEXT NOT NULL,
                duration REAL,
                language TEXT,
                status TEXT NOT NULL DEFAULT 'ready',
                has_video INTEGER NOT NULL DEFAULT 0,
                has_subs INTEGER NOT NULL DEFAULT 0,
                error TEXT,
                created_at TEXT NOT NULL,
                updated_at TEXT NOT NULL
            );

            CREATE TABLE IF NOT EXISTS cues (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                video_id TEXT NOT NULL REFERENCES videos(id) ON DELETE CASCADE,
                start REAL NOT NULL,
                end REAL NOT NULL,
                text TEXT NOT NULL
            );
            CREATE INDEX IF NOT EXISTS idx_cues_video ON cues(video_id);
            CREATE INDEX IF NOT EXISTS idx_cues_start ON cues(video_id, start);

            CREATE VIRTUAL TABLE IF NOT EXISTS cues_fts USING fts5(
                text,
                video_id UNINDEXED,
                start UNINDEXED,
                end UNINDEXED,
                content='cues',
                content_rowid='id'
            );

            CREATE TRIGGER IF NOT EXISTS cues_ai AFTER INSERT ON cues BEGIN
                INSERT INTO cues_fts(rowid, text, video_id, start, end)
                VALUES (new.id, new.text, new.video_id, new.start, new.end);
            END;
            CREATE TRIGGER IF NOT EXISTS cues_ad AFTER DELETE ON cues BEGIN
                INSERT INTO cues_fts(cues_fts, rowid, text, video_id, start, end)
                VALUES ('delete', old.id, old.text, old.video_id, old.start, old.end);
            END;
            CREATE TRIGGER IF NOT EXISTS cues_au AFTER UPDATE ON cues BEGIN
                INSERT INTO cues_fts(cues_fts, rowid, text, video_id, start, end)
                VALUES ('delete', old.id, old.text, old.video_id, old.start, old.end);
                INSERT INTO cues_fts(rowid, text, video_id, start, end)
                VALUES (new.id, new.text, new.video_id, new.start, new.end);
            END;

            CREATE TABLE IF NOT EXISTS jobs (
                id TEXT PRIMARY KEY,
                youtube_id TEXT,
                url TEXT NOT NULL,
                status TEXT NOT NULL,
                stage TEXT NOT NULL,
                message TEXT NOT NULL,
                video_id TEXT,
                error TEXT,
                created_at TEXT NOT NULL,
                updated_at TEXT NOT NULL
            );
            """
        )


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


def now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


def extract_youtube_id(url_or_id: str) -> str:
    text = url_or_id.strip()
    if BARE_ID_RE.match(text):
        return text
    match = YOUTUBE_ID_RE.search(text)
    if match:
        return match.group(1)
    raise ValueError("Could not parse a YouTube video id from that URL")


def video_dir(youtube_id: str) -> Path:
    path = VIDEOS_DIR / youtube_id
    path.mkdir(parents=True, exist_ok=True)
    return path


def docker_available() -> bool:
    return shutil.which("docker") is not None


def should_use_docker() -> bool:
    if USE_DOCKER == "always":
        return True
    if USE_DOCKER == "never":
        return False
    return docker_available()


def yt_dlp_cmd(args: list[str], workdir: Path) -> list[str]:
    """Build either a dockerized or local yt-dlp command."""
    if should_use_docker():
        return [
            "docker",
            "run",
            "--rm",
            "-v",
            f"{workdir.resolve()}:/out",
            "-w",
            "/out",
            DOWNLOADER_IMAGE,
            *args,
        ]
    return ["yt-dlp", *args]


def run_cmd(cmd: list[str], cwd: Path | None = None, timeout: int = 3600) -> subprocess.CompletedProcess[str]:
    return subprocess.run(
        cmd,
        cwd=str(cwd) if cwd else None,
        capture_output=True,
        text=True,
        timeout=timeout,
        check=False,
    )


def parse_vtt(path: Path) -> list[dict[str, Any]]:
    """Parse a WebVTT file into cue dicts with start/end seconds and text."""
    raw = path.read_text(encoding="utf-8", errors="replace")
    # Strip BOM / header
    lines = raw.replace("\r\n", "\n").replace("\r", "\n").split("\n")
    cues: list[dict[str, Any]] = []
    i = 0
    time_re = re.compile(
        r"(?:(\d{2,}):)?(\d{2}):(\d{2})\.(\d{3})\s*-->\s*(?:(\d{2,}):)?(\d{2}):(\d{2})\.(\d{3})"
    )

    def to_seconds(h: str | None, m: str, s: str, ms: str) -> float:
        hours = int(h or 0)
        return hours * 3600 + int(m) * 60 + int(s) + int(ms) / 1000.0

    while i < len(lines):
        line = lines[i].strip()
        i += 1
        if not line or line.upper().startswith("WEBVTT") or line.startswith("NOTE"):
            continue
        # Optional cue identifier line
        if "-->" not in line and i < len(lines) and "-->" in lines[i]:
            line = lines[i].strip()
            i += 1
        match = time_re.search(line)
        if not match:
            continue
        start = to_seconds(match.group(1), match.group(2), match.group(3), match.group(4))
        end = to_seconds(match.group(5), match.group(6), match.group(7), match.group(8))
        text_lines: list[str] = []
        while i < len(lines) and lines[i].strip():
            cleaned = re.sub(r"<[^>]+>", "", lines[i]).strip()
            if cleaned:
                text_lines.append(cleaned)
            i += 1
        text = " ".join(text_lines).strip()
        if text:
            # Deduplicate consecutive identical overlapping auto-captions
            if cues and cues[-1]["text"] == text and abs(cues[-1]["start"] - start) < 0.05:
                cues[-1]["end"] = max(cues[-1]["end"], end)
            else:
                cues.append({"start": start, "end": end, "text": text})
    return cues


def parse_json3(path: Path) -> list[dict[str, Any]]:
    data = json.loads(path.read_text(encoding="utf-8"))
    events = data.get("events") or []
    cues: list[dict[str, Any]] = []
    for event in events:
        segs = event.get("segs")
        if not segs:
            continue
        text = "".join(seg.get("utf8", "") for seg in segs).replace("\n", " ").strip()
        if not text or text == "\n":
            continue
        start_ms = event.get("tStartMs", 0)
        dur_ms = event.get("dDurationMs", 0)
        start = start_ms / 1000.0
        end = (start_ms + dur_ms) / 1000.0
        if cues and cues[-1]["text"] == text and abs(cues[-1]["start"] - start) < 0.05:
            cues[-1]["end"] = max(cues[-1]["end"], end)
        else:
            cues.append({"start": start, "end": end, "text": text})
    return cues


def find_subtitle_file(directory: Path, youtube_id: str) -> Path | None:
    patterns = [
        f"{youtube_id}.*.vtt",
        f"{youtube_id}.vtt",
        f"{youtube_id}.*.json3",
        f"{youtube_id}.json3",
        "*.vtt",
        "*.json3",
    ]
    for pattern in patterns:
        matches = sorted(directory.glob(pattern))
        # Prefer non-auto when both exist
        preferred = [m for m in matches if ".auto." not in m.name and ".auto-" not in m.name]
        pick = preferred[0] if preferred else (matches[0] if matches else None)
        if pick:
            return pick
    return None


def ensure_mp4(directory: Path, youtube_id: str) -> Path:
    target = directory / f"{youtube_id}.mp4"
    if target.exists() and target.stat().st_size > 0:
        return target

    candidates = sorted(directory.glob(f"{youtube_id}.*"))
    media_exts = {".mp4", ".webm", ".mkv"}
    skip_suffixes = (".vtt", ".json3", ".info.json", ".jpg", ".webp", ".png", ".part", ".ytdl")
    media = [
        p
        for p in candidates
        if p.suffix.lower() in media_exts and not p.name.endswith(skip_suffixes)
    ]
    if not media:
        raise RuntimeError("Download finished but no video file was found")

    source = media[0]
    if source.suffix.lower() == ".mp4":
        if source != target:
            source.rename(target)
        return target

    # Remux / convert to mp4 with ffmpeg
    cmd = [
        "ffmpeg",
        "-y",
        "-i",
        str(source),
        "-c:v",
        "copy",
        "-c:a",
        "aac",
        "-movflags",
        "+faststart",
        str(target),
    ]
    result = run_cmd(cmd, timeout=1800)
    if result.returncode != 0 or not target.exists():
        # Fallback: re-encode video if stream copy failed
        cmd = [
            "ffmpeg",
            "-y",
            "-i",
            str(source),
            "-c:v",
            "libx264",
            "-preset",
            "fast",
            "-crf",
            "23",
            "-c:a",
            "aac",
            "-movflags",
            "+faststart",
            str(target),
        ]
        result = run_cmd(cmd, timeout=3600)
        if result.returncode != 0 or not target.exists():
            raise RuntimeError(f"ffmpeg conversion failed: {result.stderr[-800:]}")
    # Remove original non-mp4 to save space
    if source != target and source.exists():
        source.unlink(missing_ok=True)
    return target


def write_cues_json(directory: Path, youtube_id: str, cues: list[dict[str, Any]]) -> Path:
    path = directory / f"{youtube_id}.cues.json"
    path.write_text(json.dumps(cues, ensure_ascii=False, indent=2), encoding="utf-8")
    return path


def write_vtt(directory: Path, youtube_id: str, cues: list[dict[str, Any]]) -> Path:
    path = directory / f"{youtube_id}.vtt"

    def fmt(t: float) -> str:
        h = int(t // 3600)
        m = int((t % 3600) // 60)
        s = t % 60
        return f"{h:02d}:{m:02d}:{s:06.3f}"

    lines = ["WEBVTT", ""]
    for i, cue in enumerate(cues, start=1):
        lines.append(str(i))
        lines.append(f"{fmt(cue['start'])} --> {fmt(cue['end'])}")
        lines.append(cue["text"])
        lines.append("")
    path.write_text("\n".join(lines), encoding="utf-8")
    return path


def row_to_video(row: sqlite3.Row) -> VideoOut:
    youtube_id = row["youtube_id"]
    has_video = bool(row["has_video"])
    thumb = THUMBS_DIR / f"{youtube_id}.jpg"
    return VideoOut(
        id=row["id"],
        youtube_id=youtube_id,
        title=row["title"],
        duration=row["duration"],
        language=row["language"],
        status=row["status"],
        has_video=has_video,
        has_subs=bool(row["has_subs"]),
        thumbnail_url=f"/media/thumbs/{youtube_id}.jpg" if thumb.exists() else None,
        video_url=f"/media/videos/{youtube_id}/{youtube_id}.mp4" if has_video else None,
        created_at=row["created_at"],
        error=row["error"],
    )


def row_to_job(row: sqlite3.Row) -> JobOut:
    return JobOut(
        id=row["id"],
        youtube_id=row["youtube_id"],
        url=row["url"],
        status=row["status"],
        stage=row["stage"],
        message=row["message"],
        video_id=row["video_id"],
        error=row["error"],
        created_at=row["created_at"],
        updated_at=row["updated_at"],
    )


def update_job(job_id: str, **fields: Any) -> None:
    fields["updated_at"] = now_iso()
    cols = ", ".join(f"{k} = ?" for k in fields)
    values = list(fields.values()) + [job_id]
    with get_db() as conn:
        conn.execute(f"UPDATE jobs SET {cols} WHERE id = ?", values)


# ---------------------------------------------------------------------------
# Download pipeline
# ---------------------------------------------------------------------------


async def process_download(job_id: str, url: str, language: str) -> None:
    try:
        youtube_id = extract_youtube_id(url)
    except ValueError as exc:
        update_job(job_id, status="error", stage="parse", message=str(exc), error=str(exc))
        return

    update_job(
        job_id,
        youtube_id=youtube_id,
        status="running",
        stage="download",
        message="Downloading video and subtitles…",
    )

    out_dir = video_dir(youtube_id)
    # Clean previous partials for this id (keep final mp4/cues if re-download)
    for leftover in out_dir.glob("*"):
        if leftover.name.endswith((".part", ".ytdl", ".temp")):
            leftover.unlink(missing_ok=True)

    # Inside the downloader container the workdir is /out (volume-mounted).
    out_tmpl = f"/out/{youtube_id}.%(ext)s" if should_use_docker() else f"{youtube_id}.%(ext)s"
    ytdlp_args = [
        "--no-playlist",
        "--write-info-json",
        "--write-thumbnail",
        "--convert-thumbnails",
        "jpg",
        "--write-subs",
        "--write-auto-subs",
        "--sub-langs",
        f"{language}.*,en.*,en",
        "--sub-format",
        "vtt/best",
        "--embed-metadata",
        "-f",
        "bv*[ext=mp4]+ba[ext=m4a]/b[ext=mp4]/bv*+ba/b",
        "--merge-output-format",
        "mp4",
        "-o",
        out_tmpl,
        f"https://www.youtube.com/watch?v={youtube_id}",
    ]

    cmd = yt_dlp_cmd(ytdlp_args, out_dir)
    result = await asyncio.to_thread(run_cmd, cmd, out_dir if not should_use_docker() else None)

    if result.returncode != 0:
        err = (result.stderr or result.stdout or "yt-dlp failed")[-1200:]
        update_job(job_id, status="error", stage="download", message="Download failed", error=err)
        return

    update_job(job_id, stage="convert", message="Converting to MP4…")
    try:
        mp4_path = await asyncio.to_thread(ensure_mp4, out_dir, youtube_id)
    except Exception as exc:  # noqa: BLE001
        update_job(job_id, status="error", stage="convert", message="Conversion failed", error=str(exc))
        return

    update_job(job_id, stage="subs", message="Extracting and indexing subtitles…")

    title = youtube_id
    duration: float | None = None
    info_path = out_dir / f"{youtube_id}.info.json"
    if info_path.exists():
        try:
            info = json.loads(info_path.read_text(encoding="utf-8"))
            title = info.get("title") or title
            duration = info.get("duration")
        except json.JSONDecodeError:
            pass

    # Move thumbnail into thumbs dir
    for thumb_candidate in list(out_dir.glob(f"{youtube_id}*.jpg")) + list(out_dir.glob("*.jpg")):
        dest = THUMBS_DIR / f"{youtube_id}.jpg"
        shutil.move(str(thumb_candidate), dest)
        break

    cues: list[dict[str, Any]] = []
    sub_file = find_subtitle_file(out_dir, youtube_id)
    if sub_file:
        try:
            if sub_file.suffix.lower() == ".json3":
                cues = parse_json3(sub_file)
            else:
                cues = parse_vtt(sub_file)
        except Exception as exc:  # noqa: BLE001
            update_job(
                job_id,
                status="error",
                stage="subs",
                message="Subtitle parse failed",
                error=str(exc),
            )
            return

    if cues:
        write_cues_json(out_dir, youtube_id, cues)
        write_vtt(out_dir, youtube_id, cues)

    video_id = str(uuid.uuid4())
    ts = now_iso()
    with get_db() as conn:
        existing = conn.execute(
            "SELECT id FROM videos WHERE youtube_id = ?", (youtube_id,)
        ).fetchone()
        if existing:
            video_id = existing["id"]
            conn.execute("DELETE FROM cues WHERE video_id = ?", (video_id,))
            conn.execute(
                """
                UPDATE videos SET title=?, duration=?, language=?, status=?,
                       has_video=?, has_subs=?, error=NULL, updated_at=?
                WHERE id=?
                """,
                (
                    title,
                    duration,
                    language,
                    "ready",
                    1 if mp4_path.exists() else 0,
                    1 if cues else 0,
                    ts,
                    video_id,
                ),
            )
        else:
            conn.execute(
                """
                INSERT INTO videos (id, youtube_id, title, duration, language, status,
                                    has_video, has_subs, error, created_at, updated_at)
                VALUES (?, ?, ?, ?, ?, 'ready', ?, ?, NULL, ?, ?)
                """,
                (
                    video_id,
                    youtube_id,
                    title,
                    duration,
                    language,
                    1 if mp4_path.exists() else 0,
                    1 if cues else 0,
                    ts,
                    ts,
                ),
            )
        for cue in cues:
            conn.execute(
                "INSERT INTO cues (video_id, start, end, text) VALUES (?, ?, ?, ?)",
                (video_id, cue["start"], cue["end"], cue["text"]),
            )

    msg = "Ready" if cues else "Ready (no subtitles found)"
    update_job(
        job_id,
        status="done",
        stage="done",
        message=msg,
        video_id=video_id,
        error=None,
    )


# ---------------------------------------------------------------------------
# App
# ---------------------------------------------------------------------------


@asynccontextmanager
async def lifespan(_app: FastAPI):
    init_db()
    yield


app = FastAPI(title="YT Extractor", version="1.0.0", lifespan=lifespan)
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)


@app.get("/api/health")
def health() -> dict[str, Any]:
    return {
        "ok": True,
        "docker": docker_available(),
        "use_docker": should_use_docker(),
        "downloader_image": DOWNLOADER_IMAGE,
        "data_dir": str(DATA_DIR),
        "yt_dlp": shutil.which("yt-dlp") is not None,
        "ffmpeg": shutil.which("ffmpeg") is not None,
    }


@app.get("/api/videos", response_model=list[VideoOut])
def list_videos() -> list[VideoOut]:
    with get_db() as conn:
        rows = conn.execute(
            "SELECT * FROM videos ORDER BY created_at DESC"
        ).fetchall()
    return [row_to_video(r) for r in rows]


@app.get("/api/videos/{video_id}", response_model=VideoOut)
def get_video(video_id: str) -> VideoOut:
    with get_db() as conn:
        row = conn.execute("SELECT * FROM videos WHERE id = ?", (video_id,)).fetchone()
    if not row:
        raise HTTPException(404, "Video not found")
    return row_to_video(row)


@app.get("/api/videos/{video_id}/cues", response_model=list[Cue])
def get_cues(video_id: str) -> list[Cue]:
    with get_db() as conn:
        exists = conn.execute("SELECT 1 FROM videos WHERE id = ?", (video_id,)).fetchone()
        if not exists:
            raise HTTPException(404, "Video not found")
        rows = conn.execute(
            "SELECT start, end, text FROM cues WHERE video_id = ? ORDER BY start ASC",
            (video_id,),
        ).fetchall()
    return [Cue(start=r["start"], end=r["end"], text=r["text"]) for r in rows]


@app.delete("/api/videos/{video_id}")
def delete_video(video_id: str) -> dict[str, str]:
    with get_db() as conn:
        row = conn.execute("SELECT * FROM videos WHERE id = ?", (video_id,)).fetchone()
        if not row:
            raise HTTPException(404, "Video not found")
        youtube_id = row["youtube_id"]
        conn.execute("DELETE FROM videos WHERE id = ?", (video_id,))
    shutil.rmtree(VIDEOS_DIR / youtube_id, ignore_errors=True)
    (THUMBS_DIR / f"{youtube_id}.jpg").unlink(missing_ok=True)
    return {"status": "deleted"}


@app.post("/api/download", response_model=JobOut)
async def start_download(body: DownloadRequest) -> JobOut:
    try:
        youtube_id = extract_youtube_id(body.url)
    except ValueError as exc:
        raise HTTPException(400, str(exc)) from exc

    if should_use_docker():
        # Verify image exists (best-effort)
        check = await asyncio.to_thread(
            run_cmd, ["docker", "image", "inspect", DOWNLOADER_IMAGE], timeout=30
        )
        if check.returncode != 0:
            raise HTTPException(
                503,
                f"Docker downloader image '{DOWNLOADER_IMAGE}' not found. "
                "Run: docker compose build downloader",
            )
    elif not shutil.which("yt-dlp"):
        raise HTTPException(
            503,
            "yt-dlp not found and Docker unavailable. Install yt-dlp or build the downloader image.",
        )

    job_id = str(uuid.uuid4())
    ts = now_iso()
    with get_db() as conn:
        conn.execute(
            """
            INSERT INTO jobs (id, youtube_id, url, status, stage, message, video_id, error, created_at, updated_at)
            VALUES (?, ?, ?, 'queued', 'queued', 'Queued', NULL, NULL, ?, ?)
            """,
            (job_id, youtube_id, body.url.strip(), ts, ts),
        )
        row = conn.execute("SELECT * FROM jobs WHERE id = ?", (job_id,)).fetchone()

    asyncio.create_task(process_download(job_id, body.url.strip(), body.language))
    return row_to_job(row)


@app.get("/api/jobs", response_model=list[JobOut])
def list_jobs(limit: int = Query(20, ge=1, le=100)) -> list[JobOut]:
    with get_db() as conn:
        rows = conn.execute(
            "SELECT * FROM jobs ORDER BY created_at DESC LIMIT ?", (limit,)
        ).fetchall()
    return [row_to_job(r) for r in rows]


@app.get("/api/jobs/{job_id}", response_model=JobOut)
def get_job(job_id: str) -> JobOut:
    with get_db() as conn:
        row = conn.execute("SELECT * FROM jobs WHERE id = ?", (job_id,)).fetchone()
    if not row:
        raise HTTPException(404, "Job not found")
    return row_to_job(row)


@app.get("/api/search", response_model=list[SearchHit])
def search_subs(q: str = Query(..., min_length=1), limit: int = Query(50, ge=1, le=200)) -> list[SearchHit]:
    query = q.strip()
    if not query:
        return []
    # Escape FTS5 special chars lightly by quoting tokens
    tokens = re.findall(r"\w+", query, flags=re.UNICODE)
    if not tokens:
        return []
    fts_query = " ".join(f'"{t}"' for t in tokens)

    with get_db() as conn:
        rows = conn.execute(
            """
            SELECT
                cues_fts.video_id AS video_id,
                cues_fts.start AS start,
                cues_fts.end AS end,
                cues_fts.text AS text,
                snippet(cues_fts, 0, '«', '»', '…', 12) AS snippet,
                videos.youtube_id AS youtube_id,
                videos.title AS title
            FROM cues_fts
            JOIN videos ON videos.id = cues_fts.video_id
            WHERE cues_fts MATCH ?
            ORDER BY rank
            LIMIT ?
            """,
            (fts_query, limit),
        ).fetchall()

    return [
        SearchHit(
            video_id=r["video_id"],
            youtube_id=r["youtube_id"],
            title=r["title"],
            start=r["start"],
            end=r["end"],
            text=r["text"],
            snippet=r["snippet"],
        )
        for r in rows
    ]


# Media serving with range support via FileResponse
@app.get("/media/videos/{youtube_id}/{filename}")
def serve_video(youtube_id: str, filename: str):
    path = VIDEOS_DIR / youtube_id / filename
    if not path.exists() or not path.is_file():
        raise HTTPException(404, "File not found")
    media_type = "video/mp4" if filename.endswith(".mp4") else "application/octet-stream"
    return FileResponse(path, media_type=media_type, filename=filename)


@app.get("/media/thumbs/{filename}")
def serve_thumb(filename: str):
    path = THUMBS_DIR / filename
    if not path.exists():
        raise HTTPException(404, "Thumbnail not found")
    return FileResponse(path, media_type="image/jpeg")


@app.get("/media/videos/{youtube_id}/subs.vtt")
def serve_vtt(youtube_id: str):
    path = VIDEOS_DIR / youtube_id / f"{youtube_id}.vtt"
    if not path.exists():
        raise HTTPException(404, "Subtitles not found")
    return FileResponse(path, media_type="text/vtt")


# Static frontend
if FRONTEND_DIR.exists():
    app.mount("/assets", StaticFiles(directory=FRONTEND_DIR), name="assets")


@app.get("/", response_class=HTMLResponse)
def index_page() -> HTMLResponse:
    index = FRONTEND_DIR / "index.html"
    if not index.exists():
        return HTMLResponse("<h1>YT Extractor</h1><p>Frontend missing.</p>")
    return HTMLResponse(index.read_text(encoding="utf-8"))


@app.get("/watch/{video_id}", response_class=HTMLResponse)
def watch_page(video_id: str) -> HTMLResponse:
    # SPA-style: same shell, client routes
    index = FRONTEND_DIR / "index.html"
    return HTMLResponse(index.read_text(encoding="utf-8"))
