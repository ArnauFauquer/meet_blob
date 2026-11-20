"""The repeat rule: strict parsing, next occurrences in Europe/Madrid, and the clock changes."""

from datetime import datetime
from zoneinfo import ZoneInfo

import pytest

from blob.repeat import Repeat, parse

MADRID = ZoneInfo("Europe/Madrid")


def at(text: str) -> int:
    """Epoch seconds of a Madrid wall-clock time, '2026-11-20 09:00'."""
    return int(datetime.fromisoformat(text).replace(tzinfo=MADRID).timestamp())


def local(ts: int) -> str:
    return datetime.fromtimestamp(ts, MADRID).strftime("%a %Y-%m-%d %H:%M %z")


def first(r: Repeat, when: str) -> str:
    return local(r.first_at_or_after(at(when), MADRID))


def after(r: Repeat, occurrence: int, now: str) -> str:
    return local(r.next_after(occurrence, at(now), MADRID))


@pytest.mark.parametrize(
    ("text", "canonical"),
    [
        ("daily 09:00", "daily 09:00"),
        ("daily 00:00", "daily 00:00"),
        ("daily 23:59", "daily 23:59"),
        ("weekly tue 20:00", "weekly tue 20:00"),
        ("weekly thu,mon 08:30", "weekly mon,thu 08:30"),  # days come back in week order
        ("weekly mon,tue,wed,thu,fri,sat,sun 07:15", "weekly mon,tue,wed,thu,fri,sat,sun 07:15"),
        ("every 4 days 10:00", "every 4 days 10:00"),
        ("every 2 days 10:00", "every 2 days 10:00"),
        ("every 365 days 10:00", "every 365 days 10:00"),
    ],
)
def test_valid_forms(text: str, canonical: str) -> None:
    assert str(parse(text)) == canonical


@pytest.mark.parametrize(
    "text",
    [
        "",
        "daily",
        "daily 9:00",  # hours are two digits
        "daily 24:00",
        "daily 09:60",
        "daily 09:00:00",
        "Daily 09:00",
        "daily  09:00",
        " daily 09:00",
        "daily 09:00 ",
        "daily 9am",
        "weekly 20:00",  # no day
        "weekly tuesday 20:00",
        "weekly Tue 20:00",
        "weekly mar 20:00",  # Spanish names are not accepted
        "weekly tue, thu 20:00",
        "weekly tue,tue 20:00",
        "weekly tue,,thu 20:00",
        "every 1 days 10:00",  # use daily
        "every 0 days 10:00",
        "every 366 days 10:00",
        "every 04 days 10:00",
        "every 4 day 10:00",
        "every four days 10:00",
        "every 4 weeks 10:00",
        "monthly 1 10:00",
        "FREQ=DAILY;BYHOUR=9",
    ],
)
def test_invalid_forms(text: str) -> None:
    with pytest.raises(ValueError):
        parse(text)


def test_daily_today_or_tomorrow() -> None:
    r = parse("daily 09:00")
    assert first(r, "2026-11-20 08:00") == "Fri 2026-11-20 09:00 +0100"
    assert first(r, "2026-11-20 09:00") == "Fri 2026-11-20 09:00 +0100"
    assert first(r, "2026-11-20 09:01") == "Sat 2026-11-21 09:00 +0100"
    # next_after is strictly later than both the occurrence and now
    nine = at("2026-11-20 09:00")
    assert local(r.next_after(nine, nine, MADRID)) == "Sat 2026-11-21 09:00 +0100"
    assert local(r.next_after(nine, nine + 3 * 86400, MADRID)) == "Tue 2026-11-24 09:00 +0100"


def test_weekly_picks_the_next_listed_day() -> None:
    r = parse("weekly tue 20:00")
    fri = at("2026-11-20 12:00")
    assert local(r.first_at_or_after(fri, MADRID)) == "Tue 2026-11-24 20:00 +0100"
    tue = at("2026-11-24 20:00")
    assert local(r.next_after(tue, tue, MADRID)) == "Tue 2026-12-01 20:00 +0100"
    two = parse("weekly mon,thu 08:30")
    mon = at("2026-11-23 08:30")
    assert local(two.next_after(mon, mon, MADRID)) == "Thu 2026-11-26 08:30 +0100"
    thu = at("2026-11-26 08:30")
    assert local(two.next_after(thu, thu, MADRID)) == "Mon 2026-11-30 08:30 +0100"


def test_every_n_days_keeps_its_rhythm() -> None:
    r = parse("every 4 days 10:00")
    start = at("2026-11-20 10:00")
    assert local(r.next_after(start, start, MADRID)) == "Tue 2026-11-24 10:00 +0100"
    # Heard late (two days later): the series stays on its days, it does not restart.
    assert after(r, start, "2026-11-22 18:00") == "Tue 2026-11-24 10:00 +0100"
    # Long after: still a multiple of 4 days from the anchor.
    assert after(r, start, "2027-01-01 12:00") == "Sun 2027-01-03 10:00 +0100"
    assert after(r, start, "2027-01-03 10:00") == "Thu 2027-01-07 10:00 +0100"


def test_latest_at_or_before() -> None:
    r = parse("daily 09:00")
    start = at("2026-11-20 09:00")
    assert r.latest_at_or_before(start, at("2026-11-20 10:00"), MADRID) == start
    assert local(r.latest_at_or_before(start, at("2026-11-23 08:59"), MADRID)) == (
        "Sun 2026-11-22 09:00 +0100"
    )
    every = parse("every 4 days 10:00")
    start = at("2026-11-20 10:00")
    assert local(every.latest_at_or_before(start, at("2026-12-01 00:00"), MADRID)) == (
        "Sat 2026-11-28 10:00 +0100"
    )


def test_nine_stays_nine_across_both_clock_changes() -> None:
    # Spring: 2026-03-29 02:00 -> 03:00. Autumn: 2026-10-25 03:00 -> 02:00.
    r = parse("daily 09:00")
    before = at("2026-03-28 09:00")
    after = r.next_after(before, before, MADRID)
    assert local(after) == "Sun 2026-03-29 09:00 +0200"
    assert after - before == 23 * 3600  # the short day
    oct_before = at("2026-10-24 09:00")
    oct_after = r.next_after(oct_before, oct_before, MADRID)
    assert local(oct_after) == "Sun 2026-10-25 09:00 +0100"
    assert oct_after - oct_before == 25 * 3600  # the long day
    every = parse("every 2 days 09:00")
    start = at("2026-03-28 09:00")
    assert local(every.next_after(start, start, MADRID)) == "Mon 2026-03-30 09:00 +0200"
    weekly = parse("weekly sat 09:00")
    assert local(weekly.next_after(start, start, MADRID)) == "Sat 2026-04-04 09:00 +0200"


def test_times_that_do_not_exist_or_happen_twice() -> None:
    gap = parse("daily 02:30")  # 02:30 does not exist on 2026-03-29 in Madrid
    sat = at("2026-03-28 02:30")
    sun = gap.next_after(sat, sat, MADRID)
    assert local(sun) == "Sun 2026-03-29 03:30 +0200"  # rings one hour later that night
    assert local(gap.next_after(sun, sun, MADRID)) == "Mon 2026-03-30 02:30 +0200"
    fold = parse("daily 02:30")  # 02:30 happens twice on 2026-10-25
    oct_sat = at("2026-10-24 02:30")
    oct_sun = fold.next_after(oct_sat, oct_sat, MADRID)
    assert local(oct_sun) == "Sun 2026-10-25 02:30 +0200"  # the first one
    assert local(fold.next_after(oct_sun, oct_sun, MADRID)) == "Mon 2026-10-26 02:30 +0100"
