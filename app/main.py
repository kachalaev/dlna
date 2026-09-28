from __future__ import annotations

import asyncio
import logging
import math
import shutil
import subprocess
import threading
from contextlib import asynccontextmanager
from pathlib import Path
from typing import Optional

from fastapi import FastAPI, HTTPException, Query
from fastapi.responses import FileResponse, JSONResponse, StreamingResponse
from fastapi.staticfiles import StaticFiles

from app.config import Config, Volume
from app.db import Catalog
from app.listing import build_listing, normalize_folder, public_video, search_videos
from app.playback import ffmpeg_remux_command, path_inside, playback_kind
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

    @asynccontextmanager
    async def lifespan(app: FastAPI):
        stop = threading.Event()
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

    app = FastAPI(lifespan=lifespan)
    app.state.catalog = catalog
    app.state.scanner = scanner
    app.state.coordinator = coordinator

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
    async def stream(video_id: int, t: float = Query(0), a: Optional[int] = Query(None)):
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
        if kind == "direct" and a is None:
            return FileResponse(
                media,
                media_type="video/mp4",
                headers={"Cache-Control": "no-store"},
            )
        audio = 0 if a is None or a < 0 else min(a, 31)
        if not math.isfinite(t) or t < 0:
            t = 0
        duration = row["duration"]
        if duration and t > duration:
            t = duration
        ffmpeg = config.ffmpeg
        if shutil.which(ffmpeg) is None and not Path(ffmpeg).is_file():
            raise HTTPException(status_code=503, detail="На сервере не найден ffmpeg")
        process, first, stderr = await _start_ffmpeg(
            ffmpeg_remux_command(ffmpeg, str(media), t, "libx264", audio)
        )
        if process is None or not first:
            raise HTTPException(status_code=500, detail="Не удалось подготовить видео для браузера")
        return StreamingResponse(
            _ffmpeg_chunks(process, first, stderr),
            media_type="video/mp4",
            headers={"Cache-Control": "no-store"},
        )

    @app.get("/")
    def index() -> FileResponse:
        return FileResponse(STATIC_DIR / "index.html", headers={"Cache-Control": "no-cache"})

    @app.get("/watch/{video_id}")
    def watch_page(video_id: int) -> FileResponse:
        return FileResponse(STATIC_DIR / "index.html", headers={"Cache-Control": "no-cache"})

    app.mount("/static", StaticFiles(directory=STATIC_DIR), name="static")
    return app


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
