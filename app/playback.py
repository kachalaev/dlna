from __future__ import annotations

import os
from pathlib import Path


_QUALITY_STEPS = (360, 480, 720, 1080, 1440, 2160)
_AUDIO_TYPES = {
    "mp3": "audio/mpeg",
    "m4a": "audio/mp4",
    "aac": "audio/aac",
    "wav": "audio/wav",
    "flac": "audio/flac",
    "ogg": "audio/ogg",
    "opus": "audio/ogg",
}
AUDIO_EXTENSIONS = frozenset(_AUDIO_TYPES)


def playback_kind(ext: str) -> str:
    if ext in AUDIO_EXTENSIONS:
        return "audio"
    if ext == "mp4":
        return "direct"
    if ext in {"mkv", "avi"}:
        return "remux"
    return "none"


def audio_media_type(ext: str) -> str:
    return _AUDIO_TYPES.get(ext, "application/octet-stream")


def quality_options(source_height) -> list:
    # Ступени не выше файла. Верхняя — его собственная чётная высота.
    try:
        height = int(source_height)
    except (TypeError, ValueError):
        height = 0
    if height <= 0:
        return [720]
    even = height - (height % 2)
    if even < 2:
        return [720]
    options = [step for step in _QUALITY_STEPS if step < even]
    options.append(even)
    return options


def chosen_height(source_height, requested) -> int:
    options = quality_options(source_height)
    if requested is None:
        return options[-1]
    try:
        value = int(requested)
    except (TypeError, ValueError):
        return options[-1]
    if value <= 0:
        return options[-1]
    lower = [item for item in options if item <= value]
    return lower[-1] if lower else options[0]


def serve_original(kind: str, audio_index, source_height, requested) -> bool:
    # MP4 без выбора дорожки и без снижения высоты отдаётся файлом как есть.
    if kind != "direct" or audio_index is not None:
        return False
    if requested is None:
        return True
    return chosen_height(source_height, requested) == quality_options(source_height)[-1]


def _scale_filter(height: int) -> str:
    return f"scale=-2:min({int(height)}\\,ih)"


def _h264_level(height: int) -> str:
    if height <= 1080:
        return "4.0"
    if height <= 1440:
        return "5.0"
    return "5.1"


def ffmpeg_remux_command(
    ffmpeg: str,
    path: str,
    start: float,
    encoder: str = "libx264",
    audio_index: int = 0,
    height: int = 720,
) -> list[str]:
    # MacBook Pro A1502 не декодирует HEVC аппаратно. VideoToolbox только
    # замедляет. Высоту выбирает зритель, но не выше самого файла.
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
        _scale_filter(height),
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
    height: int = 720,
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
        _scale_filter(height),
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
        _h264_level(height),
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
