"""Client for importing extracted videos into the obsidian_concepts app."""

from __future__ import annotations

import json
import os
from pathlib import Path
from typing import Any
from urllib.parse import urljoin

import httpx

DEFAULT_IMPORT_PATH = "/api/videos/import"
DEFAULT_TIMEOUT = 60.0


def settings_path(data_dir: Path) -> Path:
    return data_dir / "settings.json"


def load_settings(data_dir: Path) -> dict[str, Any]:
    path = settings_path(data_dir)
    file_cfg: dict[str, Any] = {}
    if path.exists():
        try:
            file_cfg = json.loads(path.read_text(encoding="utf-8"))
        except json.JSONDecodeError:
            file_cfg = {}

    # Env vars override file so deploy/scripts can pin the URL.
    base = (
        os.environ.get("OBSIDIAN_CONCEPTS_BASE_URL")
        or file_cfg.get("obsidian_concepts_base_url")
        or ""
    ).rstrip("/")
    path_cfg = (
        os.environ.get("OBSIDIAN_CONCEPTS_IMPORT_PATH")
        or file_cfg.get("obsidian_concepts_import_path")
        or DEFAULT_IMPORT_PATH
    )
    token = (
        os.environ.get("OBSIDIAN_CONCEPTS_API_KEY")
        or file_cfg.get("obsidian_concepts_api_key")
        or ""
    )
    return {
        "obsidian_concepts_base_url": base,
        "obsidian_concepts_import_path": path_cfg,
        "obsidian_concepts_api_key": token,
        "obsidian_concepts_enabled": bool(base),
    }


def save_settings(data_dir: Path, updates: dict[str, Any]) -> dict[str, Any]:
    path = settings_path(data_dir)
    current: dict[str, Any] = {}
    if path.exists():
        try:
            current = json.loads(path.read_text(encoding="utf-8"))
        except json.JSONDecodeError:
            current = {}

    allowed = {
        "obsidian_concepts_base_url",
        "obsidian_concepts_import_path",
        "obsidian_concepts_api_key",
    }
    for key, value in updates.items():
        if key not in allowed:
            continue
        if isinstance(value, str):
            value = value.strip()
        current[key] = value

    data_dir.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(current, indent=2) + "\n", encoding="utf-8")
    return load_settings(data_dir)


def build_import_payload(
    *,
    youtube_id: str,
    title: str,
    duration: float | None,
    language: str | None,
    cues: list[dict[str, Any]],
    vtt: str | None,
    created_at: str | None,
) -> dict[str, Any]:
    """Payload sent to obsidian_concepts. Adjust path via settings if their API differs."""
    youtube_url = f"https://www.youtube.com/watch?v={youtube_id}"
    return {
        "source": "yt_extractor",
        "youtube_id": youtube_id,
        "youtube_url": youtube_url,
        "url": youtube_url,
        "title": title,
        "duration": duration,
        "language": language or "en",
        "created_at": created_at,
        "transcript": cues,
        "cues": cues,
        "vtt": vtt,
        "has_subs": bool(cues or vtt),
    }


async def import_video(data_dir: Path, payload: dict[str, Any]) -> dict[str, Any]:
    cfg = load_settings(data_dir)
    base = cfg["obsidian_concepts_base_url"]
    if not base:
        raise RuntimeError(
            "Obsidian Concepts is not configured. "
            "Set OBSIDIAN_CONCEPTS_BASE_URL or save the URL in Settings."
        )

    import_path = cfg["obsidian_concepts_import_path"] or DEFAULT_IMPORT_PATH
    if not import_path.startswith("/"):
        import_path = "/" + import_path
    url = urljoin(base + "/", import_path.lstrip("/"))

    headers = {"Content-Type": "application/json", "Accept": "application/json"}
    token = cfg.get("obsidian_concepts_api_key") or ""
    if token:
        headers["Authorization"] = f"Bearer {token}"

    async with httpx.AsyncClient(timeout=DEFAULT_TIMEOUT) as client:
        response = await client.post(url, json=payload, headers=headers)

    body: Any
    try:
        body = response.json()
    except Exception:  # noqa: BLE001
        body = {"raw": response.text[:2000]}

    if response.status_code >= 400:
        detail = body.get("detail") if isinstance(body, dict) else body
        raise RuntimeError(
            f"Obsidian Concepts returned HTTP {response.status_code}: {detail}"
        )

    return {
        "ok": True,
        "status_code": response.status_code,
        "url": url,
        "response": body,
    }


async def probe(data_dir: Path) -> dict[str, Any]:
    """Best-effort reachability check against the configured base URL."""
    cfg = load_settings(data_dir)
    base = cfg["obsidian_concepts_base_url"]
    if not base:
        return {"configured": False, "reachable": False}

    headers = {"Accept": "application/json"}
    token = cfg.get("obsidian_concepts_api_key") or ""
    if token:
        headers["Authorization"] = f"Bearer {token}"

    checked: list[str] = []
    async with httpx.AsyncClient(timeout=5.0) as client:
        for path in ("/api/health", "/health", "/openapi.json", "/"):
            url = urljoin(base + "/", path.lstrip("/"))
            checked.append(url)
            try:
                res = await client.get(url, headers=headers)
                if res.status_code < 500:
                    return {
                        "configured": True,
                        "reachable": True,
                        "probe_url": url,
                        "status_code": res.status_code,
                        "base_url": base,
                        "import_path": cfg["obsidian_concepts_import_path"],
                    }
            except httpx.HTTPError:
                continue

    return {
        "configured": True,
        "reachable": False,
        "base_url": base,
        "import_path": cfg["obsidian_concepts_import_path"],
        "checked": checked,
    }
