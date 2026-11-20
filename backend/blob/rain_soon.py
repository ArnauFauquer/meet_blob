"""Rain soon: one calm alert when rain is about to start, to bring the washing in.

Every RAIN_FETCH_S the watcher asks Open-Meteo for the precipitation of the next three hours in
15 minute steps (`minutely_15`), and every CHECK_S it looks at the last answer. When the next wet
quarter starts within RAIN_SOON_LEAD_MIN, it raises an `info` alert through the alert store
("Empieza a llover en 20 minutos."), so every screen gets it once, through the usual snapshot.

One alert per rain episode. An episode lasts while rain is forecast and until EPISODE_GAP_S of
dry forecast after it, so a shower that stops and starts again, or a forecast that slips by a
quarter on the next fetch, does not warn twice. No alert while it is already raining, or in the
quiet window (RAIN_SOON_QUIET, local time of the place, default 22:00-08:00).

The decision is a pure function (`decide`) of the forecast, the time and the episode state, so
the tests feed it simulated forecasts.
"""

import asyncio
import logging
import time
from collections.abc import Awaitable, Callable, Sequence
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from typing import Any

import httpx

from .alerts import Alerts, TooManyAlerts
from .schemas import AlertIn
from .weather import OPEN_METEO_URL

log = logging.getLogger(__name__)

SOURCE = "rain"  # the page draws a rain cloud for this source
KEY_PREFIX = "rain-soon-"
QUARTER_S = 15 * 60
WET_MM = 0.1  # precipitation in one quarter that counts as rain (Open-Meteo's smallest step)
EPISODE_GAP_S = 2 * 3600  # this long without rain ends an episode
FETCH_S = 10 * 60  # Open-Meteo's short-range models update about hourly; this keeps the lead
RETRY_S = 60
CHECK_S = 60
STALE_S = 3600  # an older forecast is not used
AFTER_START_S = 30 * 60  # the alert goes away this long after the rain was due

# Per language: the time ("{n}" minutes, or a few), then the hint about the washing.
TEXTS = {
    "es": (
        "Empieza a llover en {n} minutos.",
        "Empieza a llover en unos minutos.",
        "Si hay ropa tendida, es buen momento para recogerla.",
    ),
    "ca": (
        "Començarà a ploure d'aquí a {n} minuts.",
        "Començarà a ploure d'aquí a uns minuts.",
        "Si hi ha roba estesa, és bon moment per recollir-la.",
    ),
    "en": (
        "Rain starts in {n} minutes.",
        "Rain starts in a few minutes.",
        "If there is washing out, now is a good time to bring it in.",
    ),
}


@dataclass(frozen=True)
class Quarter:
    start: float  # unix time; the quarter is [start, start + QUARTER_S)
    mm: float | None  # precipitation in it, None when the model has no value

    @property
    def wet(self) -> bool:
        return self.mm is not None and self.mm >= WET_MM


@dataclass(frozen=True)
class Forecast:
    quarters: list[Quarter]
    utc_offset_s: int  # of the place, for the quiet window
    fetched: float


@dataclass(frozen=True)
class Warn:
    start: float  # when the rain starts
    minutes: int  # rounded to 5, 0 for "a few minutes"


@dataclass(frozen=True)
class Decision:
    warn: Warn | None
    episode_until: float  # the new episode state


def parse(body: dict[str, Any], now: float) -> Forecast:
    """Open-Meteo's `minutely_15` precipitation is the sum over the 15 minutes *before* each
    time stamp, and the times are local to the place (offset by utc_offset_seconds)."""
    offset = int(body.get("utc_offset_seconds", 0))
    tz = timezone(timedelta(seconds=offset))
    m = body.get("minutely_15") or {}
    times, mm = m.get("time") or [], m.get("precipitation") or []
    quarters = [
        Quarter(datetime.fromisoformat(t).replace(tzinfo=tz).timestamp() - QUARTER_S, p)
        for t, p in zip(times, mm, strict=True)
    ]
    return Forecast(quarters, offset, now)


def parse_window(spec: str) -> tuple[int, int] | None:
    """'22:00-08:00' to minutes of the day (start, end); empty: no window."""
    if not spec:
        return None
    a, b = spec.split("-")
    return tuple(int(x[:2]) * 60 + int(x[3:]) for x in (a, b))  # type: ignore[return-value]


def in_window(window: tuple[int, int] | None, now: float, utc_offset_s: int) -> bool:
    if window is None:
        return False
    local = datetime.fromtimestamp(now, timezone(timedelta(seconds=utc_offset_s)))
    m = local.hour * 60 + local.minute
    start, end = window
    return start <= m < end if start <= end else m >= start or m < end


def decide(
    quarters: Sequence[Quarter],
    now: float,
    episode_until: float,
    *,
    lead_s: float,
    quiet: bool,
) -> Decision:
    """Whether to warn now, and the episode state after this look at the forecast."""
    # Rain now or just before (the forecast keeps the last quarter): the episode goes on until
    # EPISODE_GAP_S after it, and there is nothing to warn about while it rains.
    wet_ends = [q.start + QUARTER_S for q in quarters if q.wet and q.start <= now]
    if wet_ends:
        episode_until = max(episode_until, max(wet_ends) + EPISODE_GAP_S)
    if any(now < end for end in wet_ends):
        return Decision(None, episode_until)
    nxt = next((q for q in quarters if q.wet and now < q.start <= now + lead_s), None)
    if nxt is None:
        return Decision(None, episode_until)
    if now < episode_until:
        # The same episode: a shower after a short break, or a forecast that slipped.
        return Decision(None, max(episode_until, nxt.start + EPISODE_GAP_S))
    if quiet:
        return Decision(None, episode_until)
    minutes = round((nxt.start - now) / 300) * 5
    return Decision(Warn(nxt.start, minutes), nxt.start + EPISODE_GAP_S)


def alert_for(w: Warn, now: float, utc_offset_s: int, lang: str) -> AlertIn:
    """The alert: a key stable for the episode (its start in local time), gone after the rain
    has been on for a while."""
    many, few, hint = TEXTS.get(lang, TEXTS["es"])
    local = datetime.fromtimestamp(w.start, timezone(timedelta(seconds=utc_offset_s)))
    return AlertIn(
        key=f"{KEY_PREFIX}{local:%Y%m%d-%H%M}",
        source=SOURCE,
        urgency="info",
        lang=lang,
        text=f"{many.format(n=w.minutes) if w.minutes >= 5 else few} {hint}",
        ttl_s=max(60, round(w.start - now) + AFTER_START_S),
    )


class RainWatch:
    def __init__(
        self,
        lat: float,
        lon: float,
        alerts: Alerts,
        *,
        lead_min: int = 30,
        quiet: str = "22:00-08:00",
        model: str = "best_match",
        lang: str = "es",
        transport: httpx.AsyncBaseTransport | None = None,
        wall: Callable[[], float] = time.time,
    ) -> None:
        self.lat, self.lon, self.alerts = lat, lon, alerts
        self.lead_s = lead_min * 60
        self.quiet = parse_window(quiet)
        self.model, self.lang = model, lang
        self.forecast: Forecast | None = None
        self.episode_until = 0.0
        self._wall = wall
        self._client = httpx.AsyncClient(timeout=10, transport=transport)

    async def fetch(self) -> Forecast:
        r = await self._client.get(
            OPEN_METEO_URL,
            params={
                "latitude": self.lat,
                "longitude": self.lon,
                "minutely_15": "precipitation",
                "forecast_minutely_15": 12,
                "past_minutely_15": 1,
                "models": self.model,
                "timezone": "auto",
            },
        )
        r.raise_for_status()
        self.forecast = parse(r.json(), self._wall())
        return self.forecast

    def resume(self) -> None:
        """After a restart: an alert of ours still in the store means its episode is not over."""
        for a in self.alerts.rows.values():
            if a.source == SOURCE and a.key.startswith(KEY_PREFIX):
                until = a.created_at + self.lead_s + EPISODE_GAP_S
                self.episode_until = max(self.episode_until, until)

    def check(self) -> AlertIn | None:
        """Look at the last forecast once: the alert to raise, if any."""
        f = self.forecast
        now = self._wall()
        if f is None or now - f.fetched >= STALE_S:
            return None
        d = decide(
            f.quarters,
            now,
            self.episode_until,
            lead_s=self.lead_s,
            quiet=in_window(self.quiet, now, f.utc_offset_s),
        )
        self.episode_until = d.episode_until
        return alert_for(d.warn, now, f.utc_offset_s, self.lang) if d.warn else None

    async def tick(self) -> None:
        a = self.check()
        if a is None:
            return
        try:
            await self.alerts.upsert(a)
            log.info("rain soon: %s", a.key)
        except TooManyAlerts:
            log.warning("rain soon: too many active alerts, %s dropped", a.key)

    async def run(self, sleep: Callable[[float], Awaitable[None]] = asyncio.sleep) -> None:
        self.resume()
        next_fetch = 0.0
        while True:
            now = self._wall()
            if now >= next_fetch:
                try:
                    await self.fetch()
                    next_fetch = now + FETCH_S
                except Exception as e:
                    log.warning("rain forecast fetch failed: %s", e)
                    next_fetch = now + RETRY_S
            try:
                await self.tick()
            except Exception:
                log.exception("rain soon check failed")
            await sleep(CHECK_S)

    async def aclose(self) -> None:
        await self._client.aclose()
