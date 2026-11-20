import json
from typing import Any

import httpx
import pytest
from fastapi.testclient import TestClient

from blob.weather import WeatherService, kind_of, parse
from tests.conftest import signed_in

AUTH = signed_in()

BODY = {
    "utc_offset_seconds": 3600,
    "current": {"temperature_2m": 17.4, "weather_code": 61, "is_day": 1},
    "hourly": {
        "time": ["2026-11-19T00:00", "2026-11-19T01:00", "2026-11-19T02:00"],
        "weather_code": [0, 61, 3],
        "temperature_2m": [10.2, 9.8, 9.1],
        "precipitation_probability": [0, 70, 20],
        "is_day": [0, 0, 0],
    },
    "daily": {
        "time": ["2026-11-19", "2026-11-20"],
        "weather_code": [61, 0],
        "temperature_2m_max": [18.2, 21.0],
        "temperature_2m_min": [11.0, 9.5],
        "precipitation_probability_max": [80, 5],
    },
}


def open_meteo(calls: list[httpx.Request], body: dict[str, Any] = BODY) -> httpx.MockTransport:
    def handle(req: httpx.Request) -> httpx.Response:
        calls.append(req)
        return httpx.Response(200, text=json.dumps(body))

    return httpx.MockTransport(handle)


@pytest.mark.parametrize(
    ("code", "kind"),
    [
        (0, "clear"),
        (1, "clear"),
        (2, "partly"),
        (3, "cloudy"),
        (45, "fog"),
        (51, "rain"),
        (63, "rain"),
        (66, "rain"),
        (73, "snow"),
        (85, "snow"),
        (81, "rain"),
        (95, "storm"),
        (99, "storm"),
    ],
)
def test_kind_of(code: int, kind: str) -> None:
    assert kind_of(code) == kind


def test_parse() -> None:
    w = parse(BODY, 100.0)
    assert w.current.temp == 17.4 and w.current.kind == "rain" and w.current.day
    assert [d.kind for d in w.days] == ["rain", "clear"]
    assert w.days[1].max == 21.0 and w.days[1].min == 9.5 and w.days[0].rain == 80


H0 = 1795042800.0  # 2026-11-19T00:00+01:00


def test_parse_hours() -> None:
    hours = parse(BODY, 0).hours
    assert [h.time for h in hours] == [H0, H0 + 3600, H0 + 7200]
    assert [h.kind for h in hours] == ["clear", "rain", "cloudy"]
    assert hours[1].temp == 9.8 and hours[1].rain == 70 and not hours[1].day


def test_parse_without_hours() -> None:
    body = json.loads(json.dumps(BODY))
    del body["hourly"]
    assert parse(body, 0).hours == []


async def test_current_serves_hours_from_the_current_one() -> None:
    now = [H0 + 3600 + 1800]  # 01:30
    svc = WeatherService(0, 0, 1200, transport=open_meteo([]), wall=lambda: now[0])
    await svc.fetch()
    assert [h.time for h in svc.current().hours] == [H0 + 3600, H0 + 7200]  # type: ignore[union-attr]
    assert len(svc.latest.hours) == 3  # type: ignore[union-attr]
    await svc.aclose()


def test_parse_without_rain_chance() -> None:
    body = json.loads(json.dumps(BODY))
    del body["daily"]["precipitation_probability_max"]
    assert [d.rain for d in parse(body, 0).days] == [None, None]


async def test_fetch_sends_place_and_keeps_latest() -> None:
    calls: list[httpx.Request] = []
    svc = WeatherService(41.4, 2.2, 1200, transport=open_meteo(calls), wall=lambda: 50.0)
    assert svc.current() is None
    await svc.fetch()
    assert calls[0].url.params["latitude"] == "41.4" and calls[0].url.params["forecast_days"] == "7"
    assert "precipitation_probability" in calls[0].url.params["hourly"]
    assert svc.current() is not None and svc.current().updated == 50.0  # type: ignore[union-attr]
    await svc.aclose()


async def test_stale_weather_is_dropped() -> None:
    now = [0.0]
    svc = WeatherService(0, 0, 1200, transport=open_meteo([]), wall=lambda: now[0])
    await svc.fetch()
    now[0] = 7 * 3600
    assert svc.current() is None
    await svc.aclose()


def test_weather_off_by_default(client: TestClient) -> None:
    assert client.get("/weather", headers=AUTH).status_code == 404


def test_weather_needs_a_session(app_factory: Any) -> None:
    with TestClient(app_factory(weather_lat=1, weather_lon=2)) as c:
        assert c.get("/weather").status_code == 401


def test_weather_route(app_factory: Any) -> None:
    calls: list[httpx.Request] = []
    app = app_factory(weather_lat=41.4, weather_lon=2.2, weather_transport=open_meteo(calls))
    with TestClient(app) as c:
        for _ in range(200):
            r = c.get("/weather", headers=AUTH)
            if r.status_code == 200:
                break
        assert r.status_code == 200
        body = r.json()
        assert body["current"] == {"temp": 17.4, "kind": "rain", "day": True}
        assert len(body["days"]) == 2
