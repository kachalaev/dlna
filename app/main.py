from __future__ import annotations

import asyncio
import logging
import math
import shutil
import subprocess
import threading
import time
from contextlib import asynccontextmanager
from pathlib import Path
from typing import Optional

from fastapi import FastAPI, HTTPException, Query
from fastapi.responses import FileResponse, JSONResponse, Response, StreamingResponse
from fastapi.staticfiles import StaticFiles

from app.config import Config, Volume
from app.db import Catalog
from app.listing import build_listing, normalize_folder, public_video, search_videos
from app.hls import HlsHub
from app.playback import (
    audio_media_type,
    chosen_height,
    ffmpeg_hls_command,
    ffmpeg_remux_command,
    path_inside,
    playback_kind,
    rewrite_hls_playlist,
    serve_original,
)
from app.probe import probe_file
from app.scanner import Scanner

logger = logging.getLogger(__name__)

PACKAGE_ROOT = Path(__file__).resolve().parent.parent
STATIC_DIR = PACKAGE_ROOT / "static"


class ScanCoordinator:
    def __init__(self, scanner: Scanner):
        self._scanner = scanner
        self._lock = threading.Lock()

    def try_start(self) -> bool:
        if not self._lock.acquire(blocking=False):
            return False
        self._scanner.catalog.mark_scan_started()

        def run() -> None:
            try:
                self._scanner.scan()
            finally:
                self._lock.release()

        threading.Thread(target=run, daemon=True).start()
        return True


def create_app(config: Config, *, schedule: bool = True, probe=None) -> FastAPI:
    catalog = Catalog(config.database)
    volumes = {volume.name: volume for volume in config.volumes}

    def default_probe(path: str) -> dict:
        return probe_file(path, config.ffprobe)

    scanner = Scanner(catalog, config.volumes, probe or default_probe)
    coordinator = ScanCoordinator(scanner)
    hls = HlsHub()

    @asynccontextmanager
    async def lifespan(app: FastAPI):
        stop = threading.Event()
        hls.start()
        if schedule:
            interval = config.scan_interval_minutes * 60

            def loop() -> None:
                while not stop.is_set():
                    coordinator.try_start()
                    if stop.wait(interval):
                        break

            threading.Thread(target=loop, daemon=True).start()
        yield
        stop.set()
        hls.close()

    app = FastAPI(lifespan=lifespan)
    app.state.catalog = catalog
    app.state.scanner = scanner
    app.state.coordinator = coordinator
    app.state.hls = hls

    def mounted() -> set[str]:
        return catalog.mounted_names()

    def volume_for(row: dict) -> Volume:
        try:
            return volumes[row["volume_name"]]
        except KeyError as exc:
            raise HTTPException(status_code=404, detail="Файл сейчас недоступен") from exc

    @app.get("/api/status")
    def status() -> dict:
        return catalog.status()

    @app.post("/api/scan")
    def start_scan():
        started = coordinator.try_start()
        return JSONResponse({"scanning": True, "started": started}, status_code=202)

    @app.get("/api/browse")
    def browse(path: str = "") -> dict:
        try:
            folder = normalize_folder(path)
        except ValueError as exc:
            raise HTTPException(status_code=400, detail=str(exc)) from exc
        return build_listing(catalog.list_videos(), catalog.list_directories(), folder, mounted())

    @app.get("/api/search")
    def search(q: str = "") -> dict:
        query = q.strip()
        if not query:
            return {"files": [], "truncated": False}
        return search_videos(catalog.list_videos(), query, mounted())

    @app.get("/api/videos/{video_id}")
    def video_detail(video_id: int) -> dict:
        row = catalog.get_video(video_id)
        if row is None:
            raise HTTPException(status_code=404, detail="Файл не найден")
        return public_video(row, mounted())

    @app.get("/api/videos/{video_id}/stream")
    async def stream(
        video_id: int,
        t: float = Query(0),
        a: Optional[int] = Query(None),
        h: Optional[int] = Query(None),
    ):
        row = catalog.get_video(video_id)
        if row is None:
            raise HTTPException(status_code=404, detail="Файл не найден")
        kind = playback_kind(row["ext"])
        if kind == "none":
            raise HTTPException(status_code=415, detail="Просмотр этого формата в браузере недоступен")
        volume = volume_for(row)
        media = Path(row["abs_path"])
        if not path_inside(Path(volume.path), media):
            raise HTTPException(status_code=404, detail="Файл сейчас недоступен")
        if kind == "audio":
            return FileResponse(
                media,
                media_type=audio_media_type(row["ext"]),
                headers={"Cache-Control": "no-store"},
            )
        if serve_original(kind, a, row["height"], h):
            return FileResponse(
                media,
                media_type="video/mp4",
                headers={"Cache-Control": "no-store"},
            )
        audio, start = _audio_and_start(a, t, row["duration"])
        height = chosen_height(row["height"], h)
        prepared = _require_ffmpeg(config.ffmpeg)
        process, first, stderr = await _start_ffmpeg(
            ffmpeg_remux_command(prepared, str(media), start, "libx264", audio, height)
        )
        if process is None or not first:
            raise HTTPException(status_code=500, detail="Не удалось подготовить видео для браузера")
        return StreamingResponse(
            _ffmpeg_chunks(process, first, stderr),
            media_type="video/mp4",
            headers={"Cache-Control": "no-store"},
        )

    @app.get("/api/videos/{video_id}/hls.m3u8")
    async def hls_playlist(
        video_id: int,
        t: float = Query(0),
        a: Optional[int] = Query(None),
        h: Optional[int] = Query(None),
    ):
        row, media = _playable_row(video_id)
        kind = playback_kind(row["ext"])
        if kind == "audio" or serve_original(kind, a, row["height"], h):
            raise HTTPException(status_code=404, detail="Для этого файла поток HLS не нужен")
        audio, start = _audio_and_start(a, t, row["duration"])
        height = chosen_height(row["height"], h)
        prepared = _require_ffmpeg(config.ffmpeg)
        key = f"{video_id}:{start:.3f}:{audio}:{height}"

        def command_for(directory: Path):
            return ffmpeg_hls_command(prepared, str(media), start, directory, "libx264", audio, height)

        session = hls.open_session(video_id, key, command_for)
        if not await _wait_hls(session):
            session.log_failure()
            raise HTTPException(status_code=500, detail="Не удалось подготовить видео для браузера")
        base = f"/api/videos/{video_id}/hls/{session.token}/"
        return Response(
            rewrite_hls_playlist(session.playlist_text(), base),
            media_type="application/vnd.apple.mpegurl",
            headers={"Cache-Control": "no-store"},
        )

    @app.get("/api/videos/{video_id}/hls/{token}/{name}")
    async def hls_segment(video_id: int, token: str, name: str):
        if not _safe_segment_name(name):
            raise HTTPException(status_code=404, detail="Фрагмент не найден")
        session = hls.find(token)
        if session is None or session.video_id != video_id:
            raise HTTPException(status_code=404, detail="Фрагмент не найден")
        path = session.directory / name
        for _ in range(40):
            if path.is_file():
                return FileResponse(path, media_type="video/MP2T", headers={"Cache-Control": "no-store"})
            if session.process.poll() is not None:
                break
            await asyncio.sleep(0.25)
        raise HTTPException(status_code=404, detail="Фрагмент ещё не готов")

    def _playable_row(video_id: int):
        row = catalog.get_video(video_id)
        if row is None:
            raise HTTPException(status_code=404, detail="Файл не найден")
        kind = playback_kind(row["ext"])
        if kind == "none":
            raise HTTPException(status_code=415, detail="Просмотр этого формата в браузере недоступен")
        volume = volume_for(row)
        media = Path(row["abs_path"])
        if not path_inside(Path(volume.path), media):
            raise HTTPException(status_code=404, detail="Файл сейчас недоступен")
        return row, media

    @app.get("/")
    def index() -> FileResponse:
        return FileResponse(STATIC_DIR / "index.html", headers={"Cache-Control": "no-cache"})

    @app.get("/watch/{video_id}")
    def watch_page(video_id: int) -> FileResponse:
        return FileResponse(STATIC_DIR / "index.html", headers={"Cache-Control": "no-cache"})

    app.mount("/static", StaticFiles(directory=STATIC_DIR), name="static")
    return app


def _audio_and_start(audio_index: Optional[int], start: float, duration) -> tuple[int, float]:
    audio = 0 if audio_index is None or audio_index < 0 else min(audio_index, 31)
    if not math.isfinite(start) or start < 0:
        start = 0
    if duration and start > duration:
        start = duration
    return audio, start


def _require_ffmpeg(ffmpeg: str) -> str:
    if shutil.which(ffmpeg) is None and not Path(ffmpeg).is_file():
        raise HTTPException(status_code=503, detail="На сервере не найден ffmpeg")
    return ffmpeg


def _safe_segment_name(name: str) -> bool:
    if len(name) > 32 or not name.startswith("seg") or not name.endswith(".ts"):
        return False
    return name[3:-3].isdigit()


async def _wait_hls(session, timeout: float = 45) -> bool:
    deadline = time.time() + timeout
    while time.time() < deadline:
        if session.playlist_ready():
            return True
        if session.process.poll() is not None:
            return session.playlist_ready()
        await asyncio.sleep(0.25)
    return False


async def _call(func, *args):
    # asyncio.to_thread есть только с Python 3.9, на Mac стоит 3.8.
    loop = asyncio.get_running_loop()
    return await loop.run_in_executor(None, func, *args)


def _popen_ffmpeg(command: list[str]) -> subprocess.Popen:
    return subprocess.Popen(
        command,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        stdin=subprocess.DEVNULL,
    )


async def _start_ffmpeg(command: list[str]):
    process = await _call(_popen_ffmpeg, command)
    assert process.stdout is not None and process.stderr is not None
    loop = asyncio.get_running_loop()
    stderr = loop.run_in_executor(None, process.stderr.read)
    first = await _call(process.stdout.read, 64 * 1024)
    if first:
        return process, first, stderr
    error = await stderr
    if process.poll() is None:
        process.kill()
    await _call(process.wait)
    if error:
        logger.error("ffmpeg: %s", error.decode("utf-8", "replace")[-2000:])
    return None, b"", None


async def _ffmpeg_chunks(process: subprocess.Popen, first: bytes, stderr):
    try:
        yield first
        assert process.stdout is not None
        while True:
            chunk = await _call(process.stdout.read, 256 * 1024)
            if not chunk:
                break
            yield chunk
    finally:
        if process.poll() is None:
            process.kill()
        await _call(process.wait)
        if stderr is not None:
            error = await stderr
            if error:
                logger.error("ffmpeg: %s", error.decode("utf-8", "replace")[-2000:])
