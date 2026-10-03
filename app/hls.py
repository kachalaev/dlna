from __future__ import annotations

import logging
import shutil
import subprocess
import tempfile
import threading
import time
import uuid
from pathlib import Path

logger = logging.getLogger(__name__)

IDLE_SECONDS = 90


class HlsSession:
    def __init__(self, video_id: int, key: str, directory: Path, process: subprocess.Popen):
        self.video_id = video_id
        self.key = key
        self.token = uuid.uuid4().hex
        self.directory = directory
        self.process = process
        self.last_access = time.time()
        self._stopped = False
        self._stop_lock = threading.Lock()
        self._errors: list[bytes] = []
        threading.Thread(target=self._drain, daemon=True).start()

    def touch(self) -> None:
        self.last_access = time.time()

    def playlist_ready(self) -> bool:
        playlist = self.directory / "index.m3u8"
        if not playlist.is_file():
            return False
        try:
            text = playlist.read_text(encoding="utf-8", errors="replace")
        except OSError:
            return False
        for line in text.splitlines():
            stripped = line.strip()
            if not stripped.endswith(".ts"):
                continue
            path = self.directory / Path(stripped).name
            try:
                if path.is_file() and path.stat().st_size > 0:
                    return True
            except OSError:
                return False
        return False

    def playlist_text(self) -> str:
        return (self.directory / "index.m3u8").read_text(encoding="utf-8", errors="replace")

    def log_failure(self) -> None:
        if not self._errors:
            return
        logger.error("ffmpeg: %s", self._errors[-1].decode("utf-8", "replace")[-2000:])

    def stop(self) -> None:
        with self._stop_lock:
            if self._stopped:
                return
            self._stopped = True
            if self.process.poll() is None:
                self.process.kill()
            try:
                self.process.wait(timeout=5)
            except subprocess.TimeoutExpired:
                pass
            shutil.rmtree(self.directory, ignore_errors=True)

    def _drain(self) -> None:
        if self.process.stderr is None:
            return
        data = self.process.stderr.read()
        if data:
            self._errors.append(data)


class HlsHub:
    def __init__(self):
        self._lock = threading.Lock()
        self._by_key: dict[str, HlsSession] = {}
        self._by_token: dict[str, HlsSession] = {}
        self._stop = threading.Event()
        self._thread = None

    def start(self) -> None:
        self._thread = threading.Thread(target=self._reap_loop, daemon=True)
        self._thread.start()

    def close(self) -> None:
        self._stop.set()
        with self._lock:
            sessions = list(self._by_key.values())
            self._by_key.clear()
            self._by_token.clear()
        for session in sessions:
            session.stop()

    def open_session(self, video_id: int, key: str, command_for) -> HlsSession:
        with self._lock:
            current = self._by_key.get(key)
            if current is not None and (current.process.poll() is None or current.playlist_ready()):
                current.touch()
                return current
            if current is not None:
                self._drop(current)
            for old in [item for item in self._by_key.values() if item.video_id == video_id]:
                self._drop(old)
            directory = Path(tempfile.mkdtemp(prefix="dlna-hls-"))
            try:
                command = command_for(directory)
                process = subprocess.Popen(
                    command,
                    stdout=subprocess.DEVNULL,
                    stderr=subprocess.PIPE,
                    stdin=subprocess.DEVNULL,
                )
            except OSError:
                shutil.rmtree(directory, ignore_errors=True)
                raise
            session = HlsSession(video_id, key, directory, process)
            self._by_key[key] = session
            self._by_token[session.token] = session
            return session

    def find(self, token: str):
        with self._lock:
            session = self._by_token.get(token)
        if session is not None:
            session.touch()
        return session

    def _drop(self, session: HlsSession) -> None:
        self._by_key.pop(session.key, None)
        self._by_token.pop(session.token, None)
        session.stop()

    def _reap_loop(self) -> None:
        while not self._stop.wait(10):
            now = time.time()
            stale: list[HlsSession] = []
            with self._lock:
                for session in list(self._by_key.values()):
                    if now - session.last_access > IDLE_SECONDS:
                        stale.append(session)
                        self._by_key.pop(session.key, None)
                        self._by_token.pop(session.token, None)
            for session in stale:
                session.stop()
