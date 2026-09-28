from __future__ import annotations

import json
import sqlite3
import threading
from datetime import datetime, timezone
from pathlib import Path


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


class Catalog:
    def __init__(self, path: str | Path):
        database = Path(path)
        database.parent.mkdir(parents=True, exist_ok=True)
        self._lock = threading.Lock()
        self._conn = sqlite3.connect(database, check_same_thread=False)
        self._conn.row_factory = sqlite3.Row
        with self._lock:
            self._conn.execute("PRAGMA journal_mode=WAL")
            self._conn.execute("PRAGMA busy_timeout=5000")
            self._conn.executescript(
                """
                CREATE TABLE IF NOT EXISTS videos (
                    id INTEGER PRIMARY KEY,
                    volume_name TEXT NOT NULL,
                    abs_path TEXT NOT NULL UNIQUE,
                    rel_path TEXT NOT NULL,
                    name TEXT NOT NULL,
                    ext TEXT NOT NULL,
                    size INTEGER NOT NULL,
                    mtime_ns INTEGER NOT NULL,
                    duration REAL,
                    width INTEGER,
                    height INTEGER,
                    video_codec TEXT,
                    audio_codec TEXT,
                    probe_state TEXT NOT NULL,
                    scan_token TEXT NOT NULL
                );
                CREATE INDEX IF NOT EXISTS idx_videos_volume ON videos(volume_name);

                CREATE TABLE IF NOT EXISTS directories (
                    volume_name TEXT NOT NULL,
                    rel_path TEXT NOT NULL,
                    scan_token TEXT NOT NULL,
                    PRIMARY KEY (volume_name, rel_path)
                );

                CREATE TABLE IF NOT EXISTS volume_state (
                    name TEXT PRIMARY KEY,
                    path TEXT NOT NULL,
                    mounted INTEGER NOT NULL,
                    last_error TEXT
                );

                CREATE TABLE IF NOT EXISTS scan_status (
                    id INTEGER PRIMARY KEY CHECK (id = 1),
                    scanning INTEGER NOT NULL,
                    started_at TEXT,
                    finished_at TEXT,
                    files_seen INTEGER NOT NULL,
                    error TEXT
                );
                INSERT OR IGNORE INTO scan_status (id, scanning, files_seen)
                VALUES (1, 0, 0);
                UPDATE scan_status SET scanning = 0 WHERE id = 1;
                """
            )
            columns = {row[1] for row in self._conn.execute("PRAGMA table_info(videos)")}
            if "audio_tracks" not in columns:
                self._conn.execute("ALTER TABLE videos ADD COLUMN audio_tracks TEXT")
            self._conn.commit()

    def retire_volumes(self, names: set[str]) -> None:
        with self._lock:
            if names:
                marks = ",".join("?" for _ in names)
                self._conn.execute(
                    f"DELETE FROM videos WHERE volume_name NOT IN ({marks})",
                    tuple(names),
                )
                self._conn.execute(
                    f"DELETE FROM directories WHERE volume_name NOT IN ({marks})",
                    tuple(names),
                )
                self._conn.execute(
                    f"DELETE FROM volume_state WHERE name NOT IN ({marks})",
                    tuple(names),
                )
            else:
                self._conn.execute("DELETE FROM videos")
                self._conn.execute("DELETE FROM directories")
                self._conn.execute("DELETE FROM volume_state")
            self._conn.commit()

    def set_volume_state(self, name: str, path: str, mounted: bool, error: str | None) -> None:
        with self._lock:
            self._conn.execute(
                """
                INSERT INTO volume_state (name, path, mounted, last_error)
                VALUES (?, ?, ?, ?)
                ON CONFLICT(name) DO UPDATE SET
                    path = excluded.path,
                    mounted = excluded.mounted,
                    last_error = excluded.last_error
                """,
                (name, path, 1 if mounted else 0, error),
            )
            self._conn.commit()

    def upsert_video(
        self,
        *,
        volume_name: str,
        abs_path: str,
        rel_path: str,
        name: str,
        ext: str,
        size: int,
        mtime_ns: int,
        scan_token: str,
    ) -> tuple[int, bool]:
        with self._lock:
            row = self._conn.execute(
                "SELECT id, size, mtime_ns, probe_state, audio_tracks FROM videos WHERE abs_path = ?",
                (abs_path,),
            ).fetchone()
            if (
                row
                and row["size"] == size
                and row["mtime_ns"] == mtime_ns
                and row["probe_state"] in ("ok", "failed")
            ):
                self._conn.execute(
                    """
                    UPDATE videos
                    SET scan_token = ?, rel_path = ?, name = ?, ext = ?, volume_name = ?
                    WHERE id = ?
                    """,
                    (scan_token, rel_path, name, ext, volume_name, row["id"]),
                )
                self._conn.commit()
                needs_tracks = row["probe_state"] == "ok" and row["audio_tracks"] is None
                return int(row["id"]), needs_tracks

            if row:
                self._conn.execute(
                    """
                    UPDATE videos
                    SET volume_name = ?, rel_path = ?, name = ?, ext = ?, size = ?, mtime_ns = ?,
                        duration = NULL, width = NULL, height = NULL,
                        video_codec = NULL, audio_codec = NULL,
                        probe_state = 'pending', scan_token = ?
                    WHERE id = ?
                    """,
                    (volume_name, rel_path, name, ext, size, mtime_ns, scan_token, row["id"]),
                )
                video_id = int(row["id"])
            else:
                cursor = self._conn.execute(
                    """
                    INSERT INTO videos (
                        volume_name, abs_path, rel_path, name, ext, size, mtime_ns,
                        probe_state, scan_token
                    ) VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', ?)
                    """,
                    (volume_name, abs_path, rel_path, name, ext, size, mtime_ns, scan_token),
                )
                video_id = int(cursor.lastrowid)
            self._conn.commit()
            return video_id, True

    def save_probe(self, video_id: int, info: dict) -> None:
        with self._lock:
            self._conn.execute(
                """
                UPDATE videos
                SET duration = ?, width = ?, height = ?, video_codec = ?, audio_codec = ?,
                    audio_tracks = ?, probe_state = ?
                WHERE id = ?
                """,
                (
                    info.get("duration"),
                    info.get("width"),
                    info.get("height"),
                    info.get("video_codec"),
                    info.get("audio_codec"),
                    json.dumps(info.get("audio_tracks") or [], ensure_ascii=False),
                    info.get("probe_state", "failed"),
                    video_id,
                ),
            )
            self._conn.commit()

    def upsert_directory(self, volume_name: str, rel_path: str, scan_token: str) -> None:
        with self._lock:
            self._conn.execute(
                """
                INSERT INTO directories (volume_name, rel_path, scan_token)
                VALUES (?, ?, ?)
                ON CONFLICT(volume_name, rel_path) DO UPDATE SET scan_token = excluded.scan_token
                """,
                (volume_name, rel_path, scan_token),
            )
            self._conn.commit()

    def prune_volume(self, volume_name: str, scan_token: str) -> None:
        with self._lock:
            self._conn.execute(
                "DELETE FROM videos WHERE volume_name = ? AND scan_token != ?",
                (volume_name, scan_token),
            )
            self._conn.execute(
                "DELETE FROM directories WHERE volume_name = ? AND scan_token != ?",
                (volume_name, scan_token),
            )
            self._conn.commit()

    def list_directories(self) -> list[dict]:
        with self._lock:
            rows = self._conn.execute(
                "SELECT volume_name, rel_path FROM directories"
            ).fetchall()
        return [dict(row) for row in rows]

    def list_videos(self) -> list[dict]:
        with self._lock:
            rows = self._conn.execute(
                """
                SELECT id, volume_name, rel_path, name, ext, size, mtime_ns, duration,
                       width, height, video_codec, audio_codec, audio_tracks
                FROM videos
                """
            ).fetchall()
        return [dict(row) for row in rows]

    def get_video(self, video_id: int) -> dict | None:
        with self._lock:
            row = self._conn.execute(
                """
                SELECT id, volume_name, abs_path, rel_path, name, ext, size, mtime_ns,
                       duration, width, height, video_codec, audio_codec, audio_tracks
                FROM videos WHERE id = ?
                """,
                (video_id,),
            ).fetchone()
        return dict(row) if row else None

    def mounted_names(self) -> set[str]:
        with self._lock:
            rows = self._conn.execute(
                "SELECT name FROM volume_state WHERE mounted = 1"
            ).fetchall()
        return {row["name"] for row in rows}

    def mark_scan_started(self) -> None:
        with self._lock:
            self._conn.execute(
                """
                UPDATE scan_status
                SET scanning = 1, started_at = ?, files_seen = 0, error = NULL
                WHERE id = 1
                """,
                (_now(),),
            )
            self._conn.commit()

    def set_files_seen(self, files_seen: int) -> None:
        with self._lock:
            self._conn.execute(
                "UPDATE scan_status SET files_seen = ? WHERE id = 1",
                (files_seen,),
            )
            self._conn.commit()

    def mark_scan_finished(self, files_seen: int, error: str | None) -> None:
        with self._lock:
            self._conn.execute(
                """
                UPDATE scan_status
                SET scanning = 0, finished_at = ?, files_seen = ?, error = ?
                WHERE id = 1
                """,
                (_now(), files_seen, error),
            )
            self._conn.commit()

    def status(self) -> dict:
        with self._lock:
            scan = dict(self._conn.execute("SELECT * FROM scan_status WHERE id = 1").fetchone())
            count = self._conn.execute("SELECT COUNT(*) AS n FROM videos").fetchone()["n"]
            offline = self._conn.execute(
                "SELECT COUNT(*) AS n FROM volume_state WHERE mounted = 0"
            ).fetchone()["n"]
        return {
            "scanning": bool(scan["scanning"]),
            "started_at": scan["started_at"],
            "finished_at": scan["finished_at"],
            "files_seen": scan["files_seen"],
            "error": scan["error"],
            "video_count": count,
            "archive_incomplete": offline > 0,
        }
