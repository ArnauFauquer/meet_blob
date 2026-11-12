"""Generate the page's static sounds.

S1: web/public/beep.wav, 0.3 s of a 440 Hz sine (played when speech output fails).
S4 adds web/public/chime.wav here.

Run: python3 scripts/make_sounds.py
"""

import math
import struct
import wave
from pathlib import Path

RATE = 24000
PUBLIC = Path(__file__).resolve().parent.parent / "web" / "public"


def sine(freq: float, seconds: float, volume: float = 0.4, fade_s: float = 0.01) -> bytes:
    n = int(RATE * seconds)
    fade = int(RATE * fade_s)
    frames = bytearray()
    for i in range(n):
        # short fades at both ends so the beep does not click
        env = min(1.0, i / fade, (n - 1 - i) / fade)
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
    print(f"wrote {PUBLIC / 'beep.wav'}")
