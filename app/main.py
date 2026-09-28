from __future__ import annotations

import asyncio
import logging
import math
import shutil
import subprocess
import threading
from contextlib import asynccontextmanager
from pathlib import Path

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
        return build_listing(catalog.list_videos(), folder, mounted())

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
    async def stream(video_id: int, t: float = Query(0)):
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
        if kind == "direct":
            return FileResponse(
                media,
                media_type="video/mp4",
                headers={"Cache-Control": "no-store"},
            )
        if not math.isfinite(t) or t < 0:
            t = 0
        duration = row["duration"]
        if duration and t > duration:
            t = duration
        ffmpeg = config.ffmpeg
        if shutil.which(ffmpeg) is None and not Path(ffmpeg).is_file():
            raise HTTPException(status_code=503, detail="На сервере не найден ffmpeg")
        command = ffmpeg_remux_command(ffmpeg, str(media), t)
        return StreamingResponse(_ffmpeg_chunks(command), media_type="video/mp4", headers={"Cache-Control": "no-store"})

    @app.get("/")
    def index() -> FileResponse:
        return FileResponse(STATIC_DIR / "index.html")

    @app.get("/watch/{video_id}")
    def watch_page(video_id: int) -> FileResponse:
        return FileResponse(STATIC_DIR / "index.html")

    app.mount("/static", StaticFiles(directory=STATIC_DIR), name="static")
    return app


async def _ffmpeg_chunks(command: list[str]):
    process = await asyncio.to_thread(
        subprocess.Popen,
        command,
        stdout=subprocess.PIPE,
        stderr=subprocess.DEVNULL,
        stdin=subprocess.DEVNULL,
    )
    try:
        assert process.stdout is not None
        while True:
            chunk = await asyncio.to_thread(process.stdout.read, 256 * 1024)
            if not chunk:
                break
            yield chunk
    finally:
        if process.poll() is None:
            process.kill()
        await asyncio.to_thread(process.wait)
