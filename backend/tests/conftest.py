"""Shared fixtures: settings, a fake Hermes behind an in-process transport, the app."""

import asyncio
import time
from collections.abc import Callable, Iterator
from pathlib import Path
from typing import Any

import httpx
import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from blob.config import Settings
from blob.fakes import FakeStt, FakeTts
from blob.main import create_app
from tests.fakes.fake_hermes import FakeHermes, make_app

TOKEN = "test-device-token"
ALERT_TOKEN = "test-alert-token"
CLIPS = Path(__file__).parent / "clips"


def make_settings(tmp_path: Path, **overrides: Any) -> Settings:
    values: dict[str, Any] = {
        "hermes_url": "http://hermes.test",
        "hermes_key": "test-key",
        "hermes_model": "hermes-agent",
        "device_token": TOKEN,
        "alert_token": ALERT_TOKEN,
        "db_path": str(tmp_path / "blob.db"),
        "static_dir": str(tmp_path / "no-page"),
        "devices_path": str(tmp_path / "devices.json"),
        "blob_fake_models": True,
    }
    values.update(overrides)
    return Settings(_env_file=None, **values)  # type: ignore[call-arg]


@pytest.fixture
def fake_hermes() -> FakeHermes:
    return FakeHermes()


@pytest.fixture
def hermes_transport(fake_hermes: FakeHermes) -> httpx.AsyncBaseTransport:
    return httpx.ASGITransport(app=make_app(fake_hermes))


def wait_ready(client: TestClient, timeout: float = 5.0) -> None:
    end = time.monotonic() + timeout
    while time.monotonic() < end:
        if client.get("/readyz").status_code == 200:
            return
        time.sleep(0.01)
    raise AssertionError("app never became ready")


@pytest.fixture
def app_factory(tmp_path: Path, hermes_transport: httpx.AsyncBaseTransport) -> Iterator[Any]:
    """Build an app with fake models and the fake Hermes; keyword arguments override settings."""

    def build(
        models: tuple[Any, Any] | None = None,
        wall: Callable[[], float] = time.time,
        **overrides: Any,
    ) -> FastAPI:
        s = make_settings(tmp_path, **overrides)
        models = models or (
            FakeStt(s.blob_fake_transcript, s.blob_fake_lang, s.silence_rms),
            FakeTts(),
        )
        return create_app(s, models=models, hermes_transport=hermes_transport, wall=wall)

    yield build


@pytest.fixture
def client(app_factory: Any) -> Iterator[TestClient]:
    with TestClient(app_factory()) as c:
        wait_ready(c)
        yield c


async def eventually(cond: Callable[[], object]) -> None:
    """Poll a condition set by another task or a worker thread."""
    for _ in range(1000):  # 5 s
        if cond():
            return
        await asyncio.sleep(0.005)
    raise AssertionError("condition not met")
