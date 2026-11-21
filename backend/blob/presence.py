"""Presence: a motion or occupancy sensor tells Blob whether someone is in the room.

Home Assistant (or any source with ALERT_TOKEN) calls POST /presence; Blob never asks it
(design NG1, NG8). The backend only keeps the last report in memory and forwards it to every
screen as a `presence` message. The page decides what to draw (web/src/presence.ts). With no
report since startup the state is unknown and the page behaves as if there were no sensor.
"""

import logging
import time
from collections.abc import Awaitable, Callable

from fastapi import APIRouter, Depends, Request, Response

from .auth import require_alert_token
from .schemas import PresenceIn, PresenceMsg, PresenceOut

log = logging.getLogger(__name__)


class Presence:
    def __init__(
        self,
        on_change: Callable[[PresenceMsg], Awaitable[None]],
        wall: Callable[[], float] = time.time,
    ) -> None:
        self._on_change, self._wall = on_change, wall
        self.present: bool | None = None  # None: no sensor has reported (or it was cleared)
        self.at: float | None = None  # when the current value started (see report)

    def message(self) -> PresenceMsg:
        since = None if self.at is None else round(max(0.0, self._wall() - self.at), 1)
        return PresenceMsg(present=self.present, since_s=since)

    def out(self) -> PresenceOut:
        m = self.message()
        return PresenceOut(present=m.present, since_s=m.since_s)

    async def report(self, present: bool | None) -> None:
        """A report always reaches the screens.

        `at` moves only when the value changes: a repeated report (a motion sensor firing again, a
        periodic resync) keeps the time the room filled or emptied. The page decides what a report
        wakes (web/src/presence.ts).
        """
        if present is None:
            self.at = None
        elif present != self.present:
            self.at = self._wall()
        if present != self.present:
            log.info("presence: %s", {True: "someone", False: "nobody", None: "unknown"}[present])
        self.present = present
        await self._on_change(self.message())


router = APIRouter(prefix="/presence", dependencies=[Depends(require_alert_token)])


def _presence(request: Request) -> Presence:
    p: Presence = request.app.state.presence
    return p


@router.post("", response_model=PresenceOut)
async def post_presence(body: PresenceIn, request: Request) -> PresenceOut:
    p = _presence(request)
    await p.report(body.present)
    return p.out()


@router.get("", response_model=PresenceOut)
async def get_presence(request: Request) -> PresenceOut:
    return _presence(request).out()


@router.delete("", status_code=204)
async def delete_presence(request: Request) -> Response:
    """Back to unknown: the page behaves as with no sensor (for example after removing it)."""
    await _presence(request).report(None)
    return Response(status_code=204)
