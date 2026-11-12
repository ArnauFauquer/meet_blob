"""Transcribe a WAV file with faster-whisper and print text, language, no-speech probability, time.

uv run python scripts/stt_cli.py tests/clips/es.wav [--model small] [--compute int8]
"""

import argparse
import time

from blob.audio import read_wav, resample
from blob.stt import WhisperStt, is_empty


def main() -> None:
    p = argparse.ArgumentParser()
    p.add_argument("wav")
    p.add_argument("--model", default="small")
    p.add_argument("--compute", default="int8")
    p.add_argument("--model-dir", default=".models")
    p.add_argument("--no-speech-max", type=float, default=0.6)
    a = p.parse_args()
    stt = WhisperStt(a.model, a.compute, a.model_dir)
    t0 = time.perf_counter()
    stt.load()
    print(f"load: {time.perf_counter() - t0:.1f} s")
    samples, rate = read_wav(a.wav)
    t0 = time.perf_counter()
    r = stt(resample(samples, rate, 16000))
    print(f"text: {r.text!r}")
    empty = is_empty(r, a.no_speech_max)
    print(f"lang: {r.lang}  no_speech_prob: {r.no_speech_prob:.3f}  empty: {empty}")
    print(f"time: {time.perf_counter() - t0:.2f} s for {samples.size / rate:.2f} s of audio")


if __name__ == "__main__":
    main()
