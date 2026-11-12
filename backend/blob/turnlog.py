"""Per-turn logging: the timing line on standard output (no text), the full row in SQLite."""

import json
import logging
import sys
from typing import Any

from .db import Db
from .schemas import Reason, TimeoutKind, Timings

log = logging.getLogger(__name__)


def emit(line: dict[str, Any]) -> None:
    sys.stdout.write(json.dumps(line, ensure_ascii=False) + "\n")
    sys.stdout.flush()


async def record_turn(
    db: Db,
    *,
    turn: int,
    ts: int,
    lang: str | None,
    user_text: str,
    reply_text: str,
    reason: Reason,
    timeout_kind: TimeoutKind | None,
    timings: Timings,
) -> None:
    emit(
        {
            "kind": "turn",
            "turn": turn,
            "reason": reason.value,
            "timeout_kind": timeout_kind.value if timeout_kind else None,
            "lang": lang,
            **timings.model_dump(),
        }
    )
    try:
        await db.insert_turn(
            ts,
            lang,
            user_text,
            reply_text,
            reason.value,
            timeout_kind.value if timeout_kind else None,
            timings,
        )
    except Exception:
        log.exception("could not store turn %s", turn)


def client_event(device: str, fields: dict[str, Any]) -> None:
    """Printed, never stored."""
    emit({"kind": "client_event", "device": device, "event": fields})
