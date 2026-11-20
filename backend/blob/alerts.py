"""Alerts and timers (S4): the store, the POST/DELETE/GET /alerts router and the scheduler.

The rows live in SQLite and in a dict mirror, so a snapshot is built without a database call.
Every mutation takes one asyncio lock, writes to SQLite before it changes the mirror (so a failed
write leaves both as they were), then broadcasts a snapshot.

A recurring alert (`repeat`) uses the same three states. It waits `pending`, rings `active`, and
where a one-off alert would end (acked, or its ttl_s ran out) it goes back to `pending` at its next
occurrence instead. Only DELETE removes it. Missed occurrences while it rings are not stacked.
"""

import asyncio
import logging
import time
from collections.abc import Awaitable, Callable
from dataclasses import asdict, dataclass, replace
from datetime import tzinfo
from zoneinfo import ZoneInfo

from fastapi import APIRouter, Depends, HTTPException, Request, Response

from .auth import require_alert_token
from .db import Db
from .repeat import Repeat
from .repeat import parse as parse_repeat
from .schemas import AlertIn, AlertItem, AlertOut, AlertState, TimerItem, Urgency
from .timer_rule import TimerRequest

log = logging.getLogger(__name__)

MAX_ACTIVE = 20
SLEEP_CAP_S = 0.25  # a timer added while the scheduler sleeps is seen this fast
ACKED_KEEP_S = 24 * 3600


class TooManyAlerts(Exception):
    pass


@dataclass
class Alert:
    key: str
    source: str
    urgency: Urgency
    text: str
    lang: str
    state: AlertState
    fire_at: int | None
    ttl_s: int | None
    late: bool
    created_at: int
    activated_at: int | None = None
    acked_at: int | None = None
    repeat: str | None = None  # canonical rule (blob/repeat.py); fire_at is the current occurrence

    def out(self) -> AlertOut:
        return AlertOut(key=self.key, state=self.state, fire_at=self.fire_at, repeat=self.repeat)

    def rule(self) -> Repeat | None:
        return parse_repeat(self.repeat) if self.repeat else None

    def item(self) -> AlertItem:
        return AlertItem(
            key=self.key,
            source=self.source,
            urgency=self.urgency,
            text=self.text,
            lang=self.lang,
            late=self.late,
            activated_at=self.activated_at or 0,
        )


class Alerts:
    def __init__(
        self,
        db: Db,
        on_change: Callable[[], Awaitable[None]],
        wall: Callable[[], float] = time.time,
        tz: tzinfo | None = None,
    ) -> None:
        self._db, self._on_change, self._wall = db, on_change, wall
        self._tz = tz or ZoneInfo("Europe/Madrid")  # repeat times are wall-clock times here
        self._lock = asyncio.Lock()
        self.rows: dict[str, Alert] = {}

    # Reads (no lock: one event loop, the dict is only changed under the lock)

    def items(self) -> list[AlertItem]:
        """Active alerts for snapshot.alerts[], oldest first."""
        active = [a for a in self.rows.values() if a.state == "active"]
        return [a.item() for a in sorted(active, key=lambda a: (a.activated_at or 0, a.key))]

    def timers(self) -> list[TimerItem]:
        """Pending timers for snapshot.timers[], soonest first."""
        now = self._wall()
        due = [
            a
            for a in self.rows.values()
            # A recurring "timer" would count down for a day: it has no countdown.
            if a.state == "pending" and a.source == "timer" and a.fire_at and not a.repeat
        ]
        return [
            TimerItem(key=a.key, left_s=max(0.0, (a.fire_at or 0) - now))
            for a in sorted(due, key=lambda a: (a.fire_at or 0, a.key))
        ]

    def active(self, key: str) -> Alert | None:
        a = self.rows.get(key)
        return a if a is not None and a.state == "active" else None

    def _active_count(self) -> int:
        return sum(a.state == "active" for a in self.rows.values())

    # Mutations

    async def load(self) -> None:
        """Startup: read the rows, then fire overdue timers once, marked late."""
        rows = await asyncio.to_thread(self._db.load_alerts)
        async with self._lock:
            self.rows = {str(r["key"]): _row(r) for r in rows}
            now = self._wall()
            save, delete = [], []
            for a in self.rows.values():
                if a.state != "pending" or a.fire_at is None or a.fire_at > now:
                    continue
                rule = a.rule()
                if rule is not None:
                    # Several occurrences may have passed: the last one fires, once.
                    a.fire_at = rule.latest_at_or_before(a.fire_at, now, self._tz)
                if a.ttl_s is not None and a.fire_at + a.ttl_s <= now:
                    if rule is not None:  # its ttl ran out during the downtime: wait for the next
                        a.fire_at = rule.next_after(a.fire_at, now, self._tz)
                        save.append(a)
                    else:
                        delete.append(a.key)
                else:
                    # activated_at is the time it was due, so ttl_s still counts from then.
                    a.state, a.late, a.activated_at = "active", True, a.fire_at
                    save.append(a)
            for key in delete:
                del self.rows[key]
            await self._write(save, delete)

    async def upsert(self, body: AlertIn) -> tuple[Alert, bool]:
        """Apply the POST /alerts rules. Returns the row and whether the key is new."""
        async with self._lock:
            now = self._wall()
            urgency = body.urgency or ("urgent" if body.source == "timer" else "info")
            old = self.rows.get(body.key)
            if body.repeat is not None:
                a = self._recurring(body, urgency, old, now)
            else:
                a = self._one_off(body, urgency, old, now)
            if a is old:
                return old, False
            await self._write([a], [])
            self.rows[a.key] = a
        await self._on_change()
        return a, old is None

    def _recurring(self, body: AlertIn, urgency: Urgency, old: Alert | None, now: float) -> Alert:
        """A recurring POST: always pending at its next occurrence, or `old` if nothing changed."""
        assert body.repeat is not None
        rule = parse_repeat(body.repeat)
        start = _fire_at(body, now)
        first = rule.first_at_or_after(now if start is None else start, self._tz)
        if first <= now:  # a start in the past: keep its series, from the next occurrence
            first = rule.next_after(first, now, self._tz)
        if old is not None and old.repeat == body.repeat and old.fire_at is not None:
            # A ringing row is on the same series when its next occurrence is the new first one.
            old_next = (
                old.fire_at
                if old.state == "pending"
                else rule.next_after(old.fire_at, now, self._tz)
            )
            if (old.text, old.urgency, old_next) == (body.text, urgency, first):
                return old  # the same rule re-sent: ignored, and a ringing alert keeps ringing
        return Alert(
            key=body.key,
            source=body.source,
            urgency=urgency,
            text=body.text,
            lang=body.lang,
            state="pending",
            fire_at=first,
            ttl_s=body.ttl_s,
            late=False,
            created_at=old.created_at if old else int(now),
            repeat=body.repeat,
        )

    def _one_off(self, body: AlertIn, urgency: Urgency, old: Alert | None, now: float) -> Alert:
        """The one-off POST rules: the new row, or `old` if the POST is ignored."""
        fire_at = _fire_at(body, now)
        due = fire_at is None or fire_at <= now
        if (
            old is not None
            and old.state == "acked"
            and body.in_s is None
            and (old.text, old.urgency, old.fire_at) == (body.text, urgency, fire_at)
        ):
            return old  # a repeated report of an acked alert is ignored
        becomes_active = due and (old is None or old.state != "active")
        if becomes_active and self._active_count() >= MAX_ACTIVE:
            raise TooManyAlerts
        activated_at = None
        if becomes_active:
            activated_at = int(now)
        elif due and old is not None:
            activated_at = old.activated_at  # stays active: same activation, no new chime
        return Alert(
            key=body.key,
            source=body.source,
            urgency=urgency,
            text=body.text,
            lang=body.lang,
            state="active" if due else "pending",
            fire_at=fire_at,
            ttl_s=body.ttl_s,
            late=False,
            created_at=old.created_at if old else int(now),
            activated_at=activated_at,
        )

    async def delete(self, key: str) -> None:
        async with self._lock:
            if key not in self.rows:
                return
            await self._write([], [key])
            del self.rows[key]
        await self._on_change()

    async def ack(self, key: str) -> None:
        """alert_ack: an active alert becomes acked (a recurring one waits for its next occurrence).
        Anything else is ignored (a normal race)."""
        async with self._lock:
            a = self.active(key)
            if a is None:
                return
            now = self._wall()
            rule = a.rule()
            acked = (
                replace(a, state="acked", acked_at=int(now))
                if rule is None
                else self._rearm(a, rule, now)
            )
            await self._write([acked], [])
            self.rows[key] = acked
        await self._on_change()

    async def create_timer(self, req: TimerRequest) -> None:
        """The voice timer rule's way in: the same path as POST /alerts."""
        await self.upsert(
            AlertIn(key=req.key, source="timer", text=req.text, lang=req.lang, in_s=req.in_s)
        )

    async def tick(self) -> float:
        """Activate due timers and drop expired rows. Returns how long to sleep."""
        changed = False
        async with self._lock:
            now = self._wall()
            save, delete = [], []
            for a in self.rows.values():
                if a.state == "pending" and a.fire_at is not None and a.fire_at <= now:
                    save.append(replace(a, state="active", activated_at=int(now)))
                elif (
                    a.state == "active"
                    and a.ttl_s is not None
                    and (a.activated_at or 0) + a.ttl_s <= now
                ) or (a.state == "acked" and (a.acked_at or 0) + ACKED_KEEP_S <= now):
                    rule = a.rule()
                    if rule is not None and a.state == "active":
                        save.append(self._rearm(a, rule, now))
                    else:
                        delete.append(a.key)
            if save or delete:
                await self._write(save, delete)  # first, so a failed write is retried next tick
                self.rows.update((a.key, a) for a in save)
                for key in delete:
                    del self.rows[key]
                changed = True
            pending = [a.fire_at for a in self.rows.values() if a.state == "pending" and a.fire_at]
        if changed:
            await self._on_change()
        return min(SLEEP_CAP_S, max(0.0, min(pending) - now)) if pending else SLEEP_CAP_S

    def _rearm(self, a: Alert, rule: Repeat, now: float) -> Alert:
        """A recurring alert that was heard (or timed out) waits for its next occurrence."""
        assert a.fire_at is not None
        return replace(
            a,
            state="pending",
            fire_at=rule.next_after(a.fire_at, now, self._tz),
            late=False,
            activated_at=None,
            acked_at=None,
        )

    async def _write(self, save: list[Alert], delete: list[str]) -> None:
        if save or delete:
            await self._db.write_alerts([asdict(a) for a in save], delete)


def _row(r: dict[str, object]) -> Alert:
    return Alert(**{**r, "late": bool(r["late"])})  # type: ignore[arg-type]


def _fire_at(body: AlertIn, now: float) -> int | None:
    if body.in_s is not None:
        return round(now + body.in_s)
    if body.fire_at is None:
        return None
    assert not isinstance(body.fire_at, str)  # the validator turned RFC3339 into epoch seconds
    return round(body.fire_at)


async def run_scheduler(
    alerts: Alerts, sleep: Callable[[float], Awaitable[None]] = asyncio.sleep
) -> None:
    while True:
        try:
            delay = await alerts.tick()
        except Exception:
            log.exception("alert scheduler tick failed")
            delay = SLEEP_CAP_S
        await sleep(delay)


router = APIRouter(prefix="/alerts", dependencies=[Depends(require_alert_token)])


def _alerts(request: Request) -> Alerts:
    alerts: Alerts = request.app.state.alerts
    return alerts


@router.post("", response_model=AlertOut)
async def post_alert(body: AlertIn, request: Request, response: Response) -> AlertOut:
    try:
        a, new = await _alerts(request).upsert(body)
    except TooManyAlerts:
        raise HTTPException(429, f"more than {MAX_ACTIVE} active alerts") from None
    response.status_code = 201 if new else 200
    return a.out()


@router.get("", response_model=list[AlertOut])
async def list_alerts(request: Request) -> list[AlertOut]:
    return [a.out() for a in _alerts(request).rows.values()]


@router.delete("/{key}", status_code=204)
async def delete_alert(key: str, request: Request) -> Response:
    await _alerts(request).delete(key)
    return Response(status_code=204)
