"""Shared fixtures: settings, a fake Hermes and a fake Pocket ID behind in-process transports,
the app with signed-in sessions already stored."""

import asyncio
import time
from collections.abc import Callable, Iterator
from pathlib import Path
from typing import Any

import httpx
import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from blob.auth import SESSION_COOKIE, _hash
from blob.config import Settings
from blob.db import Db
from blob.fakes import FakeStt, FakeTts
from blob.main import create_app
from tests.fakes.fake_hermes import FakeHermes, make_app
from tests.fakes.fake_pocketid import ISSUER, FakePocketId

ALERT_TOKEN = "test-alert-token"
PUBLIC_URL = "http://blob.test"
CLIENT_ID = "blob-client"
# Sessions stored before every app starts, by user name: the tablet is a kiosk user in both
# groups, the desktop a person in neither.
USERS: dict[str, tuple[str, ...]] = {
    "desktop": (),
    "tablet": ("blob-sound", "blob-wake"),
}


def session_id(name: str) -> str:
    return f"test-session-{name}"


def signed_in(name: str = "desktop") -> dict[str, str]:
    """Request headers carrying the stored session of this user."""
    return {"Cookie": f"{SESSION_COOKIE}={session_id(name)}"}


CLIPS = Path(__file__).parent / "clips"


def make_settings(tmp_path: Path, **overrides: Any) -> Settings:
    values: dict[str, Any] = {
        "hermes_url": "http://hermes.test",
        "hermes_key": "test-key",
        "hermes_model": "hermes-agent",
        "public_url": PUBLIC_URL,
        "oidc_issuer": ISSUER,
        "oidc_client_id": CLIENT_ID,
        "alert_token": ALERT_TOKEN,
        "db_path": str(tmp_path / "blob.db"),
        "static_dir": str(tmp_path / "no-page"),
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
def pocket_id() -> FakePocketId:
    return FakePocketId(CLIENT_ID)


def store_sessions(db_path: str, now: float) -> None:
    db = Db(db_path)
    try:
        for name, groups in USERS.items():
            if db._get_session(_hash(session_id(name))) is None:
                db._insert_session(
                    _hash(session_id(name)), f"sub-{name}", name, list(groups), int(now)
                )
            else:
                db._touch_session(_hash(session_id(name)), int(now))
    finally:
        db.close()


@pytest.fixture
def app_factory(
    tmp_path: Path, hermes_transport: httpx.AsyncBaseTransport, pocket_id: FakePocketId
) -> Iterator[Any]:
    """Build an app with fake models, the fake Hermes and the fake Pocket ID; keyword arguments
    override settings. The USERS sessions are stored in its database."""

    def build(
        models: tuple[Any, Any] | None = None,
        wall: Callable[[], float] = time.time,
        weather_transport: httpx.AsyncBaseTransport | None = None,
        **overrides: Any,
    ) -> FastAPI:
        s = make_settings(tmp_path, **overrides)
        models = models or (
            FakeStt(s.blob_fake_transcript, s.blob_fake_lang, s.silence_rms),
            FakeTts(),
        )
        if s.db_path != ":memory:":
            store_sessions(s.db_path, wall())
        return create_app(
            s,
            models=models,
            hermes_transport=hermes_transport,
            oidc_transport=pocket_id.transport(),
            weather_transport=weather_transport,
            wall=wall,
        )

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
