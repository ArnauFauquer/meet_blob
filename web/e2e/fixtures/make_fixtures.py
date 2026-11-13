"""Synthesise the wake word and VAD test clips with Kokoro (no human voice).

Run with the backend environment, which has kokoro-onnx and the model files:

    cd backend && uv run python ../web/e2e/fixtures/make_fixtures.py [--model-dir ~/.cache/blob-models]

Writes 16 kHz mono 16-bit WAV files next to this script:
  hey-jarvis.wav  1 s silence, "Hey Jarvis.", 0.4 s, "What time is it?", 2.5 s silence
  question.wav    0.3 s silence, "What is the capital of France?", 4 s silence
"""

import argparse
import wave
from pathlib import Path

import numpy as np
from kokoro_onnx import Kokoro

HERE = Path(__file__).resolve().parent
RATE = 16000


def say(k: Kokoro, text: str, voice: str) -> np.ndarray:
    s, sr = k.create(text, voice=voice, speed=1.0, lang="en-us")
    n = int(len(s) * RATE / sr)
    return np.interp(np.linspace(0, len(s) - 1, n), np.arange(len(s)), s) * 0.7


def silence(seconds: float) -> np.ndarray:
    return np.zeros(int(RATE * seconds))


def write(name: str, *parts: np.ndarray) -> None:
    x = np.concatenate(parts)
    with wave.open(str(HERE / name), "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(RATE)
        w.writeframes((np.clip(x, -1, 1) * 32767).astype(np.int16).tobytes())
    print(f"{name}: {len(x) / RATE:.2f} s")


def main() -> None:
    p = argparse.ArgumentParser()
    p.add_argument("--model-dir", default=str(Path.home() / ".cache/blob-models"))
    a = p.parse_args()
    d = Path(a.model_dir).expanduser() / "kokoro"
    k = Kokoro(str(d / "kokoro-v1.0.onnx"), str(d / "voices-v1.0.bin"))
    write("hey-jarvis.wav", silence(1.0), say(k, "Hey Jarvis.", "am_adam"), silence(0.4),
          say(k, "What time is it?", "am_adam"), silence(2.5))
    write("question.wav", silence(0.3), say(k, "What is the capital of France?", "af_heart"), silence(4.0))


if __name__ == "__main__":
    main()
