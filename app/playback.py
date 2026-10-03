from __future__ import annotations

import os
from pathlib import Path


def playback_kind(ext: str) -> str:
    if ext == "mp4":
        return "direct"
    if ext in {"mkv", "avi"}:
        return "remux"
    return "none"


def ffmpeg_remux_command(
    ffmpeg: str,
    path: str,
    start: float,
    encoder: str = "libx264",
    audio_index: int = 0,
) -> list[str]:
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
        f"0:a:{audio_index}?",
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


def ffmpeg_hls_command(
    ffmpeg: str,
    path: str,
    start: float,
    directory: Path,
    encoder: str = "libx264",
    audio_index: int = 0,
) -> list[str]:
    # Safari на Mac и iPhone не играет непрерывный MP4 без размера файла.
    # HLS из коротких MPEG-TS они открывают сами. Профиль Main и AAC-LC
    # нужны, чтобы поток принял и старый Safari, и iPhone.
    command = [ffmpeg, "-hide_banner", "-loglevel", "error", "-nostdin"]
    if start > 0:
        command += ["-ss", f"{start:.3f}"]
    command += [
        "-i",
        path,
        "-map",
        "0:v:0",
        "-map",
        f"0:a:{audio_index}?",
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
        "-profile:v",
        "main",
        "-level",
        "4.0",
        "-g",
        "48",
        "-c:a",
        "aac",
        "-profile:a",
        "aac_low",
        "-ac",
        "2",
        "-ar",
        "48000",
        "-b:a",
        "192k",
        "-f",
        "hls",
        "-hls_time",
        "4",
        "-hls_list_size",
        "0",
        "-hls_playlist_type",
        "event",
        "-hls_flags",
        "independent_segments+temp_file",
        "-hls_segment_filename",
        str(directory / "seg%05d.ts"),
        str(directory / "index.m3u8"),
    ]
    return command


def rewrite_hls_playlist(text: str, segment_base: str) -> str:
    lines = []
    for line in text.splitlines():
        stripped = line.strip()
        if stripped and not stripped.startswith("#"):
            lines.append(segment_base + Path(stripped).name)
        else:
            lines.append(line)
    return "\n".join(lines) + "\n"


def path_inside(root: Path, candidate: Path) -> bool:
    if not root.is_dir() or not candidate.is_file():
        return False
    try:
        root_real = root.resolve()
        candidate_real = candidate.resolve()
        return os.path.commonpath([str(root_real), str(candidate_real)]) == str(root_real)
    except (OSError, ValueError):
        return False
