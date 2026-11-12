"""Synthesise text with kokoro-onnx; print the voice, sample rate and time.

uv run python scripts/tts_cli.py "Hola, ¿qué tal?" es out.wav
"""

import argparse
import time

from blob.tts import KokoroTts
from blob.voices import voice_for


def main() -> None:
    p = argparse.ArgumentParser()
    p.add_argument("text")
    p.add_argument("lang")
    p.add_argument("out")
    p.add_argument("--model-dir", default=".models")
    p.add_argument("--device", default="cpu", choices=["cpu", "cuda"])
    a = p.parse_args()
    tts = KokoroTts(a.model_dir, a.device)
    t0 = time.perf_counter()
    tts.load()
    print(f"load: {time.perf_counter() - t0:.1f} s")
    t0 = time.perf_counter()
    wav = tts(a.text, a.lang)
    took = time.perf_counter() - t0
    with open(a.out, "wb") as f:
        f.write(wav)
    voice = voice_for(a.lang)
    print(f"voice: {voice.name} ({voice.lang})  rate: {tts.rate} Hz  time: {took:.2f} s")


if __name__ == "__main__":
    main()
