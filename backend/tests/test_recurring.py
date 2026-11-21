"""Recurring alerts (`repeat`): the API contract and the store/scheduler life cycle.

The clock is injected and the zone is Europe/Madrid. NOW is Friday 2026-11-20 08:00 in Madrid.
"""

from collections.abc import Iterator
from datetime import datetime
from pathlib import Path
from typing import Any
from zoneinfo import ZoneInfo

import pytest
from fastapi.testclient import TestClient

from blob.alerts import ACKED_KEEP_S
from blob.schemas import AlertIn
from tests.conftest import ALERT_TOKEN, wait_ready
from tests.test_scheduler import Rig, Wall

MADRID = ZoneInfo("Europe/Madrid")
AUTH = {"Authorization": f"Bearer {ALERT_TOKEN}"}
DAY = 86400


def at(text: str) -> int:
    """Epoch seconds of a Madrid wall-clock time."""
    return int(datetime.fromisoformat(text).replace(tzinfo=MADRID).timestamp())


NOW = at("2026-11-20 08:00")  # a Friday


def clock(now: float = NOW) -> Wall:
    w = Wall()
    w.now = float(now)
    return w


@pytest.fixture
def path(tmp_path: Path) -> Path:
    return tmp_path / "blob.db"


def pills(**extra: Any) -> dict[str, Any]:
    return {
        "key": "repeat-pastillas",
        "source": "reminder",
        "urgency": "urgent",
        "text": "Toca tomar las pastillas.",
        "repeat": "daily 09:00",
        **extra,
    }


# The HTTP contract


@pytest.fixture
def wall() -> Wall:
    return clock()


@pytest.fixture
def api(app_factory: Any, wall: Wall) -> Iterator[TestClient]:
    with TestClient(app_factory(wall=wall, tz="Europe/Madrid")) as c:
        wait_ready(c)
        yield c


def test_post_list_and_cancel(api: TestClient) -> None:
    r = api.post("/alerts", json=pills(), headers=AUTH)
    assert r.status_code == 201
    assert r.json() == {
        "key": "repeat-pastillas",
        "state": "pending",
        "fire_at": at("2026-11-20 09:00"),
        "repeat": "daily 09:00",
    }
    body = pills(key="repeat-basura", text="Saca la basura.", repeat="weekly tue 20:00")
    assert api.post("/alerts", json=body, headers=AUTH).status_code == 201
    got = {x["key"]: x for x in api.get("/alerts", headers=AUTH).json()}
    assert got["repeat-basura"]["repeat"] == "weekly tue 20:00"
    assert got["repeat-basura"]["fire_at"] == at("2026-11-24 20:00")
    assert api.delete("/alerts/repeat-pastillas", headers=AUTH).status_code == 204
    assert [x["key"] for x in api.get("/alerts", headers=AUTH).json()] == ["repeat-basura"]


def test_repeat_is_stored_in_canonical_form(api: TestClient) -> None:
    r = api.post("/alerts", json=pills(repeat="weekly thu,mon 08:30"), headers=AUTH)
    assert r.json()["repeat"] == "weekly mon,thu 08:30"
    assert r.json()["fire_at"] == at("2026-11-23 08:30")


@pytest.mark.parametrize(
    "extra",
    [
        {"repeat": "cada día a las 9"},
        {"repeat": "daily 9:00"},
        {"repeat": "weekly martes 20:00"},
        {"repeat": "every 1 days 10:00"},
        {"repeat": ""},
        {"repeat": 9},
        {"repeat": ["daily 09:00"]},
        {"repeat": "daily 09:00", "in_s": 60},
        {"repeat": "daily 09:00", "fire_at": "2026-11-21T09:00:00"},  # still needs an offset
        {"repeats": "daily 09:00"},  # unknown field
    ],
)
def test_bad_repeat_is_422(api: TestClient, extra: dict[str, Any]) -> None:
    body = {**pills(), **extra}
    if "repeats" in extra:
        del body["repeat"]
    assert api.post("/alerts", json=body, headers=AUTH).status_code == 422
    assert api.get("/alerts", headers=AUTH).json() == []


def test_explicit_null_repeat_is_a_one_off(api: TestClient) -> None:
    r = api.post("/alerts", json=pills(repeat=None), headers=AUTH)
    assert r.json() == {
        "key": "repeat-pastillas",
        "state": "active",
        "fire_at": None,
        "repeat": None,
    }


# The life cycle


async def test_fires_then_heard_waits_for_tomorrow(path: Path) -> None:
    r = Rig(path, clock())
    await r.post(**pills())
    assert r.state("repeat-pastillas") == "pending"
    r.wall.now = at("2026-11-20 09:00")
    await r.alerts.tick()
    a = r.alerts.rows["repeat-pastillas"]
    assert (a.state, a.activated_at, a.late) == ("active", at("2026-11-20 09:00"), False)
    assert [i.key for i in r.alerts.items()] == ["repeat-pastillas"]

    r.wall.now = at("2026-11-20 09:05")
    await r.alerts.ack("repeat-pastillas")
    a = r.alerts.rows["repeat-pastillas"]
    assert (a.state, a.fire_at, a.activated_at, a.acked_at) == (
        "pending",
        at("2026-11-21 09:00"),
        None,
        None,
    )
    assert r.alerts.items() == []

    r.wall.now = at("2026-11-21 09:00")  # it rings again by itself the next day
    await r.alerts.tick()
    a = r.alerts.rows["repeat-pastillas"]
    assert (a.state, a.activated_at) == ("active", at("2026-11-21 09:00"))
    # The saved row is the same after a restart.
    r2 = Rig(path, r.wall)
    await r2.alerts.load()
    assert r2.alerts.rows["repeat-pastillas"] == a


async def test_unheard_stays_on_screen_and_skips_missed_days(path: Path) -> None:
    r = Rig(path, clock())
    await r.post(**pills())
    r.wall.now = at("2026-11-20 09:00")
    await r.alerts.tick()
    r.changes = 0
    r.wall.now = at("2026-11-22 10:00")  # two more nine o'clocks went by
    await r.alerts.tick()
    a = r.alerts.rows["repeat-pastillas"]
    assert (a.state, a.activated_at) == ("active", at("2026-11-20 09:00"))  # not re-raised
    assert r.changes == 0
    await r.alerts.ack("repeat-pastillas")
    assert r.alerts.rows["repeat-pastillas"].fire_at == at("2026-11-23 09:00")


async def test_ttl_rearms_instead_of_deleting(path: Path) -> None:
    r = Rig(path, clock())
    await r.post(**pills(ttl_s=3600))
    r.wall.now = at("2026-11-20 09:00")
    await r.alerts.tick()
    r.wall.now = at("2026-11-20 10:00")
    await r.alerts.tick()
    a = r.alerts.rows["repeat-pastillas"]
    assert (a.state, a.fire_at, a.activated_at) == ("pending", at("2026-11-21 09:00"), None)
    assert r.alerts.items() == []


async def test_never_acked_so_never_swept(path: Path) -> None:
    r = Rig(path, clock())
    await r.post(**pills())
    r.wall.now = at("2026-11-20 09:00")
    await r.alerts.tick()
    await r.alerts.ack("repeat-pastillas")
    r.wall.now = at("2026-11-20 09:00") + ACKED_KEEP_S + 1
    await r.alerts.tick()
    assert r.state("repeat-pastillas") == "active"  # rang again; the 24 h sweep is for acked rows


async def test_restart_fires_the_last_missed_occurrence_once(path: Path) -> None:
    r = Rig(path, clock())
    await r.post(**pills())
    r.wall.now = at("2026-11-23 12:00")  # down from Friday 08:00 until Monday noon
    r2 = Rig(path, r.wall)
    await r2.alerts.load()
    a = r2.alerts.rows["repeat-pastillas"]
    assert (a.state, a.late, a.fire_at, a.activated_at) == (
        "active",
        True,
        at("2026-11-23 09:00"),
        at("2026-11-23 09:00"),
    )
    r3 = Rig(path, r.wall)  # a second restart does not fire it again
    await r3.alerts.load()
    assert r3.alerts.rows["repeat-pastillas"] == a
    await r3.alerts.ack("repeat-pastillas")
    a = r3.alerts.rows["repeat-pastillas"]
    assert (a.state, a.late, a.fire_at) == ("pending", False, at("2026-11-24 09:00"))


async def test_restart_after_its_ttl_waits_for_the_next(path: Path) -> None:
    r = Rig(path, clock())
    await r.post(**pills(ttl_s=3600))
    r.wall.now = at("2026-11-23 12:00")
    r2 = Rig(path, r.wall)
    await r2.alerts.load()
    a = r2.alerts.rows["repeat-pastillas"]
    assert (a.state, a.late, a.fire_at) == ("pending", False, at("2026-11-24 09:00"))
    r3 = Rig(path, r.wall)
    await r3.alerts.load()
    assert r3.alerts.rows["repeat-pastillas"].fire_at == at("2026-11-24 09:00")


async def test_resending_the_same_rule_changes_nothing(path: Path) -> None:
    r = Rig(path, clock())
    await r.post(**pills())
    r.changes = 0
    r.wall.now = NOW + 600
    await r.post(**pills())  # pending: same next occurrence
    assert r.changes == 0
    r.wall.now = at("2026-11-20 09:00")
    await r.alerts.tick()
    r.changes = 0
    r.wall.now = at("2026-11-20 09:10")
    a, new = await r.alerts.upsert(AlertIn(**pills()))
    assert (a.state, new, r.changes) == ("active", False, 0)  # still ringing, not dismissed


@pytest.mark.parametrize(
    "change",
    [{"text": "Las pastillas de la noche."}, {"urgency": "info"}, {"repeat": "daily 21:00"}],
)
async def test_a_changed_rule_reschedules(path: Path, change: dict[str, Any]) -> None:
    r = Rig(path, clock())
    await r.post(**pills())
    r.wall.now = at("2026-11-20 09:00")
    await r.alerts.tick()
    r.wall.now = at("2026-11-20 09:10")
    await r.post(**pills(**change))
    a = r.alerts.rows["repeat-pastillas"]
    want = at("2026-11-20 21:00") if "repeat" in change else at("2026-11-21 09:00")
    assert (a.state, a.fire_at, a.activated_at) == ("pending", want, None)


async def test_a_one_off_post_ends_the_repetition(path: Path) -> None:
    r = Rig(path, clock())
    await r.post(**pills())
    await r.post(**{**pills(), "repeat": None, "in_s": 60})
    a = r.alerts.rows["repeat-pastillas"]
    assert (a.state, a.repeat, a.fire_at) == ("pending", None, NOW + 60)


async def test_every_n_days_with_a_start(path: Path) -> None:
    r = Rig(path, clock())
    start = "2026-11-21T00:00:00+01:00"  # "starting tomorrow"
    await r.post(**pills(key="plantas", repeat="every 4 days 10:00", fire_at=start))
    assert r.alerts.rows["plantas"].fire_at == at("2026-11-21 10:00")
    # A start in the past keeps its series: watered Monday 16th, so next is Friday 20th...
    await r.post(**pills(key="p2", repeat="every 4 days 10:00", fire_at=at("2026-11-16 10:00")))
    assert r.alerts.rows["p2"].fire_at == at("2026-11-20 10:00")
    # ...and after it rings and is heard late, Tuesday 24th.
    r.wall.now = at("2026-11-21 19:00")
    await r.alerts.tick()
    await r.alerts.ack("p2")
    assert r.alerts.rows["p2"].fire_at == at("2026-11-24 10:00")


async def test_nine_stays_nine_after_the_clock_change(path: Path) -> None:
    r = Rig(path, clock(at("2026-10-24 08:00")))  # autumn change on the night of the 25th
    await r.post(**pills())
    r.wall.now = at("2026-10-24 09:00")
    await r.alerts.tick()
    await r.alerts.ack("repeat-pastillas")
    fire_at = r.alerts.rows["repeat-pastillas"].fire_at
    assert fire_at is not None
    assert datetime.fromtimestamp(fire_at, MADRID).isoformat() == "2026-10-25T09:00:00+01:00"


async def test_a_recurring_timer_has_no_countdown(path: Path) -> None:
    r = Rig(path, clock())
    await r.post(key="t", source="timer", text="Fin", in_s=60)
    await r.post(key="rt", source="timer", text="Fin", repeat="daily 09:00")
    assert [t.key for t in r.alerts.timers()] == ["t"]
