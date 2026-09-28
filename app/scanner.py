from __future__ import annotations

import logging
import os
import uuid
from pathlib import Path

from app.config import Volume
from app.db import Catalog
from app.probe import EMPTY_PROBE

logger = logging.getLogger(__name__)

VIDEO_EXTENSIONS = frozenset({"mp4", "mkv", "avi"})
_DISK_ERRNOS = frozenset({5, 6, 19, 60})


def _problem_message(errors: list[OSError]) -> str:
    if errors and all(isinstance(err, PermissionError) for err in errors):
        return "Нет доступа к архиву"
    if any(err.errno in _DISK_ERRNOS for err in errors):
        return "Диск архива не отвечает"
    return "Некоторые папки не удалось прочитать"


class Scanner:
    def __init__(self, catalog: Catalog, volumes: tuple[Volume, ...], probe):
        self.catalog = catalog
        self.volumes = volumes
        self.probe = probe
        self._files_seen = 0
        self._problem: str | None = None

    def scan(self) -> None:
        self._files_seen = 0
        self._problem = None
        self.catalog.mark_scan_started()
        try:
            self.catalog.retire_volumes({volume.name for volume in self.volumes})
            had_error = False
            pending: list[tuple[int, Path]] = []
            for volume in self.volumes:
                error, found = self._scan_volume(volume)
                had_error = error or had_error
                pending.extend(found)
            message = self._problem if had_error else None
            self.catalog.mark_scan_finished(self._files_seen, message)
            for video_id, path in pending:
                self.catalog.save_probe(video_id, self._probe_safe(path))
        except Exception:
            logger.exception("Сканирование прервано")
            self.catalog.mark_scan_finished(self._files_seen, "Не удалось обновить каталог")

    def _scan_volume(self, volume: Volume) -> tuple[bool, list[tuple[int, Path]]]:
        root = Path(volume.path)
        if not root.is_dir():
            # Отключённый том не трогаем: уже известные файлы остаются в общем дереве.
            self.catalog.set_volume_state(volume.name, volume.path, False, None)
            logger.info("Том %s не подключён, каталог по нему сохранён", volume.name)
            return False, []

        token = uuid.uuid4().hex
        errors: list[OSError] = []
        pending: list[tuple[int, Path]] = []

        def onerror(err: OSError) -> None:
            errors.append(err)
            logger.warning("Не удалось прочитать папку: %s", err)

        for dirpath, dirnames, filenames in os.walk(root, onerror=onerror, followlinks=False):
            dirnames[:] = [name for name in dirnames if not name.startswith(".")]
            for filename in filenames:
                if filename.startswith("."):
                    continue
                ext = Path(filename).suffix.lower().lstrip(".")
                if ext not in VIDEO_EXTENSIONS:
                    continue
                full = Path(dirpath) / filename
                try:
                    rel_path = full.relative_to(root).as_posix()
                    stat = full.stat()
                except (OSError, ValueError) as err:
                    if isinstance(err, OSError):
                        errors.append(err)
                    continue
                video_id, needs_probe = self.catalog.upsert_video(
                    volume_name=volume.name,
                    abs_path=str(full),
                    rel_path=rel_path,
                    name=full.name,
                    ext=ext,
                    size=stat.st_size,
                    mtime_ns=stat.st_mtime_ns,
                    scan_token=token,
                )
                self._files_seen += 1
                self.catalog.set_files_seen(self._files_seen)
                if needs_probe:
                    pending.append((video_id, full))

        if errors:
            message = _problem_message(errors)
            self._problem = message
            self.catalog.set_volume_state(volume.name, volume.path, True, message)
            return True, pending

        self.catalog.prune_volume(volume.name, token)
        self.catalog.set_volume_state(volume.name, volume.path, True, None)
        return False, pending

    def _probe_safe(self, path: Path) -> dict:
        try:
            info = self.probe(str(path))
        except Exception:
            logger.exception("Не удалось прочитать метаданные %s", path.name)
            return dict(EMPTY_PROBE)
        if not isinstance(info, dict) or "probe_state" not in info:
            return dict(EMPTY_PROBE)
        return info
