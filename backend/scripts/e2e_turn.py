"""Scripted page: one turn over a real WebSocket, printing every message until turn_done.

    uv run python scripts/e2e_turn.py --wav tests/clips/es.wav --session "$BLOB_SESSION" --expect ok

--session is the blob_session cookie of a browser signed in to that Blob (copy it from the
browser's developer tools: Application > Cookies).

Options: --empty sends a zero-length utterance; --cancel-after S cancels S seconds after the
utterance; --busy-check taps from a second connection while the turn is open and expects
error busy; --expect-error CODE expects the tap itself to get that error (for not_ready).
S3: --wake sends wake instead of tap (--followup sets wake.followup; the session's user must be
in the wake group); --expect-followup true|false checks the tts followup flag.
Exit status 0 when every expectation holds.
"""

import argparse
import io
import json
import sys
import time
import wave
from contextlib import ExitStack
from typing import Any

from websockets.sync.client import ClientConnection, connect

from blob import __version__
from blob.audio import PCM_RATE, read_wav, to_pcm16k

TIMING_KEYS = {"stt_ms", "hermes_ms", "tts_ms", "first_audio_ms", "sc1_ms"}


def recv(ws: ClientConnection, t0: float) -> Any:
    raw = ws.recv(timeout=180)
    ms = round((time.monotonic() - t0) * 1000)
    if isinstance(raw, bytes):
        print(f"[{ms:>6} ms] <binary {len(raw)} bytes>")
        return raw
    msg = json.loads(raw)
    print(f"[{ms:>6} ms] {raw}")
    return msg


def open_session(stack: ExitStack, url: str, session: str, t0: float) -> ClientConnection:
    """A signed-in connection: the session cookie rides on the upgrade (no Origin header)."""
    cookie = {"Cookie": f"blob_session={session}"}
    ws = stack.enter_context(connect(url, max_size=None, additional_headers=cookie))
    ws.send(json.dumps({"type": "hello", "version": __version__}))
    hello_ok = recv(ws, t0)
    assert hello_ok["type"] == "hello_ok", hello_ok
    assert recv(ws, t0)["type"] == "snapshot"
    return ws


def wav_info(data: bytes) -> tuple[int, float]:
    with wave.open(io.BytesIO(data)) as w:
        return w.getframerate(), w.getnframes() / w.getframerate()


def main() -> int:
    with ExitStack() as stack:
        return turn(stack)


def turn(stack: ExitStack) -> int:
    p = argparse.ArgumentParser()
    p.add_argument("--url", default="ws://127.0.0.1:8000/ws")
    p.add_argument("--session", required=True, help="blob_session cookie of a signed-in browser")
    p.add_argument("--wav", help="16-bit WAV to send (any rate; resampled to 16 kHz)")
    p.add_argument("--empty", action="store_true", help="send dur_ms 0 and no audio")
    p.add_argument("--tail-silence-ms", type=int, default=500)
    p.add_argument("--cancel-after", type=float)
    p.add_argument("--busy-check", action="store_true")
    p.add_argument("--expect", help="expected turn_done reason")
    p.add_argument("--expect-error", help="expected error code for the tap")
    p.add_argument("--save-tts", help="write the received WAV here")
    p.add_argument("--wake", action="store_true", help="start with wake instead of tap")
    p.add_argument("--followup", action="store_true", help="wake.followup = true")
    p.add_argument("--expect-followup", choices=["true", "false"])
    a = p.parse_args()
    if not a.empty and not a.wav:
        p.error("give --wav, or --empty for a zero-length utterance")
    failures: list[str] = []
    t0 = time.monotonic()

    ws = open_session(stack, a.url, a.session, t0)
    start = {"type": "wake", "followup": a.followup} if a.wake else {"type": "tap"}
    ws.send(json.dumps(start))
    if a.expect_error:
        msg = recv(ws, t0)
        ok = msg == {"type": "error", "code": a.expect_error}
        print(f"RESULT tap -> {msg}: {'PASS' if ok else 'FAIL'}")
        return 0 if ok else 1
    while True:
        msg = recv(ws, t0)
        if msg["type"] == "error":
            print(f"RESULT tap refused: {msg}: FAIL")
            return 1
        if msg["type"] == "state" and msg["conv"] == "listening":
            turn = msg["turn"]
            break

    if a.busy_check:
        other = open_session(stack, a.url, a.session, t0)
        other.send(json.dumps({"type": "tap"}))
        msg = recv(other, t0)
        if msg != {"type": "error", "code": "busy"}:
            failures.append(f"second tap got {msg}, not busy")

    pcm = b""
    if not a.empty:
        samples, rate = read_wav(a.wav)
        pcm = to_pcm16k(samples, rate)
    header = {
        "type": "utterance",
        "turn": turn,
        "format": "pcm_s16le",
        "rate": PCM_RATE,
        "dur_ms": len(pcm) * 1000 // (2 * PCM_RATE),
        "tail_silence_ms": a.tail_silence_ms,
    }
    t0 = time.monotonic()  # message times below are from the utterance
    ws.send(json.dumps(header))
    if pcm:
        ws.send(pcm)
    if a.cancel_after is not None:
        time.sleep(a.cancel_after)
        ws.send(json.dumps({"type": "cancel", "turn": turn}))

    tts: bytes | None = None
    followup = None
    expect_frame = False
    while True:
        msg = recv(ws, t0)
        if expect_frame:
            if not isinstance(msg, bytes):
                failures.append("tts header not followed by its binary frame")
            tts, expect_frame = msg, False
            continue
        if msg["type"] == "tts":
            expect_frame = True
            followup = msg["followup"]
        if msg["type"] == "turn_done":
            done = msg
            break

    if tts is not None:
        rate, seconds = wav_info(tts)
        print(f"tts wav: {len(tts)} bytes, {rate} Hz, {seconds:.2f} s")
        if seconds <= 0:
            failures.append("empty WAV")
        if a.save_tts:
            with open(a.save_tts, "wb") as f:
                f.write(tts)
    if set(done["timings"]) != TIMING_KEYS:
        failures.append(f"timings keys {sorted(done['timings'])}")
    if a.expect and done["reason"] != a.expect:
        failures.append(f"reason {done['reason']}, expected {a.expect}")
    if a.expect == "ok" and tts is None:
        failures.append("no tts audio")
    if a.expect_followup and str(followup).lower() != a.expect_followup:
        failures.append(f"followup {followup}, expected {a.expect_followup}")
    print(f"timings: {json.dumps(done['timings'])}")
    print(
        f"RESULT reason={done['reason']} timeout_kind={done['timeout_kind']}: "
        f"{'PASS' if not failures else 'FAIL ' + '; '.join(failures)}"
    )
    return 0 if not failures else 1


if __name__ == "__main__":
    sys.exit(main())
