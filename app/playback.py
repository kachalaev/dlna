from __future__ import annotations

import os
from pathlib import Path


def playback_kind(ext: str) -> str:
    if ext == "mp4":
        return "direct"
    if ext in {"mkv", "avi"}:
        return "remux"
    return "none"


def ffmpeg_remux_command(ffmpeg: str, path: str, start: float, encoder: str = "libx264") -> list[str]:
    # MacBook Pro A1502 не декодирует HEVC аппаратно. VideoToolbox только
    # замедляет. Лёгкий программный H.264 до 720p — самый быстрый вариант.
    command = [ffmpeg, "-hide_banner", "-loglevel", "error", "-nostdin"]
    if start > 0:
        command += ["-ss", f"{start:.3f}"]
    command += [
        "-i",
        path,
        "-map",
        "0:v:0",
        "-map",
        "0:a:0?",
        "-sn",
        "-dn",
        "-vf",
        "scale=-2:min(720\\,ih)",
        "-c:v",
        encoder,
        "-preset",
        "ultrafast",
        "-tune",
        "zerolatency",
        "-crf",
        "23",
        "-pix_fmt",
        "yuv420p",
        "-g",
        "48",
    ]
    command += [
        "-c:a",
        "aac",
        "-ac",
        "2",
        "-b:a",
        "192k",
        "-f",
        "mp4",
        "-movflags",
        "frag_keyframe+empty_moov+default_base_moof",
        "pipe:1",
    ]
    return command


def path_inside(root: Path, candidate: Path) -> bool:
    if not root.is_dir() or not candidate.is_file():
        return False
    try:
        root_real = root.resolve()
        candidate_real = candidate.resolve()
        return os.path.commonpath([str(root_real), str(candidate_real)]) == str(root_real)
    except (OSError, ValueError):
        return False
