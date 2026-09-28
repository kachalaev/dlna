from __future__ import annotations

import logging
import os
import stat
import uuid
from pathlib import Path

from app.config import Volume
from app.db import Catalog
from app.probe import EMPTY_PROBE

logger = logging.getLogger(__name__)

VIDEO_EXTENSIONS = frozenset({"mp4", "mkv", "avi"})
_DISK_ERRNOS = frozenset({5, 6, 19, 60})
# Служебные папки Windows на exFAT. В них нет фильмов, а чтение даёт ошибку доступа.
_SKIP_DIRS = frozenset({"system volume information", "$recycle.bin", "recycler"})


def _walk_tree(root: Path, onerror) -> tuple[list[tuple[Path, os.stat_result]], list[str]]:
    # os.walk на macOS использует getattrlistbulk. На USB exFAT этот вызов
    # часто отвечает EPERM, хотя обычный listdir каталог читает.
    found: list[tuple[Path, os.stat_result]] = []
    directories: list[str] = []
    pending_dirs = [root]
    while pending_dirs:
        current = pending_dirs.pop()
        try:
            names = os.listdir(current)
        except OSError as err:
            onerror(err)
            continue
        for name in names:
            if name.startswith(".") or name.casefold() in _SKIP_DIRS:
                continue
            full = current / name
            try:
                info = os.lstat(full)
                rel_path = full.relative_to(root).as_posix()
            except (OSError, ValueError) as err:
                if isinstance(err, OSError):
                    onerror(err)
                continue
            if stat.S_ISLNK(info.st_mode):
                continue
            if stat.S_ISDIR(info.st_mode):
                directories.append(rel_path)
                pending_dirs.append(full)
                continue
            if not stat.S_ISREG(info.st_mode):
                continue
            if full.suffix.lower().lstrip(".") not in VIDEO_EXTENSIONS:
                continue
            found.append((full, info))
    return found, directories


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

        files, directories = _walk_tree(root, onerror)
        for rel_path in directories:
            self.catalog.upsert_directory(volume.name, rel_path, token)
        for full, info in files:
            try:
                rel_path = full.relative_to(root).as_posix()
            except ValueError:
                continue
            video_id, needs_probe = self.catalog.upsert_video(
                volume_name=volume.name,
                abs_path=str(full),
                rel_path=rel_path,
                name=full.name,
                ext=full.suffix.lower().lstrip("."),
                size=info.st_size,
                mtime_ns=info.st_mtime_ns,
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
