"""Generate the page's static sounds.

S1: web/public/beep.wav, 0.3 s of a 440 Hz sine (played when speech output fails).
S4: web/public/bubble-{a,b,c}.wav, the alert alarm's sounds: liquid bubbles, like the blob
itself. A bubble is a sine whose pitch climbs fast while it dies away, rounded by a soft
low-pass. a: "blub-blub-bloop", three rising bubbles. b: "gloop... pop", a deep bubble and a
small one above it. c: a short irregular string of small bubbles. The page plays one at
random (never the same twice in a row, slightly detuned) each time the alarm rings.

Run: python3 scripts/make_sounds.py
"""

import math
import struct
import wave
from pathlib import Path

RATE = 24000
PUBLIC = Path(__file__).resolve().parent.parent / "web" / "public"


def sine(freq: float, seconds: float, volume: float = 0.4, fade_s: float = 0.01, decay_s: float = 0.0) -> bytes:
    n = int(RATE * seconds)
    fade = int(RATE * fade_s)
    frames = bytearray()
    for i in range(n):
        # short fades at both ends so the sound does not click; decay_s > 0 adds a bell-like decay
        env = min(1.0, i / fade, (n - 1 - i) / fade)
        if decay_s:
            env *= math.exp(-i / (RATE * decay_s))
        frames += struct.pack("<h", int(32767 * volume * env * math.sin(2 * math.pi * freq * i / RATE)))
    return bytes(frames)


def bubble(f0: float, rise: float = 1.9, dur: float = 0.11, vol: float = 0.5) -> list[float]:
    """One bubble: the pitch climbs from f0 to f0 * rise over dur while it decays."""
    decay = dur / 3.2
    n = int(RATE * (dur + 0.02))
    phase = 0.0
    out = []
    for i in range(n):
        t = i / RATE
        phase += 2 * math.pi * f0 * (1 + (rise - 1) * min(1.0, t / dur) ** 0.7) / RATE
        out.append(vol * min(1.0, t / 0.004) * math.exp(-t / decay) * math.sin(phase))
    return out


def bubbles(parts: list[tuple[float, list[float]]], peak: float = 0.6, tail_s: float = 0.3) -> bytes:
    """(start_s, bubble) pairs mixed, low-passed for a rounder, wetter tone, and scaled to peak."""
    n = max(int(RATE * start) + len(p) for start, p in parts) + int(RATE * tail_s)
    buf = [0.0] * n
    for start, p in parts:
        o = int(RATE * start)
        for i, v in enumerate(p):
            buf[o + i] += v
    y = 0.0
    for i in range(n):  # one-pole low-pass
        y += 0.35 * (buf[i] - y)
        buf[i] = y
    k = peak / max(abs(v) for v in buf)
    return b"".join(struct.pack("<h", int(32767 * v * k)) for v in buf)


BUBBLES = {
    "a": [(0.00, bubble(330, vol=0.55)), (0.16, bubble(400, vol=0.5)), (0.30, bubble(520, rise=2.1, dur=0.14, vol=0.6))],
    "b": [(0.00, bubble(190, rise=1.7, dur=0.22, vol=0.7)), (0.32, bubble(620, rise=2.2, dur=0.08, vol=0.45))],
    "c": [
        (0.00, bubble(450, dur=0.07, vol=0.4)),
        (0.09, bubble(520, dur=0.06, vol=0.35)),
        (0.15, bubble(400, dur=0.08, vol=0.4)),
        (0.27, bubble(600, dur=0.06, vol=0.35)),
        (0.34, bubble(480, dur=0.07, vol=0.4)),
        (0.48, bubble(700, rise=2.0, dur=0.09, vol=0.45)),
    ],
}


def write(path: Path, pcm: bytes) -> None:
    with wave.open(str(path), "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(RATE)
        w.writeframes(pcm)


if __name__ == "__main__":
    PUBLIC.mkdir(parents=True, exist_ok=True)
    write(PUBLIC / "beep.wav", sine(440, 0.3))
    for name, parts in BUBBLES.items():
        write(PUBLIC / f"bubble-{name}.wav", bubbles(parts))
    print(f"wrote beep.wav and bubble-{{{','.join(BUBBLES)}}}.wav in {PUBLIC}")
