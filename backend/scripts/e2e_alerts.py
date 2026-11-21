"""Scripted page and alert source: the S3/S4 backend flows against a running `uv run blob`.

    uv run python scripts/e2e_alerts.py --session "$BLOB_SESSION" --wake-session "$TABLET_SESSION" \
        --alert-token "$ALERT_TOKEN" --hermes http://127.0.0.1:18642 [--timer-wav ...]

The sessions are blob_session cookies of signed-in browsers: --session's user is in no group,
--wake-session's user is in the wake group (OIDC_WAKE_GROUP).

Checks, in order (each prints PASS or FAIL):
 1. POST /alerts creates an alert; every connected page gets a snapshot with it (time printed).
 2. alert_read gets a tts header with alert=key followed by one WAV frame.
 3. alert_ack removes it from the snapshot; GET /alerts shows it acked.
 4. alert_read of an unknown key gets error bad_message.
 5. A timer with in_s=2 is pending, then fires: the snapshot changes (delay printed).
 6. A spoken timer request goes through the timer rule: turn_done ok with audio, a new pending
    timer-<unix time> about 60 s ahead, and the fake Hermes counted no request.
 7. wake from a user outside the wake group gets bad_message; from one inside it opens a turn.
 8. A recurring alert ("daily HH:MM", local time in --tz): POST is pending at the next local
    HH:MM, a repeat POST is ignored (200, same fire_at), a bad rule and repeat with in_s get 422,
    GET shows the rule, DELETE removes it. With --repeat-wait it also waits for it to ring
    (60 to 120 s), acks it and checks that it is pending again one day later.
With BLOB_FAKE_MODELS=1 run the server with BLOB_FAKE_TRANSCRIPT="pon un temporizador de 1
minuto" and omit --timer-wav (a loud tone is sent). Exit status 0 when every check passes.
"""

import argparse
import json
import sys
import time
from collections.abc import Callable
from contextlib import ExitStack
from datetime import datetime, timedelta
from typing import Any
from zoneinfo import ZoneInfo

import httpx
import numpy as np
from e2e_turn import open_session, wav_info
from websockets.sync.client import ClientConnection

from blob.audio import PCM_RATE, read_wav, to_pcm16k

results: list[tuple[str, bool, str]] = []


def check(name: str, ok: bool, detail: str = "") -> bool:
    results.append((name, ok, detail))
    print(f"CHECK {name}: {'PASS' if ok else 'FAIL'} {detail}")
    return ok


def wait_for(ws: ClientConnection, pred: Callable[[Any], bool], timeout: float) -> Any:
    """Read messages until one matches; None on timeout. Binary frames are returned as bytes."""
    end = time.monotonic() + timeout
    while (left := end - time.monotonic()) > 0:
        try:
            raw = ws.recv(timeout=left)
        except TimeoutError:
            return None
        msg = raw if isinstance(raw, bytes) else json.loads(raw)
        print(f"  <- <binary {len(raw)} bytes>" if isinstance(raw, bytes) else f"  <- {raw}")
        if pred(msg):
            return msg
    return None


def snapshot_where(cond: Callable[[dict[str, Any]], bool]) -> Callable[[Any], bool]:
    return lambda m: isinstance(m, dict) and m["type"] == "snapshot" and cond(m)


def keys(snap: dict[str, Any]) -> set[str]:
    return {a["key"] for a in snap["alerts"]}


def alert_in(snap: dict[str, Any] | None, key: str) -> dict[str, Any]:
    """The snapshot's alert with this key, or {} (no snapshot, or not in it)."""
    found: dict[str, Any] = next((a for a in snap["alerts"] if a["key"] == key), {}) if snap else {}
    return found


def main() -> int:
    p = argparse.ArgumentParser()
    p.add_argument("--url", default="ws://127.0.0.1:8000/ws")
    p.add_argument("--http", help="HTTP base URL (default: derived from --url)")
    p.add_argument("--session", required=True, help="blob_session of a user in no group")
    p.add_argument("--wake-session", required=True, help="blob_session of a wake group user")
    p.add_argument("--alert-token", required=True, help="ALERT_TOKEN")
    p.add_argument("--hermes", required=True, help="fake Hermes base URL (for /requests)")
    p.add_argument("--timer-wav", help="spoken timer request; default: a loud tone (fake models)")
    p.add_argument("--tz", default="Europe/Madrid", help="the server's TZ (recurring alerts)")
    p.add_argument(
        "--repeat-wait", action="store_true", help="wait up to 2 min for a recurring alert to ring"
    )
    a = p.parse_args()
    http = a.http or a.url.replace("ws://", "http://").replace("wss://", "https://")[: -len("/ws")]
    api = httpx.Client(base_url=http, headers={"Authorization": f"Bearer {a.alert_token}"})
    t0 = time.monotonic()
    with ExitStack() as stack:
        page = open_session(stack, a.url, a.session, t0)
        mirror = open_session(stack, a.url, a.session, t0)
        alerts_flow(api, page, mirror)
        timer_flow(api, page)
        voice_timer_flow(api, page, a)
        wake_flow(stack, a, t0)
        recurring_flow(api, page, ZoneInfo(a.tz), a.repeat_wait)
    failed = [n for n, ok, _ in results if not ok]
    print(f"RESULT {len(results) - len(failed)}/{len(results)} checks passed: "
          f"{'PASS' if not failed else 'FAIL ' + ', '.join(failed)}")  # fmt: skip
    return 0 if not failed else 1


def alerts_flow(api: httpx.Client, page: ClientConnection, mirror: ClientConnection) -> None:
    key = f"e2e-door-{int(time.time())}"
    body = {
        "key": key,
        "source": "homeassistant",
        "urgency": "urgent",
        "text": "La puerta del garaje está abierta.",
        "lang": "es",
    }
    sent = time.monotonic()
    r = api.post("/alerts", json=body)
    check("post 201", r.status_code == 201, f"{r.status_code} {r.text}")
    for name, ws in (("page", page), ("mirror", mirror)):
        snap = wait_for(ws, snapshot_where(lambda s: key in keys(s)), 5)
        ms = round((time.monotonic() - sent) * 1000)
        item = alert_in(snap, key)
        check(
            f"snapshot on {name} within 1 s",
            snap is not None and ms < 1000 and item.get("urgency") == "urgent",
            f"{ms} ms {item}",
        )

    page.send(json.dumps({"type": "alert_read", "key": key}))
    head = wait_for(page, lambda m: isinstance(m, dict) and m["type"] in ("tts", "error"), 60)
    frame = page.recv(timeout=10) if head and head["type"] == "tts" else None
    ok = (
        head is not None
        and head.get("alert") == key
        and head.get("turn") is None
        and head.get("final") is True
        and isinstance(frame, bytes)
    )
    detail = str(head)
    if ok:
        assert isinstance(frame, bytes)
        rate, seconds = wav_info(frame)
        detail = f"WAV {rate} Hz {seconds:.2f} s"
        ok = seconds > 0
    check("alert_read -> tts WAV", ok, detail)

    page.send(json.dumps({"type": "alert_ack", "key": key}))
    snap = wait_for(page, snapshot_where(lambda s: key not in keys(s)), 5)
    state = {x["key"]: x["state"] for x in api.get("/alerts").json()}.get(key)
    check("alert_ack -> gone from snapshot", snap is not None and state == "acked", f"{state}")

    page.send(json.dumps({"type": "alert_read", "key": "no-such-alert"}))
    err = wait_for(page, lambda m: isinstance(m, dict) and m["type"] == "error", 5)
    check("alert_read unknown -> bad_message", err == {"type": "error", "code": "bad_message"})
    api.delete(f"/alerts/{key}")


def timer_flow(api: httpx.Client, page: ClientConnection) -> None:
    key = f"e2e-timer-{int(time.time())}"
    r = api.post(
        "/alerts", json={"key": key, "source": "timer", "text": "Fin de la prueba.", "in_s": 2}
    )
    posted = time.monotonic()
    check("timer pending", r.status_code == 201 and r.json()["state"] == "pending", r.text)
    snap = wait_for(page, snapshot_where(lambda s: key in keys(s)), 6)
    secs = time.monotonic() - posted
    item = alert_in(snap, key)
    check(
        "timer fires, snapshot changes",
        snap is not None and 1.0 <= secs <= 3.5 and item.get("late") is False,
        f"after {secs:.2f} s {item}",
    )
    page.send(json.dumps({"type": "alert_ack", "key": key}))
    wait_for(page, snapshot_where(lambda s: key not in keys(s)), 5)
    api.delete(f"/alerts/{key}")


def voice_timer_flow(api: httpx.Client, page: ClientConnection, a: argparse.Namespace) -> None:
    before_hermes = httpx.get(f"{a.hermes}/requests").json()["count"]
    before = {x["key"] for x in api.get("/alerts").json()}
    if a.timer_wav:
        samples, rate = read_wav(a.timer_wav)
        pcm = to_pcm16k(samples, rate)
    else:
        pcm = (np.ones(PCM_RATE, dtype="<i2") * 3000).tobytes()  # 1 s, loud enough for FakeStt
    page.send(json.dumps({"type": "tap"}))

    def state_or_error(m: Any) -> bool:
        return isinstance(m, dict) and m["type"] in ("state", "error")

    st = wait_for(page, state_or_error, 10)
    while st is not None and st["type"] == "state" and st["conv"] != "listening":
        st = wait_for(page, state_or_error, 10)
    if not st or st["type"] != "state":
        check("voice timer turn", False, f"tap refused: {st}")
        return
    header = {
        "type": "utterance",
        "turn": st["turn"],
        "format": "pcm_s16le",
        "rate": PCM_RATE,
        "dur_ms": len(pcm) * 1000 // (2 * PCM_RATE),
        "tail_silence_ms": 500,
    }
    page.send(json.dumps(header))
    page.send(pcm)
    started = time.time()
    got_audio = False
    done = None
    while done is None:
        m = wait_for(page, lambda m: isinstance(m, bytes) or m["type"] == "turn_done", 180)
        if m is None:
            break
        if isinstance(m, bytes):
            got_audio = True
        else:
            done = m
    check(
        "voice timer turn ok with audio",
        done is not None and done["reason"] == "ok" and got_audio,
        f"{done}",
    )
    new = [x for x in api.get("/alerts").json() if x["key"] not in before]
    timer = next((x for x in new if x["key"].startswith("timer-")), None)
    ahead = timer["fire_at"] - started if timer and timer["fire_at"] else None
    check(
        "voice timer pending ~60 s ahead",
        timer is not None and timer["state"] == "pending" and ahead is not None and 50 < ahead < 70,
        f"{timer} ahead={ahead}",
    )
    after_hermes = httpx.get(f"{a.hermes}/requests").json()["count"]
    check("no Hermes call", after_hermes == before_hermes, f"{before_hermes} -> {after_hermes}")
    if timer:
        api.delete(f"/alerts/{timer['key']}")


def wake_flow(stack: ExitStack, a: argparse.Namespace, t0: float) -> None:
    desk = open_session(stack, a.url, a.session, t0)
    desk.send(json.dumps({"type": "wake"}))
    err = wait_for(desk, lambda m: isinstance(m, dict) and m["type"] == "error", 5)
    check(
        "wake outside the wake group -> bad_message",
        err == {"type": "error", "code": "bad_message"},
    )
    tab = open_session(stack, a.url, a.wake_session, t0)
    tab.send(json.dumps({"type": "wake"}))
    st = wait_for(
        tab,
        lambda m: isinstance(m, dict) and (m["type"] == "error" or m.get("conv") == "listening"),
        5,
    )
    ok = st is not None and st.get("conv") == "listening"
    check("wake in the wake group -> listening", ok, f"{st}")
    if ok:
        tab.send(json.dumps({"type": "cancel", "turn": st["turn"]}))
        wait_for(tab, lambda m: isinstance(m, dict) and m["type"] == "turn_done", 5)


def recurring_flow(api: httpx.Client, page: ClientConnection, tz: ZoneInfo, wait: bool) -> None:
    key = f"e2e-repeat-{int(time.time())}"
    # The minute after the next one: rings 60 to 120 s from now, in local time.
    ring = datetime.now(tz).replace(second=0, microsecond=0) + timedelta(minutes=2)
    rule = f"daily {ring:%H:%M}"
    body = {"key": key, "source": "reminder", "text": "Prueba de recordatorio.", "repeat": rule}
    r = api.post("/alerts", json=body)
    want = int(ring.timestamp())
    got = r.json() if r.status_code == 201 else {}
    check(
        "recurring pending at the next local time",
        got.get("state") == "pending" and got.get("fire_at") == want and got.get("repeat") == rule,
        f"{r.status_code} {r.text} want fire_at={want}",
    )
    again = api.post("/alerts", json=body)
    check(
        "recurring re-sent is ignored",
        again.status_code == 200 and again.json().get("fire_at") == want,
        f"{again.status_code} {again.text}",
    )
    bad = [
        api.post("/alerts", json={**body, "key": f"{key}-bad", "repeat": "every day at 9"}),
        api.post("/alerts", json={**body, "key": f"{key}-bad", "in_s": 60}),
    ]
    check("recurring bad rule -> 422", all(b.status_code == 422 for b in bad), str(bad))
    listed = {x["key"]: x for x in api.get("/alerts").json()}
    check("recurring listed with its rule", listed.get(key, {}).get("repeat") == rule)
    if wait:
        snap = wait_for(page, snapshot_where(lambda s: key in keys(s)), 150)
        check("recurring rings", snap is not None, str(alert_in(snap, key)))
        if snap is not None:
            page.send(json.dumps({"type": "alert_ack", "key": key}))
            wait_for(page, snapshot_where(lambda s: key not in keys(s)), 5)
            row = {x["key"]: x for x in api.get("/alerts").json()}.get(key, {})
            ahead = (row.get("fire_at") or 0) - want
            check(
                "recurring heard -> pending tomorrow",
                row.get("state") == "pending" and 23 * 3600 <= ahead <= 25 * 3600,
                f"{row} ahead={ahead}",
            )
    api.delete(f"/alerts/{key}")
    gone = key not in {x["key"] for x in api.get("/alerts").json()}
    check("recurring cancelled by DELETE", gone)


if __name__ == "__main__":
    sys.exit(main())
