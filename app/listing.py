from __future__ import annotations

import json

from app.playback import playback_kind, quality_options

_LANGUAGES = {
    "ru": "Русский",
    "rus": "Русский",
    "en": "Английский",
    "eng": "Английский",
    "de": "Немецкий",
    "deu": "Немецкий",
    "ger": "Немецкий",
    "fr": "Французский",
    "fra": "Французский",
    "fre": "Французский",
    "es": "Испанский",
    "spa": "Испанский",
    "it": "Итальянский",
    "ita": "Итальянский",
    "ja": "Японский",
    "jpn": "Японский",
    "zh": "Китайский",
    "zho": "Китайский",
    "chi": "Китайский",
    "ko": "Корейский",
    "kor": "Корейский",
    "uk": "Украинский",
    "ukr": "Украинский",
    "pl": "Польский",
    "pol": "Польский",
    "pt": "Португальский",
    "por": "Португальский",
}


def normalize_folder(folder: str) -> str:
    parts: list[str] = []
    for part in folder.replace("\\", "/").split("/"):
        if part in ("", "."):
            continue
        if part == "..":
            raise ValueError("Некорректный путь")
        parts.append(part)
    return "/".join(parts)


def track_label(track: dict, number: int) -> str:
    language = _LANGUAGES.get(str(track.get("language") or "").lower())
    title = str(track.get("title") or "").strip()
    codec = str(track.get("codec") or "").upper()
    parts: list[str] = []
    if title:
        parts.append(title)
    if language and language.casefold() not in title.casefold():
        parts.append(language)
    if not parts:
        parts.append(f"Дорожка {number}")
    if codec:
        parts.append(codec)
    return " · ".join(parts)


def audio_tracks(raw) -> list[dict]:
    if not raw:
        return []
    try:
        data = json.loads(raw) if isinstance(raw, str) else raw
    except (TypeError, json.JSONDecodeError):
        return []
    tracks = []
    for item in data:
        if not isinstance(item, dict):
            continue
        try:
            index = int(item.get("index") or 0)
        except (TypeError, ValueError):
            index = 0
        tracks.append({"index": index, "label": track_label(item, len(tracks) + 1)})
    return tracks


def public_video(row: dict, mounted: set[str]) -> dict:
    rel_path = row["rel_path"]
    folder = rel_path.rsplit("/", 1)[0] if "/" in rel_path else ""
    kind = playback_kind(row["ext"])
    qualities = [] if kind == "audio" else list(reversed(quality_options(row.get("height"))))
    return {
        "id": row["id"],
        "name": row["name"],
        "ext": row["ext"],
        "rel_path": rel_path,
        "folder": folder,
        "size": row["size"],
        "mtime": row["mtime_ns"] / 1_000_000_000,
        "duration": row["duration"],
        "width": row["width"],
        "height": row["height"],
        "video_codec": row["video_codec"],
        "audio_codec": row["audio_codec"],
        "audio_tracks": audio_tracks(row.get("audio_tracks")),
        "available": row["volume_name"] in mounted,
        "playback": kind,
        "qualities": qualities,
    }


def build_listing(rows: list[dict], directories: list[dict], folder: str, mounted: set[str]) -> dict:
    prefix = f"{folder}/" if folder else ""
    folders: dict[str, int] = {}
    files: list[dict] = []

    def consider(rel_path: str) -> str | None:
        if prefix and not rel_path.startswith(prefix):
            return None
        rest = rel_path[len(prefix):]
        if not rest:
            return None
        return rest.split("/", 1)[0]

    for row in rows:
        rel_path = row["rel_path"]
        child = consider(rel_path)
        if child is None:
            continue
        rest = rel_path[len(prefix):]
        if "/" in rest:
            folders[child] = folders.get(child, 0) + 1
        else:
            files.append(public_video(row, mounted))
    for item in directories:
        child = consider(item["rel_path"])
        if child is not None:
            folders.setdefault(child, 0)

    folder_rows = [
        {
            "name": name,
            "path": f"{folder}/{name}" if folder else name,
            "count": count,
        }
        for name, count in folders.items()
    ]
    folder_rows.sort(key=lambda item: item["name"].casefold())
    files.sort(key=lambda item: item["name"].casefold())
    return {"path": folder, "folders": folder_rows, "files": files}


def search_videos(rows: list[dict], query: str, mounted: set[str], limit: int = 200) -> dict:
    needle = query.casefold()
    found = [
        public_video(row, mounted)
        for row in rows
        if needle in f"{row['name']} {row['rel_path']}".casefold()
    ]
    found.sort(key=lambda item: item["name"].casefold())
    return {"files": found[:limit], "truncated": len(found) > limit}
