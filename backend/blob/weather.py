"""Weather for the idle screen: the current conditions and the week ahead.

Polls Open-Meteo (no key needed) for WEATHER_LAT, WEATHER_LON every WEATHER_REFRESH_S and keeps
the last good answer, which the page reads from GET /weather. The WMO weather codes collapse into
the few kinds the blob can draw (a sun, a moon, a cloud, rain, snow, a storm, fog).
"""

import asyncio
import logging
import time
from typing import Any, Literal

import httpx
from fastapi import APIRouter, Depends, HTTPException, Request
from pydantic import BaseModel

from .auth import require_user

log = logging.getLogger(__name__)

OPEN_METEO_URL = "https://api.open-meteo.com/v1/forecast"
RETRY_S = 60  # after a failed fetch
STALE_S = 6 * 3600  # older than this, the page stops showing it

Kind = Literal["clear", "partly", "cloudy", "fog", "rain", "snow", "storm"]


def kind_of(code: int) -> Kind:
    """WMO weather interpretation code (Open-Meteo `weather_code`) to a kind."""
    if code <= 1:
        return "clear"
    if code == 2:
        return "partly"
    if code == 3:
        return "cloudy"
    if code in (45, 48):
        return "fog"
    if 71 <= code <= 77 or code in (85, 86):
        return "snow"
    if code >= 95:
        return "storm"
    return "rain"  # drizzle, rain, freezing rain, showers


class Current(BaseModel):
    temp: float
    kind: Kind
    day: bool  # daylight: a clear night shows the moon


class Day(BaseModel):
    date: str  # YYYY-MM-DD, local to the place
    kind: Kind
    max: float
    min: float
    rain: int | None  # highest chance of precipitation, %


class Weather(BaseModel):
    current: Current
    days: list[Day]
    updated: float  # unix time of the fetch


def parse(body: dict[str, Any], now: float) -> Weather:
    c = body["current"]
    d = body["daily"]
    rain = d.get("precipitation_probability_max") or [None] * len(d["time"])
    return Weather(
        current=Current(
            temp=c["temperature_2m"], kind=kind_of(c["weather_code"]), day=bool(c["is_day"])
        ),
        days=[
            Day(date=t, kind=kind_of(code), max=hi, min=lo, rain=r)
            for t, code, hi, lo, r in zip(
                d["time"],
                d["weather_code"],
                d["temperature_2m_max"],
                d["temperature_2m_min"],
                rain,
                strict=True,
            )
        ],
        updated=now,
    )


class WeatherService:
    def __init__(
        self,
        lat: float,
        lon: float,
        refresh_s: float,
        *,
        transport: httpx.AsyncBaseTransport | None = None,
        wall: Any = time.time,
    ) -> None:
        self.lat = lat
        self.lon = lon
        self.refresh_s = refresh_s
        self.latest: Weather | None = None
        self._wall = wall
        self._client = httpx.AsyncClient(timeout=10, transport=transport)

    async def fetch(self) -> Weather:
        r = await self._client.get(
            OPEN_METEO_URL,
            params={
                "latitude": self.lat,
                "longitude": self.lon,
                "current": "temperature_2m,weather_code,is_day",
                "daily": "weather_code,temperature_2m_max,temperature_2m_min,"
                "precipitation_probability_max",
                "timezone": "auto",
                "forecast_days": 7,
            },
        )
        r.raise_for_status()
        self.latest = parse(r.json(), self._wall())
        return self.latest

    async def run(self) -> None:
        while True:
            try:
                await self.fetch()
                wait = self.refresh_s
            except Exception as e:
                log.warning("weather fetch failed: %s", e)
                wait = RETRY_S
            await asyncio.sleep(wait)

    def current(self) -> Weather | None:
        w = self.latest
        return w if w and self._wall() - w.updated < STALE_S else None

    async def aclose(self) -> None:
        await self._client.aclose()


router = APIRouter()


@router.get("/weather", dependencies=[Depends(require_user)])
async def weather(request: Request) -> Weather:
    svc: WeatherService | None = request.app.state.weather
    if svc is None:
        raise HTTPException(status_code=404, detail="weather is off (set WEATHER_LAT, WEATHER_LON)")
    w = svc.current()
    if w is None:
        raise HTTPException(status_code=503, detail="no weather yet")
    return w
