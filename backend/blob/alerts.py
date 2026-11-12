"""Alerts and timers (S4): the store, the POST/DELETE/GET /alerts router and the scheduler.

The rows live in SQLite and in a dict mirror, so a snapshot is built without a database call.
Every mutation takes one asyncio lock, writes through to SQLite, then broadcasts a snapshot.
"""

import asyncio
import logging
import time
from collections.abc import Awaitable, Callable
from dataclasses import asdict, dataclass
from typing import Literal

from fastapi import APIRouter, Depends, HTTPException, Request, Response

from .auth import require_alert_token
from .db import Db
from .schemas import AlertIn, AlertItem, AlertOut
from .timer_rule import TimerRequest

log = logging.getLogger(__name__)

MAX_ACTIVE = 20
SLEEP_CAP_S = 0.25  # a timer added while the scheduler sleeps is seen this fast
ACKED_KEEP_S = 24 * 3600

State = Literal["pending", "active", "acked"]


class TooManyAlerts(Exception):
    pass


@dataclass
class Alert:
    key: str
    source: str
    urgency: Literal["info", "urgent"]
    text: str
    lang: str
    state: State
    fire_at: int | None
    ttl_s: int | None
    late: bool
    created_at: int
    activated_at: int | None = None
    acked_at: int | None = None

    def out(self) -> AlertOut:
        return AlertOut(key=self.key, state=self.state, fire_at=self.fire_at)

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
    ) -> None:
        self._db, self._on_change, self._wall = db, on_change, wall
        self._lock = asyncio.Lock()
        self.rows: dict[str, Alert] = {}

    # Reads (no lock: one event loop, the dict is only changed under the lock)

    def items(self) -> list[AlertItem]:
        """Active alerts for snapshot.alerts[], oldest first."""
        active = [a for a in self.rows.values() if a.state == "active"]
        return [a.item() for a in sorted(active, key=lambda a: (a.activated_at or 0, a.key))]

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
                if a.ttl_s is not None and a.fire_at + a.ttl_s <= now:
                    delete.append(a.key)  # its ttl ran out during the downtime
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
            fire_at = _fire_at(body, now)
            urgency = body.urgency or ("urgent" if body.source == "timer" else "info")
            due = fire_at is None or fire_at <= now
            old = self.rows.get(body.key)
            if (
                old is not None
                and old.state == "acked"
                and body.in_s is None
                and (old.text, old.urgency, old.fire_at) == (body.text, urgency, fire_at)
            ):
                return old, False  # a repeated report of an acked alert is ignored
            becomes_active = due and (old is None or old.state != "active")
            if becomes_active and self._active_count() >= MAX_ACTIVE:
                raise TooManyAlerts
            activated_at = None
            if becomes_active:
                activated_at = int(now)
            elif due and old is not None:
                activated_at = old.activated_at  # stays active: same activation, no new chime
            a = Alert(
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
            await self._write([a], [])  # first, so a failed write leaves the mirror unchanged
            self.rows[a.key] = a
        await self._on_change()
        return a, old is None

    async def delete(self, key: str) -> None:
        async with self._lock:
            if self.rows.pop(key, None) is None:
                return
            await self._write([], [key])
        await self._on_change()

    async def ack(self, key: str) -> None:
        """alert_ack: an active alert becomes acked. Anything else is ignored (a normal race)."""
        async with self._lock:
            a = self.active(key)
            if a is None:
                return
            a.state, a.acked_at = "acked", int(self._wall())
            await self._write([a], [])
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
                    a.state, a.activated_at = "active", int(now)
                    save.append(a)
                elif (
                    a.state == "active"
                    and a.ttl_s is not None
                    and (a.activated_at or 0) + a.ttl_s <= now
                ) or (a.state == "acked" and (a.acked_at or 0) + ACKED_KEEP_S <= now):
                    delete.append(a.key)
            for key in delete:
                del self.rows[key]
            if save or delete:
                await self._write(save, delete)
                changed = True
            pending = [a.fire_at for a in self.rows.values() if a.state == "pending" and a.fire_at]
        if changed:
            await self._on_change()
        return min(SLEEP_CAP_S, max(0.0, min(pending) - now)) if pending else SLEEP_CAP_S

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
