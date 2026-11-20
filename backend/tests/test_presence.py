"""POST/GET/DELETE /presence and the presence message on the WebSocket (injected wall clock)."""

from collections.abc import Iterator
from typing import Any

import pytest
from fastapi.testclient import TestClient

from tests.conftest import ALERT_TOKEN, signed_in, wait_ready
from tests.test_hub import connect, recv

NOW = 1_700_000_000
AUTH = {"Authorization": f"Bearer {ALERT_TOKEN}"}


class Wall:
    def __init__(self) -> None:
        self.now = float(NOW)

    def __call__(self) -> float:
        return self.now


@pytest.fixture
def wall() -> Wall:
    return Wall()


@pytest.fixture
def api(app_factory: Any, wall: Wall) -> Iterator[TestClient]:
    with TestClient(app_factory(wall=wall)) as c:
        wait_ready(c)
        yield c


def post(c: TestClient, body: Any) -> Any:
    return c.post("/presence", json=body, headers=AUTH)


@pytest.mark.parametrize(
    "headers", [{}, {"Authorization": "Bearer wrong"}, {"Authorization": ALERT_TOKEN}]
)
def test_bad_token_is_401(api: TestClient, headers: dict[str, str]) -> None:
    assert api.post("/presence", json={"present": True}, headers=headers).status_code == 401
    assert api.get("/presence", headers=headers).status_code == 401
    assert api.delete("/presence", headers=headers).status_code == 401


def test_a_signed_in_browser_cannot_report_presence(api: TestClient) -> None:
    r = api.post("/presence", json={"present": True}, headers=signed_in("tablet"))
    assert r.status_code == 401


def test_unknown_until_a_sensor_reports(api: TestClient) -> None:
    assert api.get("/presence", headers=AUTH).json() == {"present": None, "since_s": None}


@pytest.mark.parametrize(
    "body",
    [
        {},
        {"present": "on"},
        {"present": "True"},
        {"present": 1},
        {"present": None},
        {"present": True, "room": "living"},
        [True],
    ],
)
def test_invalid_body_is_422(api: TestClient, body: Any) -> None:
    assert post(api, body).status_code == 422
    assert api.get("/presence", headers=AUTH).json()["present"] is None


def test_report_and_read_back(api: TestClient, wall: Wall) -> None:
    r = post(api, {"present": True})
    assert r.status_code == 200
    assert r.json() == {"present": True, "since_s": 0.0}
    wall.now += 42
    assert api.get("/presence", headers=AUTH).json() == {"present": True, "since_s": 42.0}
    assert post(api, {"present": False}).json() == {"present": False, "since_s": 0.0}


def test_repeated_true_restarts_the_clock(api: TestClient, wall: Wall) -> None:
    post(api, {"present": True})
    wall.now += 30
    # Each motion report is fresh: the screen wakes again.
    assert post(api, {"present": True}).json()["since_s"] == 0.0


def test_repeated_false_keeps_when_the_room_emptied(api: TestClient, wall: Wall) -> None:
    post(api, {"present": False})
    wall.now += 120
    # A repeated "nobody" must not push the screen's sleep further away.
    assert post(api, {"present": False}).json() == {"present": False, "since_s": 120.0}


def test_delete_goes_back_to_unknown(api: TestClient) -> None:
    post(api, {"present": False})
    r = api.delete("/presence", headers=AUTH)
    assert r.status_code == 204
    assert api.get("/presence", headers=AUTH).json() == {"present": None, "since_s": None}
    assert api.delete("/presence", headers=AUTH).status_code == 204  # idempotent


def test_no_presence_message_without_a_sensor(api: TestClient) -> None:
    # connect() asserts hello_ok then the snapshot; with no report nothing else is queued.
    with connect(api) as ws:
        ws.send_json({"type": "ping"})
        assert recv(ws) == {"type": "pong"}


def test_reports_reach_every_screen(api: TestClient, wall: Wall) -> None:
    with connect(api, "tablet") as tablet, connect(api, "desktop") as desktop:
        post(api, {"present": True})
        msg = {"type": "presence", "present": True, "since_s": 0.0}
        assert recv(tablet) == msg
        assert recv(desktop) == msg
        api.delete("/presence", headers=AUTH)
        msg = {"type": "presence", "present": None, "since_s": None}
        assert recv(tablet) == msg
        assert recv(desktop) == msg


def test_a_new_screen_gets_the_last_report_after_the_snapshot(api: TestClient, wall: Wall) -> None:
    post(api, {"present": False})
    wall.now += 90
    with connect(api) as ws:
        assert recv(ws) == {"type": "presence", "present": False, "since_s": 90.0}


def test_presence_does_not_touch_alerts(api: TestClient) -> None:
    api.post(
        "/alerts",
        json={"key": "door", "source": "homeassistant", "text": "Puerta abierta"},
        headers=AUTH,
    )
    post(api, {"present": False})
    alerts = api.get("/alerts", headers=AUTH).json()
    assert [(a["key"], a["state"]) for a in alerts] == [("door", "active")]
