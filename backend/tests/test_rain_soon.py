"""Rain soon: simulated 15 minute forecasts through the decision, the watcher and the store."""

import json
from datetime import datetime, timedelta
from pathlib import Path
from typing import Any
from zoneinfo import ZoneInfo

import httpx
import pytest
from fastapi.testclient import TestClient

from blob.alerts import Alerts
from blob.db import Db
from blob.rain_soon import (
    EPISODE_GAP_S,
    STALE_S,
    Quarter,
    RainWatch,
    decide,
    in_window,
    parse,
    parse_window,
)

CET = 3600  # Barcelona in November
MADRID = ZoneInfo("Europe/Madrid")
NIGHT = "23:00-07:30"  # NIGHT_HOURS, as the page's night mode reads it
DAY = "2026-11-20"


def at(hhmm: str, day: str = DAY) -> float:
    """Unix time of a local time on DAY (UTC+1)."""
    return datetime.fromisoformat(f"{day}T{hhmm}:00+01:00").timestamp()


def body(first: str, mm: list[float | None], day: str = DAY) -> dict[str, Any]:
    """An Open-Meteo answer: quarters from `first` (local), each labelled with its *end* time,
    as Open-Meteo does (precipitation of the preceding 15 minutes)."""
    t0 = datetime.fromisoformat(f"{day}T{first}")
    labels = [
        (t0 + timedelta(minutes=15 * (i + 1))).strftime("%Y-%m-%dT%H:%M") for i in range(len(mm))
    ]
    return {
        "utc_offset_seconds": CET,
        "timezone": "Europe/Madrid",
        "minutely_15": {"time": labels, "precipitation": mm},
    }


def quarters(first: str, mm: list[float | None], day: str = DAY) -> list[Quarter]:
    return parse(body(first, mm, day), 0).quarters


LEAD = 30 * 60


def warn_at(qs: list[Quarter], now: float, episode: float = 0, night: bool = False) -> Any:
    return decide(qs, now, episode, lead_s=LEAD, night=night)


# The pure decision


def test_parse_labels_mark_the_end_of_each_quarter() -> None:
    f = parse(body("16:00", [0.0, 0.4]), 123)
    assert [q.start for q in f.quarters] == [at("16:00"), at("16:15")]
    assert [q.wet for q in f.quarters] == [False, True]
    assert f.utc_offset_s == CET and f.fetched == 123


def test_rain_in_20_minutes() -> None:
    qs = quarters("15:45", [0, 0, 0, 0.3, 0.8, 1.2])  # dry until 16:30, then rain
    d = warn_at(qs, at("16:10"))
    assert d.warn is not None and d.warn.start == at("16:30") and d.warn.minutes == 20
    assert d.episode_until == at("16:30") + EPISODE_GAP_S


def test_rain_further_than_the_lead_waits() -> None:
    qs = quarters("15:45", [0, 0, 0, 0, 0.5])  # rain at 16:45
    assert warn_at(qs, at("16:10")).warn is None  # 35 minutes away
    assert warn_at(qs, at("16:15")).warn is not None  # 30 minutes away


def test_already_raining_does_not_warn() -> None:
    qs = quarters("16:00", [0.6, 0.4, 0.0, 0.0, 0.7])
    d = warn_at(qs, at("16:05"))
    assert d.warn is None
    assert d.episode_until == at("16:15") + EPISODE_GAP_S  # the quarter now ends at 16:15


def test_rain_that_just_stopped_is_the_same_episode() -> None:
    # The forecast keeps the last quarter: rain until 16:15, dry now, more at 16:45.
    qs = quarters("16:00", [0.5, 0, 0, 0.5])
    d = warn_at(qs, at("16:20"))
    assert d.warn is None
    assert d.episode_until == at("16:45") + EPISODE_GAP_S  # the coming shower extends it


def test_intermittent_rain_warns_once() -> None:
    qs = quarters("15:45", [0, 0, 0.5, 0, 0, 0, 0.4, 0, 0.6])  # 16:15, 17:15, 17:45
    first = warn_at(qs, at("15:50"))
    assert first.warn is not None and first.warn.start == at("16:15")
    episode = first.episode_until
    for minute in range(51, 60 * 3):
        now = at("15:00") + minute * 60
        d = warn_at(qs, now, episode)
        assert d.warn is None, f"warned again at minute {minute}"
        episode = d.episode_until


def test_a_slipped_forecast_does_not_warn_twice() -> None:
    first = warn_at(quarters("15:45", [0, 0, 0.5]), at("15:55"))  # rain at 16:15
    assert first.warn is not None
    later = quarters("16:00", [0, 0, 0.5])  # the next fetch: rain at 16:30 instead
    assert warn_at(later, at("16:10"), first.episode_until).warn is None


def test_a_new_episode_after_a_long_dry_spell_warns_again() -> None:
    first = warn_at(quarters("15:45", [0, 0, 0.5]), at("15:55"))
    assert first.warn is not None
    # It rained 16:15-16:30, then nothing; rain again at 19:00.
    qs = quarters("16:00", [0, 0.5] + [0] * 9 + [0.5])
    episode = warn_at(qs, at("16:20"), first.episode_until).episode_until
    assert episode == at("16:30") + EPISODE_GAP_S
    assert warn_at(qs, at("18:25"), episode).warn is None  # 18:30 is still inside the gap
    again = warn_at(qs, at("18:40"), episode)
    assert again.warn is not None and again.warn.start == at("18:45") and again.warn.minutes == 5


def test_night_does_not_warn_and_does_not_use_up_the_episode() -> None:
    qs = quarters("03:00", [0, 0.5])
    d = warn_at(qs, at("03:05"), night=True)
    assert d.warn is None and d.episode_until == 0


def test_night_window() -> None:
    night = parse_window(NIGHT)
    assert night == (23 * 60, 7 * 60 + 30)
    assert in_window(night, at("03:00"), MADRID)
    assert in_window(night, at("23:00"), MADRID)
    assert in_window(night, at("07:29"), MADRID)
    assert not in_window(night, at("07:30"), MADRID)
    assert not in_window(night, at("22:59"), MADRID)
    assert not in_window(parse_window("13:00-15:00"), at("16:00"), MADRID)
    assert in_window(parse_window("13:00-15:00"), at("14:00"), MADRID)
    assert parse_window("") is None
    assert not in_window(None, at("03:00"), MADRID)


def test_night_window_follows_tz_across_daylight_saving() -> None:
    # 07:00 in Madrid is 06:00 UTC in winter and 05:00 UTC in summer: the window is wall-clock.
    night = parse_window(NIGHT)
    assert in_window(night, at("07:00"), MADRID)
    summer = datetime.fromisoformat("2026-07-01T07:00:00+02:00").timestamp()
    assert in_window(night, summer, MADRID)
    assert not in_window(night, summer + 3600, MADRID)  # 08:00 in summer


def test_missing_values_are_not_rain() -> None:
    qs = quarters("15:45", [0, None, None, None])
    assert warn_at(qs, at("16:00")).warn is None


def test_rain_in_a_few_minutes() -> None:
    d = warn_at(quarters("15:45", [0, 0.5]), at("15:59"))
    assert d.warn is not None and d.warn.minutes == 0


# The watcher with the real alert store


class Wall:
    def __init__(self, now: float) -> None:
        self.now = now

    def __call__(self) -> float:
        return self.now


def meteo(answers: list[dict[str, Any]], calls: list[httpx.Request]) -> httpx.MockTransport:
    def handle(req: httpx.Request) -> httpx.Response:
        calls.append(req)
        return httpx.Response(200, text=json.dumps(answers[min(len(calls), len(answers)) - 1]))

    return httpx.MockTransport(handle)


class Rig:
    def __init__(self, path: Path, now: float, answers: list[dict[str, Any]], **kw: Any) -> None:
        self.wall = Wall(now)
        self.calls: list[httpx.Request] = []
        self.db = Db(str(path))
        self.alerts = Alerts(self.db, self.changed, self.wall)
        self.watch = RainWatch(
            41.4, 2.2, self.alerts, transport=meteo(answers, self.calls), wall=self.wall, **kw
        )

    async def changed(self) -> None:
        pass

    async def minute(self, fetch: bool = False) -> None:
        if fetch:
            await self.watch.fetch()
        await self.watch.tick()
        self.wall.now += 60

    def active(self) -> list[Any]:
        return [a for a in self.alerts.rows.values() if a.state == "active"]


async def test_watch_raises_one_calm_alert(tmp_path: Path) -> None:
    r = Rig(tmp_path / "b.db", at("16:10"), [body("15:45", [0, 0, 0, 0.3, 0.8])])
    await r.minute(fetch=True)
    [a] = r.active()
    assert a.key == "rain-soon-20261120-1630"
    assert a.source == "rain" and a.urgency == "info" and a.lang == "es"
    assert a.text == (
        "Empieza a llover en 20 minutos. Si hay ropa tendida, es buen momento para recogerla."
    )
    assert a.ttl_s == 20 * 60 + 30 * 60  # gone half an hour after the rain was due
    for _ in range(15):
        await r.minute(fetch=True)  # every refresh says the same: no second alert
    assert len(r.alerts.rows) == 1
    req = r.calls[0].url.params
    assert req["minutely_15"] == "precipitation" and req["models"] == "best_match"
    assert req["timezone"] == "auto"
    await r.watch.aclose()


async def test_watch_after_a_tap_does_not_raise_again(tmp_path: Path) -> None:
    r = Rig(tmp_path / "b.db", at("16:10"), [body("15:45", [0, 0, 0, 0.3, 0.8])])
    await r.minute(fetch=True)
    [a] = r.active()
    await r.alerts.ack(a.key)
    for _ in range(10):
        await r.minute(fetch=True)
    assert [x.state for x in r.alerts.rows.values()] == ["acked"]
    await r.watch.aclose()


async def test_watch_when_it_already_rains(tmp_path: Path) -> None:
    r = Rig(tmp_path / "b.db", at("16:05"), [body("16:00", [0.6, 0.2, 0, 0, 0.7, 0.7])])
    for _ in range(60):
        await r.minute(fetch=True)
    assert r.alerts.rows == {}
    await r.watch.aclose()


async def test_watch_at_night_waits_for_the_morning(tmp_path: Path) -> None:
    # NIGHT_HOURS 23:00-07:30, rain due at 07:45: in the lead from 07:15, but that is night.
    r = Rig(tmp_path / "b.db", at("07:10"), [body("07:00", [0, 0, 0, 0.4])], night=NIGHT)
    for _ in range(20):
        await r.minute(fetch=True)
    assert r.alerts.rows == {}  # 07:10 to 07:29: night, nothing is created
    await r.minute(fetch=True)  # 07:30, the night is over and the rain is still coming
    [a] = r.active()
    assert a.urgency == "info" and "15 minutos" in a.text
    await r.watch.aclose()


async def test_watch_rain_through_the_night_is_not_announced_at_dawn(tmp_path: Path) -> None:
    # It rains from 06:00 to 08:00: at 07:30 it is already raining, so no alert.
    r = Rig(tmp_path / "b.db", at("06:30"), [body("05:45", [0] + [0.5] * 8)], night=NIGHT)
    for _ in range(90):
        await r.minute(fetch=True)
    assert r.alerts.rows == {}
    await r.watch.aclose()


async def test_watch_without_night_hours_has_no_night(tmp_path: Path) -> None:
    r = Rig(tmp_path / "b.db", at("03:05"), [body("03:00", [0, 0.5])])
    await r.minute(fetch=True)
    assert len(r.active()) == 1
    await r.watch.aclose()


async def test_watch_reads_the_night_in_tz_not_in_the_forecast(tmp_path: Path) -> None:
    # The forecast is in Madrid time (UTC+1); TZ=UTC puts 08:10 Madrid at 07:10, still night.
    r = Rig(
        tmp_path / "b.db", at("08:10"), [body("08:00", [0, 0.5])], night=NIGHT, tz=ZoneInfo("UTC")
    )
    await r.minute(fetch=True)
    assert r.alerts.rows == {}
    r2 = Rig(tmp_path / "c.db", at("08:10"), [body("08:00", [0, 0.5])], night=NIGHT, tz=MADRID)
    await r2.minute(fetch=True)
    assert len(r2.active()) == 1
    await r.watch.aclose()
    await r2.watch.aclose()


async def test_watch_just_before_the_night_still_warns(tmp_path: Path) -> None:
    # 22:50, rain at 23:15: the alert is created; the page's night mode decides how to show it.
    r = Rig(tmp_path / "b.db", at("22:50"), [body("22:45", [0, 0, 0.5])], night=NIGHT)
    await r.minute(fetch=True)
    [a] = r.active()
    assert a.key == "rain-soon-20261120-2315"
    await r.watch.aclose()


async def test_watch_language_and_lead(tmp_path: Path) -> None:
    r = Rig(
        tmp_path / "b.db", at("16:00"), [body("15:45", [0] * 4 + [0.5])], lang="ca", lead_min=60
    )
    await r.minute(fetch=True)
    [a] = r.active()
    assert a.lang == "ca" and a.text.startswith("Començarà a ploure d'aquí a 45 minuts.")
    await r.watch.aclose()


async def test_watch_ignores_a_stale_forecast(tmp_path: Path) -> None:
    r = Rig(tmp_path / "b.db", at("15:00"), [body("15:45", [0, 0, 0.5])])
    await r.watch.fetch()
    r.wall.now = at("15:00") + STALE_S
    await r.watch.tick()
    assert r.alerts.rows == {}
    await r.watch.aclose()


async def test_watch_after_a_restart_keeps_the_episode(tmp_path: Path) -> None:
    path = tmp_path / "b.db"
    r = Rig(path, at("16:10"), [body("15:45", [0, 0, 0, 0.3])])
    await r.minute(fetch=True)
    assert len(r.active()) == 1
    await r.watch.aclose()
    # Restart at 16:20: the forecast now says 16:45 (a different key), same episode.
    r2 = Rig(path, at("16:20"), [body("16:00", [0, 0, 0, 0.3])])
    await r2.alerts.load()
    r2.watch.resume()
    await r2.minute(fetch=True)
    assert list(r2.alerts.rows) == ["rain-soon-20261120-1630"]
    await r2.watch.aclose()


async def test_watch_run_fetches_and_checks(tmp_path: Path) -> None:
    r = Rig(tmp_path / "b.db", at("16:10"), [body("15:45", [0, 0, 0, 0.3])])
    sleeps: list[float] = []

    async def sleep(s: float) -> None:
        sleeps.append(s)
        r.wall.now += s
        if len(sleeps) == 12:
            raise RuntimeError("stop")

    with pytest.raises(RuntimeError):
        await r.watch.run(sleep)
    assert len(r.calls) == 2  # at 16:10 and ten minutes later
    assert len(r.active()) == 1
    await r.watch.aclose()


async def test_watch_run_survives_a_failed_fetch(tmp_path: Path) -> None:
    def fail(_: httpx.Request) -> httpx.Response:
        return httpx.Response(500)

    r = Rig(tmp_path / "b.db", at("16:10"), [])
    r.watch._client = httpx.AsyncClient(transport=httpx.MockTransport(fail))
    n = 0

    async def sleep(_: float) -> None:
        nonlocal n
        n += 1
        if n == 3:
            raise RuntimeError("stop")

    with pytest.raises(RuntimeError):
        await r.watch.run(sleep)
    assert r.watch.forecast is None and r.alerts.rows == {}
    await r.watch.aclose()


# Wiring


def test_rain_watch_needs_the_weather(app_factory: Any) -> None:
    with TestClient(app_factory()) as c:
        assert c.app.state.rain is None  # type: ignore[attr-defined]


def test_rain_watch_runs_with_the_weather(app_factory: Any) -> None:
    calls: list[httpx.Request] = []
    t = meteo([body("15:45", [0, 0])], calls)
    with TestClient(app_factory(weather_lat=41.4, weather_lon=2.2, weather_transport=t)) as c:
        rain = c.app.state.rain  # type: ignore[attr-defined]
        assert rain is not None and rain.lead_s == 30 * 60
        assert rain.night is None and rain.tz == MADRID  # no NIGHT_HOURS: no night
    with TestClient(
        app_factory(
            weather_lat=41.4, weather_lon=2.2, weather_transport=t, night_hours=NIGHT, tz="UTC"
        )
    ) as c:
        rain = c.app.state.rain  # type: ignore[attr-defined]
        assert rain.night == (23 * 60, 7 * 60 + 30) and rain.tz == ZoneInfo("UTC")
    with TestClient(
        app_factory(weather_lat=41.4, weather_lon=2.2, weather_transport=t, rain_soon=False)
    ) as c:
        assert c.app.state.rain is None  # type: ignore[attr-defined]
