"""Synthesise test clips with Kokoro into tests/clips/ (gitignored), so no human voice is needed.

    uv run python scripts/make_test_clips.py [--model-dir .models]

Writes 16 kHz mono 16-bit WAV files: es.wav, en.wav, ca.wav (Catalan text read by the Spanish
voice, so detection may say "es"), timer_es.wav ("pon un temporizador de 1 minuto", for the
timer rule), and silence.wav.
"""

import argparse
import wave
from pathlib import Path

import numpy as np

from blob.audio import read_wav, resample, wav_bytes
from blob.tts import KokoroTts

CLIPS = Path(__file__).resolve().parents[1] / "tests" / "clips"
TEXTS = {
    "es": ("¿Cuál es la capital de Francia?", "es"),
    "en": ("What is the capital of France?", "en"),
    "ca": ("Quina és la capital de França?", "ca"),
    "timer_es": ("Pon un temporizador de un minuto.", "es"),
}


def main() -> None:
    p = argparse.ArgumentParser()
    p.add_argument("--model-dir", default=".models")
    a = p.parse_args()
    CLIPS.mkdir(parents=True, exist_ok=True)
    tts = KokoroTts(a.model_dir, "cpu")
    tts.load()
    pad = np.zeros(8000, dtype=np.float32)  # 0.5 s before and after, like a real tap turn
    for name, (text, lang) in TEXTS.items():
        tmp = CLIPS / f"{name}.24k.wav"
        tmp.write_bytes(tts(text, lang))
        samples, rate = read_wav(str(tmp))
        tmp.unlink()
        clip = np.concatenate([pad, resample(samples, rate, 16000), pad])
        (CLIPS / f"{name}.wav").write_bytes(wav_bytes(clip, 16000))
    (CLIPS / "silence.wav").write_bytes(wav_bytes(np.zeros(32000, dtype=np.float32), 16000))
    for f in sorted(CLIPS.glob("*.wav")):
        with wave.open(str(f)) as w:
            print(f"{f.name}: {w.getnframes() / w.getframerate():.2f} s at {w.getframerate()} Hz")


if __name__ == "__main__":
    main()
