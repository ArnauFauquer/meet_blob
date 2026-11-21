"""Recurring alerts: the `repeat` rule of POST /alerts and its next occurrence in local time.

Three forms, lowercase, one space between words, a 24 h local time at the end:

    daily HH:MM
    weekly DAY[,DAY...] HH:MM     DAY is mon tue wed thu fri sat sun, no repeats
    every N days HH:MM            N from 2 to 365

The time is wall-clock time in Blob's zone (TZ, Europe/Madrid by default), so "09:00" stays 09:00
across a daylight saving change. A time that does not exist on the spring-forward night (02:00 to
02:59 in Madrid) rings one hour later; one that happens twice in autumn rings the first time.

An occurrence is a UTC epoch second. `every N days` counts calendar days from an anchor
occurrence (the previous one), so the series keeps its rhythm whatever the clock change does.
"""

import math
import re
from dataclasses import dataclass
from datetime import date, datetime, time, timedelta, tzinfo

DAYS = ("mon", "tue", "wed", "thu", "fri", "sat", "sun")
MAX_EVERY_DAYS = 365

_FORM = re.compile(
    r"(?P<kind>daily|weekly (?P<days>[a-z]{3}(?:,[a-z]{3})*)|every (?P<n>[1-9]\d{0,2}) days)"
    r" (?P<hh>[01]\d|2[0-3]):(?P<mm>[0-5]\d)"
)


@dataclass(frozen=True)
class Repeat:
    at: time
    every_days: int = 1  # 1 for daily and weekly
    weekdays: tuple[int, ...] = ()  # weekly only: Monday is 0, sorted

    def __str__(self) -> str:
        hhmm = f"{self.at:%H:%M}"
        if self.weekdays:
            return f"weekly {','.join(DAYS[d] for d in self.weekdays)} {hhmm}"
        if self.every_days > 1:
            return f"every {self.every_days} days {hhmm}"
        return f"daily {hhmm}"

    def _on(self, d: date, tz: tzinfo) -> int:
        return int(datetime.combine(d, self.at, tzinfo=tz).timestamp())

    def first_at_or_after(self, t: float, tz: tzinfo) -> int:
        """The earliest matching day at `at`, at or after t. Anchors an `every N days` series."""
        d0 = datetime.fromtimestamp(t, tz).date()
        for i in range(9):  # a week plus a day covers any weekday set and the DST shifts
            d = d0 + timedelta(days=i)
            if self.weekdays and d.weekday() not in self.weekdays:
                continue
            ts = self._on(d, tz)
            if ts >= t:
                return ts
        raise AssertionError("no occurrence within 9 days")  # pragma: no cover

    def next_after(self, occurrence: int, now: float, tz: tzinfo) -> int:
        """The first occurrence of the series through `occurrence` that is later than both."""
        base = max(float(occurrence), now)
        if self.every_days == 1:  # daily and weekly have no anchor
            return self.first_at_or_after(math.floor(base) + 1, tz)
        anchor = datetime.fromtimestamp(occurrence, tz).date()
        gap = (datetime.fromtimestamp(base, tz).date() - anchor).days
        k = max(1, gap // self.every_days)  # never past the answer: that day is not after base
        while (ts := self._on(anchor + timedelta(days=k * self.every_days), tz)) <= base:
            k += 1
        return ts

    def latest_at_or_before(self, occurrence: int, now: float, tz: tzinfo) -> int:
        """The last occurrence of the series through `occurrence` that is not after now."""
        last = occurrence
        while (nxt := self.next_after(last, last, tz)) <= now:
            last = nxt
        return last


def parse(text: str) -> Repeat:
    """A Repeat from its text form. ValueError (a 422 for POST /alerts) for anything else."""
    m = _FORM.fullmatch(text)
    if m is None:
        raise ValueError(
            "repeat must be 'daily HH:MM', 'weekly mon,thu HH:MM' or 'every N days HH:MM'"
        )
    at = time(int(m["hh"]), int(m["mm"]))
    if m["days"] is not None:
        names = m["days"].split(",")
        if any(n not in DAYS for n in names):
            raise ValueError(f"repeat days must be among {','.join(DAYS)}")
        if len(set(names)) != len(names):
            raise ValueError("repeat days must not repeat")
        return Repeat(at=at, weekdays=tuple(sorted(DAYS.index(n) for n in names)))
    if m["n"] is not None:
        n = int(m["n"])
        if not 2 <= n <= MAX_EVERY_DAYS:
            raise ValueError(f"every N days needs N from 2 to {MAX_EVERY_DAYS} (use daily for 1)")
        return Repeat(at=at, every_days=n)
    return Repeat(at=at)
