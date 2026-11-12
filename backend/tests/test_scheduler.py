"""The alert scheduler and restart behaviour, with an injected clock and a real SQLite file."""

import asyncio
from pathlib import Path
from typing import Any

import pytest
from fastapi.testclient import TestClient

from blob.alerts import ACKED_KEEP_S, SLEEP_CAP_S, Alerts, run_scheduler
from blob.db import Db
from blob.schemas import AlertIn
from tests.conftest import ALERT_TOKEN, TOKEN, wait_ready
from tests.test_hub import recv

NOW = 1_700_000_000
AUTH = {"Authorization": f"Bearer {ALERT_TOKEN}"}


class Wall:
    def __init__(self) -> None:
        self.now = float(NOW)

    def __call__(self) -> float:
        return self.now


class Rig:
    def __init__(self, path: Path, wall: Wall | None = None) -> None:
        self.wall = wall or Wall()
        self.db = Db(str(path))
        self.changes = 0
        self.alerts = Alerts(self.db, self.changed, self.wall)

    async def changed(self) -> None:
        self.changes += 1

    async def post(self, **body: Any) -> None:
        await self.alerts.upsert(AlertIn(**body))

    def state(self, key: str) -> str | None:
        a = self.alerts.rows.get(key)
        return a.state if a else None


@pytest.fixture
def path(tmp_path: Path) -> Path:
    return tmp_path / "blob.db"


async def test_pending_timer_activates_at_fire_at(path: Path) -> None:
    r = Rig(path)
    await r.post(key="t", source="timer", text="Fin", in_s=10)
    r.changes = 0
    r.wall.now = NOW + 9.9
    assert await r.alerts.tick() == pytest.approx(0.1)
    assert r.state("t") == "pending" and r.changes == 0
    r.wall.now = NOW + 10.05
    await r.alerts.tick()
    a = r.alerts.rows["t"]
    assert (a.state, a.activated_at, a.late) == ("active", NOW + 10, False)
    assert r.changes == 1  # one snapshot broadcast for the change
    assert [i.key for i in r.alerts.items()] == ["t"]
    await r.alerts.tick()
    assert r.changes == 1  # nothing new, no broadcast


async def test_sleep_is_capped(path: Path) -> None:
    r = Rig(path)
    assert await r.alerts.tick() == SLEEP_CAP_S  # nothing pending
    await r.post(key="far", source="timer", text="t", in_s=3600)
    assert await r.alerts.tick() == SLEEP_CAP_S
    await r.post(key="soon", source="timer", text="t", fire_at=NOW + 1)
    r.wall.now = NOW + 0.9
    assert await r.alerts.tick() == pytest.approx(0.1)


async def test_timer_added_while_sleeping_is_seen_within_cap(path: Path) -> None:
    r = Rig(path)
    delays: list[float] = []
    woke = asyncio.Event()

    async def sleep(seconds: float) -> None:
        delays.append(seconds)
        woke.set()
        await asyncio.sleep(0)

    task = asyncio.create_task(run_scheduler(r.alerts, sleep))
    try:
        await woke.wait()
        await r.post(key="t", source="timer", text="t", in_s=2)
        r.wall.now = NOW + 2
        for _ in range(100):
            if r.state("t") == "active":
                break
            await asyncio.sleep(0)
        assert r.state("t") == "active"
        assert delays and max(delays) <= SLEEP_CAP_S
    finally:
        task.cancel()


async def test_scheduler_survives_a_failing_tick(path: Path) -> None:
    r = Rig(path)
    calls: list[float] = []

    async def boom() -> float:
        raise RuntimeError("disk")

    r.alerts.tick = boom  # type: ignore[method-assign]

    async def sleep(seconds: float) -> None:
        calls.append(seconds)
        if len(calls) == 2:
            raise asyncio.CancelledError

    with pytest.raises(asyncio.CancelledError):
        await run_scheduler(r.alerts, sleep)
    assert calls == [SLEEP_CAP_S, SLEEP_CAP_S]


async def test_ttl_counts_from_activation(path: Path) -> None:
    r = Rig(path)
    await r.post(key="t", source="timer", text="t", in_s=100, ttl_s=60)
    r.wall.now = NOW + 150  # past the ttl from creation, but pending rows never expire
    await r.alerts.tick()
    assert r.state("t") == "active" and r.alerts.rows["t"].activated_at == NOW + 150
    r.wall.now = NOW + 209
    await r.alerts.tick()
    assert r.state("t") == "active"
    r.wall.now = NOW + 210
    await r.alerts.tick()
    assert r.state("t") is None
    assert r.db.load_alerts() == []


async def test_acked_rows_deleted_after_24h(path: Path) -> None:
    r = Rig(path)
    await r.post(key="k", source="s", text="t")
    await r.alerts.ack("k")
    r.wall.now = NOW + ACKED_KEEP_S - 1
    await r.alerts.tick()
    assert r.state("k") == "acked"
    r.wall.now = NOW + ACKED_KEEP_S
    await r.alerts.tick()
    assert r.state("k") is None and r.db.load_alerts() == []


async def test_ack_only_moves_active_rows(path: Path) -> None:
    r = Rig(path)
    await r.post(key="p", source="timer", text="t", in_s=60)
    r.changes = 0
    await r.alerts.ack("p")
    await r.alerts.ack("missing")
    assert r.state("p") == "pending" and r.changes == 0


async def test_restart_keeps_rows(path: Path) -> None:
    r = Rig(path)
    await r.post(key="a", source="homeassistant", text="Puerta", urgency="urgent")
    await r.post(key="t", source="timer", text="Fin", in_s=600)
    await r.post(key="k", source="s", text="t")
    await r.alerts.ack("k")
    r.db.close()
    r2 = Rig(path, r.wall)
    await r2.alerts.load()
    assert {k: a.state for k, a in r2.alerts.rows.items()} == {
        "a": "active",
        "t": "pending",
        "k": "acked",
    }
    assert r2.alerts.rows["a"].urgency == "urgent" and r2.alerts.rows["t"].fire_at == NOW + 600
    assert r2.changes == 0
    r2.db.close()


async def test_overdue_on_startup_fires_once_marked_late(path: Path) -> None:
    r = Rig(path)
    await r.post(key="late", source="timer", text="Fin", in_s=60)
    await r.post(key="gone", source="timer", text="Fin", in_s=60, ttl_s=100)
    await r.post(key="kept", source="timer", text="Fin", in_s=60, ttl_s=5000)
    await r.post(key="future", source="timer", text="Fin", in_s=7200)
    r.db.close()
    r.wall.now = NOW + 3600  # the service was down while the timers came due
    r2 = Rig(path, r.wall)
    await r2.alerts.load()
    rows = r2.alerts.rows
    assert (rows["late"].state, rows["late"].late, rows["late"].activated_at) == (
        "active",
        True,
        NOW + 60,
    )
    assert "gone" not in rows  # its ttl ran out during the downtime
    assert (rows["kept"].state, rows["kept"].late) == ("active", True)
    assert rows["future"].state == "pending"
    r2.db.close()
    # A second restart does not fire it again.
    r3 = Rig(path, r.wall)
    await r3.alerts.load()
    assert r3.alerts.rows["late"].activated_at == NOW + 60 and r3.alerts.rows["late"].late
    assert "gone" not in r3.alerts.rows and len(r3.db.load_alerts()) == 3
    r3.db.close()


def test_app_restart_with_real_sqlite_file(app_factory: Any) -> None:
    """Create an alert and a pending timer, restart the app object, check what the page sees."""
    wall = Wall()
    with TestClient(app_factory(wall=wall)) as c:
        wait_ready(c)
        h = AUTH
        assert c.post("/alerts", json={"key": "door", "source": "ha", "text": "Puerta"}, headers=h)
        r = c.post(
            "/alerts", json={"key": "t1", "source": "timer", "text": "Fin", "in_s": 60}, headers=h
        )
        assert r.json()["state"] == "pending"
    wall.now = NOW + 600  # down for ten minutes; the timer came due meanwhile
    for _ in range(2):  # the second restart must not fire it again
        with TestClient(app_factory(wall=wall)) as c:
            wait_ready(c)
            states = {a["key"]: a["state"] for a in c.get("/alerts", headers=AUTH).json()}
            assert states == {"door": "active", "t1": "active"}
            with c.websocket_connect("/ws") as ws:
                ws.send_json({"type": "hello", "version": "1", "token": TOKEN, "device": "d"})
                assert recv(ws)["type"] == "hello_ok"
                snap = recv(ws)
                by_key = {a["key"]: a for a in snap["alerts"]}
                assert by_key["door"]["late"] is False and by_key["door"]["activated_at"] == NOW
                assert by_key["t1"] == {
                    "key": "t1",
                    "source": "timer",
                    "urgency": "urgent",
                    "text": "Fin",
                    "lang": "es",
                    "late": True,
                    "activated_at": NOW + 60,
                }
