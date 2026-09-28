from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path

import yaml


@dataclass(frozen=True)
class Volume:
    name: str
    path: str


@dataclass(frozen=True)
class Config:
    host: str
    port: int
    scan_interval_minutes: int
    database: str
    volumes: tuple[Volume, ...]
    ffmpeg: str
    ffprobe: str


def load_config(path: str | Path) -> Config:
    file = Path(path)
    if not file.is_file():
        raise FileNotFoundError(
            f"Нет файла настройки {file}. Скопируйте config.example.yaml в config.yaml."
        )
    with file.open(encoding="utf-8") as handle:
        raw = yaml.safe_load(handle) or {}
    if not isinstance(raw, dict):
        raise ValueError("Файл настройки должен быть словарём.")

    items = raw.get("volumes") or []
    if not isinstance(items, list) or not items:
        raise ValueError("В настройке нужен хотя бы один том.")

    volumes: list[Volume] = []
    names: set[str] = set()
    for item in items:
        if not isinstance(item, dict):
            raise ValueError("Том в настройке должен быть словарём с полями name и path.")
        name = str(item.get("name", "")).strip()
        folder = str(item.get("path", "")).strip()
        if not name or not folder:
            raise ValueError("У каждого тома должны быть имя и путь.")
        if name in names:
            raise ValueError(f"Том «{name}» указан дважды.")
        names.add(name)
        volumes.append(Volume(name=name, path=folder))

    interval = int(raw.get("scan_interval_minutes", 15))
    if interval < 1:
        interval = 1

    return Config(
        host=str(raw.get("host", "0.0.0.0")),
        port=int(raw.get("port", 8080)),
        scan_interval_minutes=interval,
        database=str(raw.get("database", "data/catalog.db")),
        volumes=tuple(volumes),
        ffmpeg=str(raw.get("ffmpeg", "ffmpeg")),
        ffprobe=str(raw.get("ffprobe", "ffprobe")),
    )
