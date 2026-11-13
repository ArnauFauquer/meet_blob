"""Generate the page's static sounds.

S1: web/public/beep.wav, 0.3 s of a 440 Hz sine (played when speech output fails).
S4: web/public/chime.wav, 0.4 s of 880 Hz with a short exponential decay (alert chime).

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


def write(path: Path, pcm: bytes) -> None:
    with wave.open(str(path), "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(RATE)
        w.writeframes(pcm)


if __name__ == "__main__":
    PUBLIC.mkdir(parents=True, exist_ok=True)
    write(PUBLIC / "beep.wav", sine(440, 0.3))
    write(PUBLIC / "chime.wav", sine(880, 0.4, volume=0.5, fade_s=0.005, decay_s=0.12))
    print(f"wrote {PUBLIC / 'beep.wav'} and {PUBLIC / 'chime.wav'}")
