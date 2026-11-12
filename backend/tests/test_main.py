from pathlib import Path
from typing import Any

import pytest
from fastapi.testclient import TestClient

from blob import main
from blob.db import Db
from blob.fakes import FakeStt, FakeTts
from blob.schemas import Timings
from tests.conftest import wait_ready


class FailingTts(FakeTts):
    def load(self) -> None:
        raise RuntimeError("no model file")


def test_health_and_ready(client: TestClient) -> None:
    assert client.get("/readyz").json() == {"ready": True}
    body = client.get("/healthz").json()
    assert body["alive"] is True and body["ready"] is True
    assert body["hermes_reachable"] is True  # the fake Hermes answers /health


def test_model_failure_keeps_readyz_503(app_factory: Any) -> None:
    app = app_factory(models=(FakeStt("x", "es", 0.01), FailingTts()))
    with TestClient(app) as c:
        for _ in range(50):
            r = c.get("/healthz")
            assert r.status_code == 200 and r.json()["ready"] is False
        assert c.get("/readyz").status_code == 503


def test_retention_at_startup(tmp_path: Path, app_factory: Any) -> None:
    db = Db(str(tmp_path / "blob.db"))
    db._insert_turn(1, None, "old", "", "ok", None, Timings())
    db.close()
    with TestClient(app_factory()) as c:
        wait_ready(c)
        for _ in range(100):
            if not Db(str(tmp_path / "blob.db")).turns():
                break
            c.get("/healthz")
        assert Db(str(tmp_path / "blob.db")).turns() == []


def test_no_page(client: TestClient) -> None:
    r = client.get("/")
    assert r.status_code == 404 and "Page not built" in r.text


def test_page_served(tmp_path: Path, app_factory: Any) -> None:
    dist = tmp_path / "dist"
    (dist / "assets").mkdir(parents=True)
    (dist / "index.html").write_text("<!doctype html><title>Blob</title>")
    (dist / "assets" / "app-1234.js").write_text("console.log(1)")
    with TestClient(app_factory(static_dir=str(dist))) as c:
        for path in ("/", "/index.html"):
            r = c.get(path)
            assert r.status_code == 200 and "Blob" in r.text
            assert r.headers["cache-control"] == "no-cache"
        js = c.get("/assets/app-1234.js")
        assert js.status_code == 200 and "cache-control" not in js.headers
        assert c.get("/healthz").status_code == 200  # API routes win over the page mount
        assert c.get("/missing.js").status_code == 404


def test_fake_models_switch(tmp_path: Path) -> None:
    from tests.conftest import make_settings

    stt, tts = main._models(make_settings(tmp_path, blob_fake_models=True))
    assert isinstance(stt, FakeStt) and isinstance(tts, FakeTts)
    real_stt, real_tts = main._models(make_settings(tmp_path, blob_fake_models=False))
    assert type(real_stt).__name__ == "WhisperStt" and type(real_tts).__name__ == "KokoroTts"


def test_run(monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> None:
    for name, value in {
        "HERMES_URL": "http://hermes",
        "HERMES_KEY": "k",
        "HERMES_MODEL": "m",
        "DEVICE_TOKEN": "t",
        "PORT": "8123",
        "DB_PATH": str(tmp_path / "b.db"),
        "DEVICES_PATH": str(tmp_path / "d.json"),
    }.items():
        monkeypatch.setenv(name, value)
    calls: list[tuple[Any, dict[str, Any]]] = []
    monkeypatch.setattr(main.uvicorn, "run", lambda app, **kw: calls.append((app, kw)))
    main.run()
    assert calls[0][1] == {"host": "0.0.0.0", "port": 8123}
