"""POST/DELETE/GET /alerts: every rule of the contract table in the design (injected wall clock)."""

from collections.abc import Iterator
from typing import Any

import pytest
from fastapi.testclient import TestClient

from blob.alerts import Alert, Alerts
from tests.conftest import ALERT_TOKEN, wait_ready

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


def post(c: TestClient, **body: Any) -> Any:
    return c.post("/alerts", json=body, headers=AUTH)


def rows(c: TestClient) -> dict[str, Alert]:
    store: Alerts = c.app.state.alerts  # type: ignore[attr-defined]
    return store.rows


def ack(c: TestClient, key: str) -> None:
    assert c.portal is not None
    c.portal.call(c.app.state.alerts.ack, key)  # type: ignore[attr-defined]


@pytest.mark.parametrize(
    "headers", [{}, {"Authorization": "Bearer wrong"}, {"Authorization": ALERT_TOKEN}]
)
def test_bad_token_is_401(api: TestClient, headers: dict[str, str]) -> None:
    assert api.post("/alerts", json={}, headers=headers).status_code == 401
    assert api.get("/alerts", headers=headers).status_code == 401
    assert api.delete("/alerts/x", headers=headers).status_code == 401


def test_device_token_is_not_the_alert_token(api: TestClient) -> None:
    from tests.conftest import TOKEN

    assert api.get("/alerts", headers={"Authorization": f"Bearer {TOKEN}"}).status_code == 401


def test_new_key_201_then_update_200(api: TestClient) -> None:
    r = post(api, key="door", source="homeassistant", text="Puerta abierta")
    assert r.status_code == 201
    assert r.json() == {"key": "door", "state": "active", "fire_at": None}
    a = rows(api)["door"]
    assert (a.urgency, a.lang, a.late, a.activated_at, a.created_at) == (
        "info",
        "es",
        False,
        NOW,
        NOW,
    )
    r = post(api, key="door", source="homeassistant", text="Puerta abierta ya", urgency="urgent")
    assert r.status_code == 200 and r.json()["state"] == "active"
    assert (rows(api)["door"].text, rows(api)["door"].urgency) == ("Puerta abierta ya", "urgent")


def test_timer_source_defaults_to_urgent(api: TestClient) -> None:
    post(api, key="t1", source="timer", text="Fin", in_s=60)
    post(api, key="t2", source="timer", text="Fin", urgency="info")
    assert (rows(api)["t1"].urgency, rows(api)["t2"].urgency) == ("urgent", "info")


@pytest.mark.parametrize(
    "body",
    [
        {"source": "s", "text": "t"},  # no key
        {"key": "k", "text": "t"},  # no source
        {"key": "k", "source": "s"},  # no text
        {"key": "k", "source": "s", "text": ""},
        {"key": "k", "source": "s", "text": "x" * 301},
        {"key": "", "source": "s", "text": "t"},
        {"key": "a b", "source": "s", "text": "t"},
        {"key": "a/b", "source": "s", "text": "t"},
        {"key": "k" * 65, "source": "s", "text": "t"},
        {"key": "k", "source": "s", "text": "t", "urgency": "high"},
        {"key": "k", "source": "s", "text": "t", "fire_at": "2026-11-12T10:00:00"},  # no offset
        {"key": "k", "source": "s", "text": "t", "fire_at": "tomorrow"},
        {"key": "k", "source": "s", "text": "t", "fire_at": True},
        {"key": "k", "source": "s", "text": "t", "fire_at": NOW + 60, "in_s": 60},
        {"key": "k", "source": "s", "text": "t", "in_s": "60"},
        {"key": "k", "source": "s", "text": "t", "ttl_s": 0},
        {"key": "k", "source": "s", "text": "t", "fire_in": 60},  # unknown field
        {"key": "k", "source": "s", "text": "t", "in_s": 1e300},
        {"key": "k", "source": "s", "text": "t", "fire_at": 1e300},
        {"key": "k", "source": "s", "text": "t", "fire_at": -1},
        {"key": "k", "source": "s", "text": "t", "ttl_s": 10**30},
    ],
)
def test_422(api: TestClient, body: dict[str, Any]) -> None:
    assert api.post("/alerts", json=body, headers=AUTH).status_code == 422
    assert rows(api) == {}


def test_limits_that_pass(api: TestClient) -> None:
    r = post(api, key="A.b_c-9" + "k" * 57, source="s", text="x" * 300)
    assert r.status_code == 201


def test_fire_at_epoch_and_rfc3339(api: TestClient) -> None:
    assert post(api, key="e", source="cal", text="t", fire_at=NOW + 90).json() == {
        "key": "e",
        "state": "pending",
        "fire_at": NOW + 90,
    }
    # 2023-11-14T22:13:20Z is NOW; +02:00 and Z forms
    r = post(api, key="r1", source="cal", text="t", fire_at="2023-11-15T00:15:20+02:00")
    assert r.json() == {"key": "r1", "state": "pending", "fire_at": NOW + 120}
    r = post(api, key="r2", source="cal", text="t", fire_at="2023-11-14T22:14:20Z")
    assert r.json()["fire_at"] == NOW + 60
    assert rows(api)["e"].activated_at is None


def test_in_s_uses_the_server_clock(api: TestClient, wall: Wall) -> None:
    wall.now = NOW + 0.4
    r = post(api, key="t", source="timer", text="t", in_s=120)
    assert r.json() == {"key": "t", "state": "pending", "fire_at": NOW + 120}


@pytest.mark.parametrize(
    "extra", [{}, {"fire_at": NOW - 10}, {"fire_at": NOW}, {"in_s": -5}, {"in_s": 0}]
)
def test_active_immediately(api: TestClient, extra: dict[str, Any]) -> None:
    r = post(api, key="k", source="s", text="t", **extra)
    assert r.status_code == 201 and r.json()["state"] == "active"
    assert rows(api)["k"].activated_at == NOW


def test_changed_fire_at_updates_pending_and_active(api: TestClient) -> None:
    post(api, key="k", source="cal", text="t", fire_at=NOW + 60)
    r = post(api, key="k", source="cal", text="t", fire_at=NOW + 300)
    assert r.status_code == 200 and r.json() == {
        "key": "k",
        "state": "pending",
        "fire_at": NOW + 300,
    }
    r = post(api, key="k", source="cal", text="t", fire_at=NOW - 1)  # now due
    assert r.json()["state"] == "active" and rows(api)["k"].activated_at == NOW
    r = post(api, key="k", source="cal", text="t", fire_at=NOW + 600)  # moved to the future
    assert r.json() == {"key": "k", "state": "pending", "fire_at": NOW + 600}
    assert rows(api)["k"].activated_at is None


def test_update_of_active_keeps_activation(api: TestClient, wall: Wall) -> None:
    post(api, key="k", source="s", text="one")
    wall.now += 50
    post(api, key="k", source="s", text="two")
    assert rows(api)["k"].activated_at == NOW and rows(api)["k"].created_at == NOW


def test_cap_of_20_active(api: TestClient) -> None:
    for i in range(20):
        assert post(api, key=f"a{i}", source="s", text="t").status_code == 201
    r = post(api, key="a20", source="s", text="t")
    assert r.status_code == 429 and "a20" not in rows(api)
    assert post(api, key="a0", source="s", text="changed").status_code == 200  # an update is fine
    assert post(api, key="p", source="timer", text="t", in_s=60).status_code == 201  # pending
    api.delete("/alerts/a1", headers=AUTH)
    assert post(api, key="a20", source="s", text="t").status_code == 201


def test_cap_counts_reraise(api: TestClient) -> None:
    post(api, key="old", source="s", text="t")
    ack(api, "old")
    for i in range(20):
        post(api, key=f"a{i}", source="s", text="t")
    assert post(api, key="old", source="s", text="new text").status_code == 429
    assert rows(api)["old"].state == "acked"


def test_acked_same_payload_is_ignored(api: TestClient, wall: Wall) -> None:
    post(api, key="wash", source="homeassistant", text="Lavadora lista")
    ack(api, "wash")
    assert rows(api)["wash"].acked_at == NOW
    wall.now += 60  # the source repeats its status check every minute
    r = post(api, key="wash", source="homeassistant", text="Lavadora lista")
    assert r.status_code == 200 and r.json()["state"] == "acked"
    assert rows(api)["wash"].acked_at == NOW


def test_acked_same_fire_at_is_ignored(api: TestClient) -> None:
    post(api, key="cal", source="calendar", text="Reunión", fire_at=NOW - 5)
    ack(api, "cal")
    r = post(api, key="cal", source="calendar", text="Reunión", fire_at=NOW - 5)
    assert r.json()["state"] == "acked"


@pytest.mark.parametrize(
    "change",
    [{"text": "Lavadora lista otra vez"}, {"urgency": "urgent"}, {"fire_at": NOW - 100}],
)
def test_acked_changed_payload_reraises(api: TestClient, wall: Wall, change: Any) -> None:
    post(api, key="wash", source="homeassistant", text="Lavadora lista")
    ack(api, "wash")
    wall.now += 30
    r = post(api, key="wash", source="homeassistant", **{"text": "Lavadora lista", **change})
    assert r.json()["state"] == "active"
    a = rows(api)["wash"]
    assert (a.activated_at, a.acked_at) == (NOW + 30, None)


def test_acked_in_s_always_reraises(api: TestClient) -> None:
    post(api, key="t", source="timer", text="Fin", in_s=-1)
    ack(api, "t")
    r = post(api, key="t", source="timer", text="Fin", in_s=-1)
    assert r.json()["state"] == "active"
    ack(api, "t")
    r = post(api, key="t", source="timer", text="Fin", in_s=60)  # a future timer again
    assert r.json() == {"key": "t", "state": "pending", "fire_at": NOW + 60}


def test_same_timer_twice_creates_two(api: TestClient, wall: Wall) -> None:
    for _ in range(2):
        key = f"timer-{int(wall.now)}"
        assert post(api, key=key, source="timer", text="10 min", in_s=600).status_code == 201
        wall.now += 5
    assert len(api.get("/alerts", headers=AUTH).json()) == 2


def test_delete_is_idempotent(api: TestClient) -> None:
    post(api, key="k", source="s", text="t")
    assert api.delete("/alerts/k", headers=AUTH).status_code == 204
    assert api.delete("/alerts/k", headers=AUTH).status_code == 204
    assert api.delete("/alerts/never", headers=AUTH).status_code == 204
    assert rows(api) == {}


def test_delete_pending(api: TestClient) -> None:
    post(api, key="t", source="timer", text="t", in_s=600)
    assert api.delete("/alerts/t", headers=AUTH).status_code == 204
    assert api.get("/alerts", headers=AUTH).json() == []


def test_get_lists_every_state(api: TestClient) -> None:
    post(api, key="a", source="s", text="t")
    post(api, key="p", source="timer", text="t", in_s=60)
    post(api, key="k", source="s", text="t")
    ack(api, "k")
    got = sorted(api.get("/alerts", headers=AUTH).json(), key=lambda x: x["key"])
    assert got == [
        {"key": "a", "state": "active", "fire_at": None},
        {"key": "k", "state": "acked", "fire_at": None},
        {"key": "p", "state": "pending", "fire_at": NOW + 60},
    ]


@pytest.mark.parametrize("field", ["in_s", "fire_at"])
def test_nan_is_422_not_500(api: TestClient, field: str) -> None:
    body = f'{{"key": "k", "source": "s", "text": "t", "{field}": NaN}}'
    r = api.post("/alerts", content=body, headers={**AUTH, "Content-Type": "application/json"})
    assert r.status_code == 422
