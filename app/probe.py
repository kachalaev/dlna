from __future__ import annotations

import json
import logging
import shutil
import subprocess
from pathlib import Path

logger = logging.getLogger(__name__)

EMPTY_PROBE = {
    "probe_state": "failed",
    "duration": None,
    "width": None,
    "height": None,
    "video_codec": None,
    "audio_codec": None,
    "audio_tracks": [],
}


def probe_file(path: str, ffprobe: str) -> dict:
    if shutil.which(ffprobe) is None and not Path(ffprobe).is_file():
        return dict(EMPTY_PROBE)
    command = [
        ffprobe,
        "-v",
        "error",
        "-probesize",
        "5000000",
        "-analyzeduration",
        "5000000",
        "-show_entries",
        "format=duration:stream=codec_type,codec_name,width,height:stream_tags=language,title",
        "-of",
        "json",
        path,
    ]
    try:
        completed = subprocess.run(
            command,
            capture_output=True,
            timeout=20,
            check=False,
        )
    except (OSError, subprocess.TimeoutExpired):
        logger.warning("ffprobe не ответил для %s", Path(path).name)
        return dict(EMPTY_PROBE)
    if completed.returncode != 0:
        return dict(EMPTY_PROBE)
    try:
        payload = json.loads(completed.stdout.decode("utf-8"))
    except (UnicodeDecodeError, json.JSONDecodeError):
        return dict(EMPTY_PROBE)
    return parse_probe(payload)


def parse_probe(payload: dict) -> dict:
    duration = None
    raw_duration = (payload.get("format") or {}).get("duration")
    if raw_duration is not None:
        try:
            duration = float(raw_duration)
        except (TypeError, ValueError):
            duration = None
    video_codec = None
    audio_codec = None
    width = None
    height = None
    audio_tracks: list[dict] = []
    for stream in payload.get("streams") or []:
        if stream.get("codec_type") == "video" and video_codec is None:
            video_codec = stream.get("codec_name")
            width = stream.get("width")
            height = stream.get("height")
        elif stream.get("codec_type") == "audio":
            tags = stream.get("tags") or {}
            if audio_codec is None:
                audio_codec = stream.get("codec_name")
            audio_tracks.append(
                {
                    "index": len(audio_tracks),
                    "language": str(tags.get("language") or ""),
                    "title": str(tags.get("title") or ""),
                    "codec": str(stream.get("codec_name") or ""),
                }
            )
    return {
        "probe_state": "ok",
        "duration": duration,
        "width": width,
        "height": height,
        "video_codec": video_codec,
        "audio_codec": audio_codec,
        "audio_tracks": audio_tracks,
    }
