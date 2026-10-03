from __future__ import annotations

import os
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from app.config import Config, Volume, load_config
from app.main import create_app
from app.playback import ffmpeg_hls_command, ffmpeg_remux_command, playback_kind, rewrite_hls_playlist
from app.probe import parse_probe


def fake_probe(path: str) -> dict:
    return {
        "probe_state": "ok",
        "duration": 12.5,
        "width": 1920,
        "height": 1080,
        "video_codec": "h264",
        "audio_codec": "aac",
    }


def make_app(tmp_path: Path, volumes: list[Volume], probe=fake_probe):
    config = Config(
        host="127.0.0.1",
        port=8080,
        scan_interval_minutes=15,
        database=str(tmp_path / "catalog.db"),
        volumes=tuple(volumes),
        ffmpeg="ffmpeg-missing",
        ffprobe="ffprobe-missing",
    )
    return create_app(config, schedule=False, probe=probe)


def touch(path: Path, payload: bytes = b"video") -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(payload)


def test_example_config_points_at_archive_volumes():
    config = load_config(Path("config.example.yaml"))
    assert [(volume.name, volume.path) for volume in config.volumes] == [
        ("lib2", "/Volumes/lib2"),
        ("lib1", "/Volumes/lib1"),
    ]
    assert config.host == "0.0.0.0"


def test_merged_folders_hide_volumes(tmp_path: Path):
    first = tmp_path / "lib2"
    second = tmp_path / "lib3"
    touch(first / "Фильмы" / "Драма" / "a.mp4")
    touch(second / "Фильмы" / "Драма" / "b.mkv")
    touch(second / "Фильмы" / "Комедия" / "c.avi")
    touch(first / "Сериалы" / "pilot.mp4")
    touch(first / "Фильмы" / "Драма" / "same.mp4", b"one")
    touch(second / "Фильмы" / "Драма" / "same.mp4", b"two!")
    app = make_app(
        tmp_path,
        [Volume("lib2", str(first)), Volume("lib3", str(second))],
    )
    app.state.scanner.scan()

    with TestClient(app) as client:
        root = client.get("/api/browse").json()
        assert [item["name"] for item in root["folders"]] == ["Сериалы", "Фильмы"]
        assert root["folders"][1]["count"] == 5

        drama = client.get("/api/browse", params={"path": "Фильмы/Драма"}).json()
        assert [item["name"] for item in drama["files"]] == ["a.mp4", "b.mkv", "same.mp4", "same.mp4"]
        assert sorted(item["size"] for item in drama["files"] if item["name"] == "same.mp4") == [3, 4]
        assert {item["playback"] for item in drama["files"]} == {"direct", "remux"}

        body = client.get("/api/browse", params={"path": "Фильмы/Драма"}).text
        assert "lib2" not in body
        assert "lib3" not in body
        assert str(first) not in body
        assert str(second) not in body

        missing = client.get("/api/browse", params={"path": "../lib2"})
        assert missing.status_code == 400


def test_search_is_case_insensitive(tmp_path: Path):
    root = tmp_path / "lib2"
    touch(root / "Фильмы" / "Драма.mp4")
    app = make_app(tmp_path, [Volume("lib2", str(root))])
    app.state.scanner.scan()
    with TestClient(app) as client:
        found = client.get("/api/search", params={"q": "драма"}).json()
        assert [item["name"] for item in found["files"]] == ["Драма.mp4"]


def test_offline_volume_keeps_files_and_rescan_picks_up_changes(tmp_path: Path):
    first = tmp_path / "lib2"
    second = tmp_path / "lib3"
    touch(first / "Фильмы" / "a.mp4")
    touch(second / "Фильмы" / "b.mkv")
    calls: list[str] = []

    def counting_probe(path: str) -> dict:
        calls.append(path)
        return fake_probe(path)

    app = make_app(
        tmp_path,
        [Volume("lib2", str(first)), Volume("lib3", str(second))],
        probe=counting_probe,
    )
    app.state.scanner.scan()
    assert len(calls) == 2

    os.rename(second, tmp_path / "lib3-offline")
    app.state.scanner.scan()
    assert len(calls) == 2

    with TestClient(app) as client:
        listing = client.get("/api/browse", params={"path": "Фильмы"}).json()
        by_name = {item["name"]: item for item in listing["files"]}
        assert by_name["a.mp4"]["available"] is True
        assert by_name["b.mkv"]["available"] is False
        assert client.get("/api/status").json()["archive_incomplete"] is True

        offline = client.get(f"/api/videos/{by_name['b.mkv']['id']}/stream")
        assert offline.status_code == 404

    os.rename(tmp_path / "lib3-offline", second)
    (first / "Фильмы" / "a.mp4").unlink()
    touch(first / "Фильмы" / "c.mp4", b"new")
    app.state.scanner.scan()

    with TestClient(app) as client:
        listing = client.get("/api/browse", params={"path": "Фильмы"}).json()
        names = [item["name"] for item in listing["files"]]
        assert names == ["b.mkv", "c.mp4"]
        assert client.get("/api/status").json()["archive_incomplete"] is False
    assert len(calls) == 3


def test_empty_folder_is_listed(tmp_path: Path):
    root = tmp_path / "lib2"
    (root / "Новая папка").mkdir(parents=True)
    touch(root / "Films" / "a.mp4")
    app = make_app(tmp_path, [Volume("lib2", str(root))])
    app.state.scanner.scan()
    with TestClient(app) as client:
        listing = client.get("/api/browse").json()
        assert [item["name"] for item in listing["folders"]] == ["Films", "Новая папка"]
        assert listing["folders"][1]["count"] == 0
        nested = client.get("/api/browse", params={"path": "Новая папка"}).json()
        assert nested["folders"] == []
        assert nested["files"] == []


def test_exfat_windows_folders_are_skipped(tmp_path: Path):
    root = tmp_path / "lib2"
    touch(root / "System Volume Information" / "hidden.mp4")
    touch(root / "Films" / "a.mkv")
    app = make_app(tmp_path, [Volume("lib2", str(root))])
    app.state.scanner.scan()
    with TestClient(app) as client:
        listing = client.get("/api/browse").json()
        assert [item["name"] for item in listing["folders"]] == ["Films"]
        assert client.get("/api/status").json()["error"] is None


def test_permission_error_is_reported(tmp_path: Path, monkeypatch: pytest.MonkeyPatch):
    root = tmp_path / "lib2"
    touch(root / "a.mp4")
    app = make_app(tmp_path, [Volume("lib2", str(root))])

    def blocked_list(*_args, **_kwargs):
        raise PermissionError(13, "Permission denied")

    monkeypatch.setattr("app.scanner.os.listdir", blocked_list)
    app.state.scanner.scan()
    with TestClient(app) as client:
        assert client.get("/api/status").json()["error"] == "Нет доступа к архиву"
        assert client.get("/api/browse").json()["files"] == []


def test_walk_error_does_not_drop_known_files(tmp_path: Path, monkeypatch: pytest.MonkeyPatch):
    root = tmp_path / "lib2"
    touch(root / "Фильмы" / "a.mp4")
    app = make_app(tmp_path, [Volume("lib2", str(root))])
    app.state.scanner.scan()

    def broken_list(*_args, **_kwargs):
        raise OSError("denied")

    monkeypatch.setattr("app.scanner.os.listdir", broken_list)
    app.state.scanner.scan()
    with TestClient(app) as client:
        listing = client.get("/api/browse", params={"path": "Фильмы"}).json()
        assert [item["name"] for item in listing["files"]] == ["a.mp4"]
        assert client.get("/api/status").json()["error"] == "Некоторые папки не удалось прочитать"


def test_removed_volume_leaves_the_catalog(tmp_path: Path):
    root = tmp_path / "lib2"
    touch(root / "a.mp4")
    app = make_app(tmp_path, [Volume("lib2", str(root))])
    app.state.scanner.scan()
    app.state.scanner.volumes = ()
    app.state.scanner.scan()
    with TestClient(app) as client:
        assert client.get("/api/browse").json()["files"] == []


def test_playback_routes(tmp_path: Path):
    root = tmp_path / "lib2"
    touch(root / "clip.mp4", b"0123456789abcdef")
    touch(root / "film.mkv", b"mkv")
    touch(root / "old.avi", b"avi")
    app = make_app(tmp_path, [Volume("lib2", str(root))])
    app.state.scanner.scan()
    with TestClient(app) as client:
        files = {item["name"]: item for item in client.get("/api/browse").json()["files"]}
        direct = client.get(f"/api/videos/{files['clip.mp4']['id']}/stream", headers={"Range": "bytes=0-3"})
        assert direct.status_code == 206
        assert direct.content == b"0123"
        remux = client.get(f"/api/videos/{files['film.mkv']['id']}/stream")
        assert remux.status_code == 503
        avi = client.get(f"/api/videos/{files['old.avi']['id']}/stream")
        assert avi.status_code == 503
        hls = client.get(f"/api/videos/{files['film.mkv']['id']}/hls.m3u8")
        assert hls.status_code == 503
        missing = client.get(f"/api/videos/{files['film.mkv']['id']}/hls/nope/seg00000.ts")
        assert missing.status_code == 404
        started = client.post("/api/scan")
        assert started.status_code == 202


def test_audio_track_labels(tmp_path: Path):
    root = tmp_path / "lib2"
    touch(root / "film.mkv", b"mkv")

    def probe(_path: str) -> dict:
        info = fake_probe(_path)
        info["audio_tracks"] = [
            {"index": 0, "language": "rus", "title": "", "codec": "ac3"},
            {"index": 1, "language": "eng", "title": "Commentary", "codec": "aac"},
        ]
        return info

    app = make_app(tmp_path, [Volume("lib2", str(root))], probe=probe)
    app.state.scanner.scan()
    with TestClient(app) as client:
        file_id = client.get("/api/browse").json()["files"][0]["id"]
        tracks = client.get(f"/api/videos/{file_id}").json()["audio_tracks"]
        assert tracks[0]["label"] == "Русский · AC3"
        assert tracks[1]["label"] == "Commentary · Английский · AAC"


def test_playback_helpers():
    assert playback_kind("mp4") == "direct"
    assert playback_kind("mkv") == "remux"
    assert playback_kind("avi") == "remux"
    command = ffmpeg_remux_command("ffmpeg", "/Volumes/lib2/a.mkv", 12.5)
    assert command[command.index("-ss") + 1] == "12.500"
    assert "libx264" in command
    assert "aac" in command
    assert command[-1] == "pipe:1"
    still = ffmpeg_remux_command("ffmpeg", "/Volumes/lib2/a.mkv", 0)
    assert "-ss" not in still
    chosen = ffmpeg_remux_command("ffmpeg", "/Volumes/lib2/a.mkv", 0, audio_index=1)
    assert "0:a:1?" in chosen
    hls = ffmpeg_hls_command("ffmpeg", "/Volumes/lib2/a.mkv", 12.5, Path("/tmp/hls"))
    assert hls[hls.index("-ss") + 1] == "12.500"
    assert "hls" in hls
    assert "aac_low" in hls
    assert hls[-1].endswith("index.m3u8")
    playlist = rewrite_hls_playlist("#EXTM3U\n#EXTINF:4.0,\nseg00000.ts\n", "/api/videos/5/hls/token/")
    assert "seg00000.ts" in playlist
    assert playlist.splitlines()[-1] == "/api/videos/5/hls/token/seg00000.ts"
    info = parse_probe(
        {
            "format": {"duration": "3.5"},
            "streams": [
                {"codec_type": "video", "codec_name": "h264", "width": 1280, "height": 720},
                {"codec_type": "audio", "codec_name": "ac3", "tags": {"language": "rus"}},
                {"codec_type": "audio", "codec_name": "aac", "tags": {"language": "eng", "title": "Commentary"}},
            ],
        }
    )
    assert [track["index"] for track in info["audio_tracks"]] == [0, 1]
    assert info["audio_tracks"][1]["language"] == "eng"
    info = parse_probe(
        {
            "format": {"duration": "3.5"},
            "streams": [
                {"codec_type": "video", "codec_name": "h264", "width": 1280, "height": 720},
                {"codec_type": "audio", "codec_name": "aac"},
            ],
        }
    )
    assert info["duration"] == 3.5
    assert info["video_codec"] == "h264"
