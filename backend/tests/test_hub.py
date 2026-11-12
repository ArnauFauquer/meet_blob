"""WebSocket protocol rules and input conditions, over a real (in-process) socket."""

import json
import threading
from collections.abc import Iterator
from contextlib import contextmanager
from pathlib import Path
from typing import Any

import numpy as np
import pytest
from fastapi.testclient import TestClient
from starlette.testclient import WebSocketTestSession
from starlette.websockets import WebSocketDisconnect

from blob import __version__
from blob.fakes import FakeStt, FakeTts
from tests.conftest import ALERT_TOKEN, TOKEN, wait_ready
from tests.fakes.fake_hermes import FakeHermes

SPEECH = (np.ones(16000, dtype="<i2") * 3000).tobytes()  # 1 s, loud enough for FakeStt
SILENCE = bytes(32000)


def hello(
    ws: WebSocketTestSession,
    token: str = TOKEN,
    version: str = __version__,
    device: str = "desktop",
) -> None:
    ws.send_json({"type": "hello", "version": version, "token": token, "device": device})


def recv(ws: WebSocketTestSession) -> Any:
    m = ws.receive()
    if m["type"] == "websocket.close":
        raise WebSocketDisconnect(m.get("code", 1000))
    return json.loads(m["text"]) if m.get("text") is not None else m["bytes"]


def until(ws: WebSocketTestSession, type_: str) -> list[Any]:
    """Messages up to and including the first of the given type."""
    seen = []
    while True:
        m = recv(ws)
        seen.append(m)
        if isinstance(m, dict) and m["type"] == type_:
            return seen


@contextmanager
def connect(client: TestClient, device: str = "desktop") -> Iterator[WebSocketTestSession]:
    with client.websocket_connect("/ws") as ws:
        hello(ws, device=device)
        assert recv(ws) == {"type": "hello_ok", "version": __version__, "ok": True}
        assert recv(ws) == {"type": "snapshot", "conv": "idle", "alerts": []}
        yield ws


def tap(ws: WebSocketTestSession, msg: dict[str, Any] | None = None) -> int:
    ws.send_json(msg or {"type": "tap"})
    state = until(ws, "state")[-1]
    while state["conv"] == "idle":  # the end of the previous turn
        state = until(ws, "state")[-1]
    assert state["conv"] == "listening"
    assert recv(ws)["type"] == "snapshot"
    return int(state["turn"])


def utterance(ws: WebSocketTestSession, turn_id: int, pcm: bytes, **over: Any) -> None:
    msg = {
        "type": "utterance",
        "turn": turn_id,
        "format": "pcm_s16le",
        "rate": 16000,
        "dur_ms": len(pcm) // 32,
        "tail_silence_ms": 300,
    }
    ws.send_json({**msg, **over})
    if msg["dur_ms"] and "dur_ms" not in over:
        ws.send_bytes(pcm)


def test_full_turn(client: TestClient, fake_hermes: FakeHermes) -> None:
    with connect(client) as ws:
        turn = tap(ws)
        utterance(ws, turn, SPEECH)
        msgs = until(ws, "turn_done")
        states = [m["conv"] for m in msgs if isinstance(m, dict) and m["type"] == "state"]
        assert states == ["thinking", "speaking"]
        i = next(i for i, m in enumerate(msgs) if isinstance(m, dict) and m["type"] == "tts")
        assert msgs[i] == {
            "type": "tts",
            "turn": turn,
            "alert": None,
            "seq": 0,
            "final": True,
            "followup": False,
        }
        assert (
            isinstance(msgs[i + 1], bytes) and msgs[i + 1][:4] == b"RIFF"
        )  # frame right after header
        assert msgs[-1]["reason"] == "ok" and msgs[-1]["timeout_kind"] is None
        assert set(msgs[-1]["timings"]) == {
            "stt_ms",
            "hermes_ms",
            "tts_ms",
            "first_audio_ms",
            "sc1_ms",
        }
        assert recv(ws) == {"type": "state", "conv": "idle", "turn": None}
        assert recv(ws) == {"type": "snapshot", "conv": "idle", "alerts": []}
        assert len(fake_hermes.requests) == 1


def test_mirror_gets_state_but_not_audio(client: TestClient) -> None:
    with connect(client) as a, connect(client) as b:
        turn = tap(a)
        assert recv(b) == {"type": "state", "conv": "listening", "turn": turn}
        assert recv(b)["type"] == "snapshot"
        utterance(a, turn, SPEECH)
        until(a, "turn_done")
        seen: list[Any] = []
        while not (seen and seen[-1] == {"type": "snapshot", "conv": "idle", "alerts": []}):
            seen.append(recv(b))
        assert all(isinstance(m, dict) and m["type"] in {"state", "snapshot"} for m in seen)


def test_silence_is_empty_without_hermes(client: TestClient, fake_hermes: FakeHermes) -> None:
    with connect(client) as ws:
        utterance(ws, tap(ws), SILENCE)
        assert until(ws, "turn_done")[-1]["reason"] == "empty"
        turn = tap(ws)
        utterance(ws, turn, b"", dur_ms=0)  # zero-length: no binary frame follows
        assert until(ws, "turn_done")[-1]["reason"] == "empty"
        assert fake_hermes.requests == []


def test_hermes_down_speaks_fallback(client: TestClient, fake_hermes: FakeHermes) -> None:
    fake_hermes.mode = "error"
    with connect(client) as ws:
        utterance(ws, tap(ws), SPEECH)
        msgs = until(ws, "turn_done")
        assert msgs[-1]["reason"] == "hermes_fail"
        assert any(isinstance(m, bytes) for m in msgs)


@pytest.mark.parametrize("first", [{"type": "tap"}, {"type": "ping"}, "not json", b"\x00\x01"])
def test_message_before_hello_closes_4400(client: TestClient, first: Any) -> None:
    with client.websocket_connect("/ws") as ws:
        if isinstance(first, bytes):
            ws.send_bytes(first)
        elif isinstance(first, str):
            ws.send_text(first)
        else:
            ws.send_json(first)
        with pytest.raises(WebSocketDisconnect) as e:
            recv(ws)
        assert e.value.code == 4400


def test_bad_token_closes_4401(client: TestClient) -> None:
    with client.websocket_connect("/ws") as ws:
        hello(ws, token="wrong")
        with pytest.raises(WebSocketDisconnect) as e:
            recv(ws)
        assert e.value.code == 4401


def test_version_mismatch(client: TestClient) -> None:
    with client.websocket_connect("/ws") as ws:
        hello(ws, version="0")
        assert recv(ws) == {"type": "hello_ok", "version": __version__, "ok": False}


def test_ping_and_bad_messages(client: TestClient, capsys: pytest.CaptureFixture[str]) -> None:
    with connect(client) as ws:
        ws.send_json({"type": "ping"})
        assert recv(ws) == {"type": "pong"}
        for bad in ["{oops", '{"no_type": 1}', '{"type": "launch"}', '{"type": "wake"}']:
            ws.send_text(bad)
            assert recv(ws) == {"type": "error", "code": "bad_message"}
        hello(ws)  # a second hello is not a valid message on an open session
        assert recv(ws) == {"type": "error", "code": "bad_message"}
        ws.send_json({"type": "client_event", "kind": "mic_denied", "detail": "x"})
        ws.send_json({"type": "ping"})
        assert recv(ws) == {"type": "pong"}
        events = [
            json.loads(x) for x in capsys.readouterr().out.splitlines() if "client_event" in x
        ]
        assert events[-1]["event"] == {"type": "client_event", "kind": "mic_denied", "detail": "x"}


def test_busy(client: TestClient) -> None:
    with connect(client) as a, connect(client) as b:
        tap(a)
        until(b, "snapshot")
        b.send_json({"type": "tap"})
        assert recv(b) == {"type": "error", "code": "busy"}
        a.send_json({"type": "tap"})  # a second tap from the owner is busy too
        assert recv(a) == {"type": "error", "code": "busy"}


def test_utterance_rules_leave_lock(client: TestClient) -> None:
    with connect(client) as ws:
        utterance(ws, 1, SPEECH)  # no open turn
        assert recv(ws) == {"type": "error", "code": "bad_message"}
        ws.send_json({"type": "ping"})  # the frame sent after it was dropped
        assert recv(ws) == {"type": "pong"}
        turn = tap(ws)
        for over in ({"turn": turn + 1}, {"format": "opus"}, {"rate": 48000}):
            utterance(ws, turn, SPEECH, **over)
            assert recv(ws) == {"type": "error", "code": "bad_message"}
        utterance(ws, turn, SPEECH)  # the turn is still open
        assert until(ws, "turn_done")[-1]["reason"] == "ok"


def test_header_without_frame(client: TestClient) -> None:
    with connect(client) as ws:
        turn = tap(ws)
        utterance(ws, turn, SPEECH, dur_ms=1000)  # header only
        ws.send_json({"type": "ping"})
        assert recv(ws) == {"type": "error", "code": "bad_message"}
        assert recv(ws) == {"type": "pong"}
        utterance(ws, turn, SPEECH)
        assert until(ws, "turn_done")[-1]["reason"] == "ok"


def test_frame_over_1mb_cancels(client: TestClient) -> None:
    with connect(client) as ws:
        turn = tap(ws)
        utterance(ws, turn, SPEECH, dur_ms=40000)
        ws.send_bytes(bytes((1 << 20) + 2))
        assert recv(ws) == {"type": "error", "code": "bad_message"}
        assert until(ws, "turn_done")[-1]["reason"] == "cancel"


def test_cancel(client: TestClient) -> None:
    with connect(client) as ws:
        turn = tap(ws)
        ws.send_json({"type": "cancel", "turn": turn})
        msgs = until(ws, "turn_done")
        assert msgs[-1]["reason"] == "cancel"
        ws.send_json({"type": "cancel", "turn": turn})  # late cancel: ignored
        ws.send_json({"type": "ping"})
        assert until(ws, "pong")[-1] == {"type": "pong"}


def test_close_releases_lock(client: TestClient) -> None:
    with connect(client) as a:
        tap(a)
    with connect(client) as b:
        assert tap(b) == 2


def test_listen_watchdog(app_factory: Any) -> None:
    with TestClient(app_factory(listen_watchdog_s=0.2)) as c:
        wait_ready(c)
        with connect(c) as ws:
            tap(ws)
            done = until(ws, "turn_done")
            assert (done[-1]["reason"], done[-1]["timeout_kind"]) == ("timeout", "listen")
            assert not any(isinstance(m, bytes) for m in done)


class BlockedStt(FakeStt):
    def __init__(self) -> None:
        super().__init__("hola", "es", 0.01)
        self.release = threading.Event()

    def load(self) -> None:
        self.release.wait(10)


def test_not_ready(app_factory: Any) -> None:
    stt = BlockedStt()
    with TestClient(app_factory(models=(stt, FakeTts()))) as c:
        try:
            with connect(c) as ws:
                ws.send_json({"type": "tap"})
                assert recv(ws) == {"type": "error", "code": "not_ready"}
                assert c.get("/readyz").status_code == 503
        finally:
            stt.release.set()
        wait_ready(c)
        with connect(c) as ws:
            assert tap(ws) == 1


# S3: wake


@pytest.fixture
def wake_client(app_factory: Any, tmp_path: Path) -> Iterator[TestClient]:
    (tmp_path / "devices.json").write_text(
        json.dumps({"tablet": {"sound": True, "wake": True}, "desktop": {"wake": False}})
    )
    with TestClient(app_factory()) as c:
        wait_ready(c)
        yield c


@pytest.mark.parametrize("device", ["desktop", "unknown"])
def test_wake_refused_without_wake_flag(wake_client: TestClient, device: str) -> None:
    with connect(wake_client, device) as ws:
        for msg in ({"type": "wake"}, {"type": "wake", "followup": True}):
            ws.send_json(msg)
            assert recv(ws) == {"type": "error", "code": "bad_message"}
        assert tap(ws) == 1  # tap still works


def test_wake_starts_a_turn_like_tap(wake_client: TestClient, fake_hermes: FakeHermes) -> None:
    with connect(wake_client, "tablet") as ws, connect(wake_client) as desk:
        turn = tap(ws, {"type": "wake"})
        until(desk, "snapshot")
        desk.send_json({"type": "tap"})
        assert recv(desk) == {"type": "error", "code": "busy"}
        utterance(ws, turn, SPEECH)
        assert until(ws, "turn_done")[-1]["reason"] == "ok"
        followup = tap(ws, {"type": "wake", "followup": True})
        assert followup == turn + 1
        utterance(ws, followup, b"", dur_ms=0)  # page: no speech in the 6 s window
        assert until(ws, "turn_done")[-1]["reason"] == "empty"
        assert len(fake_hermes.requests) == 1


def test_wake_busy(wake_client: TestClient) -> None:
    with connect(wake_client, "tablet") as a, connect(wake_client, "tablet") as b:
        tap(a)
        until(b, "snapshot")
        b.send_json({"type": "wake"})
        assert recv(b) == {"type": "error", "code": "busy"}


def test_followup_flag_over_the_socket(client: TestClient, fake_hermes: FakeHermes) -> None:
    fake_hermes.mode = "question"
    with connect(client) as ws:
        utterance(ws, tap(ws), SPEECH)
        tts = next(m for m in until(ws, "turn_done") if isinstance(m, dict) and m["type"] == "tts")
        assert tts["followup"] is True


# S4: alerts in the snapshot, alert_read, alert_ack


def post_alert(c: TestClient, **body: Any) -> Any:
    r = c.post("/alerts", json=body, headers={"Authorization": f"Bearer {ALERT_TOKEN}"})
    assert r.status_code in (200, 201), r.text
    return r.json()


def test_alert_broadcast_to_every_client(client: TestClient) -> None:
    with connect(client) as a, connect(client, "tablet") as b:
        post_alert(client, key="door", source="homeassistant", text="Puerta", urgency="urgent")
        for ws in (a, b):
            snap = recv(ws)  # only a snapshot: state is for turn transitions
            assert snap["type"] == "snapshot" and snap["conv"] == "idle"
            [item] = snap["alerts"]
            assert set(item) == {"key", "source", "urgency", "text", "lang", "late", "activated_at"}
            assert (item["key"], item["source"], item["urgency"], item["late"]) == (
                "door",
                "homeassistant",
                "urgent",
                False,
            )
        client.delete("/alerts/door", headers={"Authorization": f"Bearer {ALERT_TOKEN}"})
        assert recv(a) == {"type": "snapshot", "conv": "idle", "alerts": []}


def test_snapshot_on_connect_lists_active_only(client: TestClient) -> None:
    post_alert(client, key="on", source="s", text="t")
    post_alert(client, key="later", source="timer", text="t", in_s=3600)
    with client.websocket_connect("/ws") as ws:
        hello(ws)
        recv(ws)
        assert [a["key"] for a in recv(ws)["alerts"]] == ["on"]


def test_alert_read_then_ack(client: TestClient) -> None:
    post_alert(client, key="wash", source="homeassistant", text="Lavadora lista", lang="es")
    with connect_with_alerts(client) as ws, connect_with_alerts(client) as other:
        ws.send_json({"type": "alert_read", "key": "wash"})
        assert recv(ws) == {
            "type": "tts",
            "turn": None,
            "alert": "wash",
            "seq": 0,
            "final": True,
            "followup": False,
        }
        audio = recv(ws)
        assert isinstance(audio, bytes) and audio[:4] == b"RIFF"
        ws.send_json({"type": "alert_ack", "key": "wash"})
        assert recv(ws) == {"type": "snapshot", "conv": "idle", "alerts": []}
        assert recv(other) == {"type": "snapshot", "conv": "idle", "alerts": []}
        ws.send_json({"type": "alert_read", "key": "wash"})  # acked: no longer readable
        assert recv(ws) == {"type": "error", "code": "bad_message"}
        ws.send_json({"type": "alert_ack", "key": "wash"})  # a second ack is ignored
        ws.send_json({"type": "ping"})
        assert recv(ws) == {"type": "pong"}
    rows = client.get("/alerts", headers={"Authorization": f"Bearer {ALERT_TOKEN}"}).json()
    assert rows == [{"key": "wash", "state": "acked", "fire_at": None}]


def test_alert_read_uses_voice_for_lang(app_factory: Any) -> None:
    class RecordingTts(FakeTts):
        def __init__(self) -> None:
            self.calls: list[tuple[str, str | None]] = []

        def __call__(self, text: str, lang: str | None) -> bytes:
            self.calls.append((text, lang))
            return super().__call__(text, lang)

    tts = RecordingTts()
    with TestClient(app_factory(models=(FakeStt("x", "es", 0.01), tts))) as c:
        wait_ready(c)
        post_alert(c, key="k", source="s", text="Washing done", lang="en")
        with connect_with_alerts(c) as ws:
            ws.send_json({"type": "alert_read", "key": "k"})
            until(ws, "tts")
        assert tts.calls == [("Washing done", "en")]


@contextmanager
def connect_with_alerts(client: TestClient) -> Iterator[WebSocketTestSession]:
    with client.websocket_connect("/ws") as ws:
        hello(ws)
        assert recv(ws)["type"] == "hello_ok"
        assert recv(ws)["type"] == "snapshot"
        yield ws


def test_alert_read_bad_cases(client: TestClient) -> None:
    post_alert(client, key="on", source="s", text="t")
    post_alert(client, key="later", source="timer", text="t", in_s=3600)
    with connect_with_alerts(client) as ws:
        for key in ("missing", "later"):
            ws.send_json({"type": "alert_read", "key": key})
            assert recv(ws) == {"type": "error", "code": "bad_message"}
        ws.send_json({"type": "tap"})
        until(ws, "snapshot")
        ws.send_json({"type": "alert_read", "key": "on"})  # during a turn
        assert recv(ws) == {"type": "error", "code": "bad_message"}


def test_alert_read_synthesis_failure(app_factory: Any) -> None:
    class BrokenTts(FakeTts):
        def __call__(self, text: str, lang: str | None) -> bytes:
            raise RuntimeError("onnx")

    with TestClient(app_factory(models=(FakeStt("x", "es", 0.01), BrokenTts()))) as c:
        wait_ready(c)
        post_alert(c, key="k", source="s", text="t")
        with connect_with_alerts(c) as ws:
            ws.send_json({"type": "alert_read", "key": "k"})
            assert recv(ws) == {"type": "error", "code": "bad_message"}
            ws.send_json({"type": "alert_ack", "key": "k"})  # the page keeps it: no ack sent


def test_alert_read_not_ready(app_factory: Any) -> None:
    stt = BlockedStt()
    with TestClient(app_factory(models=(stt, FakeTts()))) as c:
        try:
            post_alert(c, key="k", source="s", text="t")
            with connect_with_alerts(c) as ws:
                ws.send_json({"type": "alert_read", "key": "k"})
                assert recv(ws) == {"type": "error", "code": "not_ready"}
        finally:
            stt.release.set()


def test_timer_fires_and_snapshot_changes(app_factory: Any) -> None:
    with TestClient(app_factory()) as c:
        wait_ready(c)
        with connect(c) as ws:
            assert post_alert(c, key="t", source="timer", text="Fin", in_s=1)["state"] == "pending"
            assert recv(ws) == {"type": "snapshot", "conv": "idle", "alerts": []}
            snap = recv(ws)  # within about 1 s plus the 250 ms scheduler cap
            assert [(a["key"], a["urgency"], a["late"]) for a in snap["alerts"]] == [
                ("t", "urgent", False)
            ]


def test_voice_timer_through_the_rule(app_factory: Any, fake_hermes: FakeHermes) -> None:
    with TestClient(app_factory(blob_fake_transcript="pon un temporizador de 1 minuto")) as c:
        wait_ready(c)
        with connect(c) as ws:
            utterance(ws, tap(ws), SPEECH)
            msgs = until(ws, "turn_done")
            assert msgs[-1]["reason"] == "ok" and msgs[-1]["timings"]["hermes_ms"] is None
            assert any(isinstance(m, bytes) for m in msgs)
        rows = c.get("/alerts", headers={"Authorization": f"Bearer {ALERT_TOKEN}"}).json()
        [row] = rows
        assert row["key"].startswith("timer-") and row["state"] == "pending"
        assert fake_hermes.requests == []


def test_timer_rule_off(app_factory: Any, fake_hermes: FakeHermes) -> None:
    app = app_factory(blob_fake_transcript="pon un temporizador de 1 minuto", timer_rule=False)
    with TestClient(app) as c:
        wait_ready(c)
        with connect(c) as ws:
            utterance(ws, tap(ws), SPEECH)
            assert until(ws, "turn_done")[-1]["reason"] == "ok"
        assert c.get("/alerts", headers={"Authorization": f"Bearer {ALERT_TOKEN}"}).json() == []
        assert len(fake_hermes.requests) == 1
