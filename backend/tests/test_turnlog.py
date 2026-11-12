import json

import pytest

from blob import turnlog
from blob.db import Db
from blob.schemas import Reason, TimeoutKind, Timings


async def test_timing_line_has_no_text(capsys: pytest.CaptureFixture[str]) -> None:
    db = Db(":memory:")
    await turnlog.record_turn(
        db,
        turn=7,
        ts=1,
        lang="ca",
        user_text="secret question",
        reply_text="secret answer",
        reason=Reason.TIMEOUT,
        timeout_kind=TimeoutKind.HERMES,
        timings=Timings(stt_ms=10, hermes_ms=75000),
    )
    out = capsys.readouterr().out
    assert "secret" not in out
    line = json.loads(out)
    assert line == {
        "kind": "turn",
        "turn": 7,
        "reason": "timeout",
        "timeout_kind": "hermes",
        "lang": "ca",
        "stt_ms": 10,
        "hermes_ms": 75000,
        "tts_ms": None,
        "first_audio_ms": None,
        "sc1_ms": None,
    }
    [row] = db.turns()
    assert row["user_text"] == "secret question" and row["timeout_kind"] == "hermes"


async def test_db_failure_is_logged_not_raised(capsys: pytest.CaptureFixture[str]) -> None:
    db = Db(":memory:")
    db.close()
    await turnlog.record_turn(
        db,
        turn=1,
        ts=1,
        lang=None,
        user_text="",
        reply_text="",
        reason=Reason.OK,
        timeout_kind=None,
        timings=Timings(),
    )
    assert json.loads(capsys.readouterr().out)["kind"] == "turn"


def test_client_event_printed(capsys: pytest.CaptureFixture[str]) -> None:
    turnlog.client_event("tablet", {"type": "client_event", "kind": "mic_denied"})
    assert json.loads(capsys.readouterr().out) == {
        "kind": "client_event",
        "device": "tablet",
        "event": {"type": "client_event", "kind": "mic_denied"},
    }
