from __future__ import annotations

from app.playback import playback_kind


def normalize_folder(folder: str) -> str:
    parts: list[str] = []
    for part in folder.replace("\\", "/").split("/"):
        if part in ("", "."):
            continue
        if part == "..":
            raise ValueError("Некорректный путь")
        parts.append(part)
    return "/".join(parts)


def public_video(row: dict, mounted: set[str]) -> dict:
    rel_path = row["rel_path"]
    folder = rel_path.rsplit("/", 1)[0] if "/" in rel_path else ""
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
        "available": row["volume_name"] in mounted,
        "playback": playback_kind(row["ext"]),
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
