"""Real-model smoke test (marker gpu; skipped in CI). Runs on CPU or GPU.

Locally: uv run python scripts/make_test_clips.py, then
    STT_MODEL=small STT_COMPUTE=int8 MODEL_DIR=.models uv run pytest -m gpu -s
"""

import io
import os
import time
import wave

import pytest

from blob.audio import read_wav, resample
from blob.stt import WhisperStt, is_empty
from blob.tts import KokoroTts
from tests.conftest import CLIPS

pytestmark = pytest.mark.gpu
MODEL_DIR = os.environ.get("MODEL_DIR", ".models")


@pytest.fixture(scope="module")
def stt() -> WhisperStt:
    model = WhisperStt(
        os.environ.get("STT_MODEL", "small"), os.environ.get("STT_COMPUTE", "int8"), MODEL_DIR
    )
    model.load()
    model.warmup()
    return model


@pytest.fixture(scope="module")
def tts() -> KokoroTts:
    model = KokoroTts(MODEL_DIR, os.environ.get("KOKORO_DEVICE", "cpu"))
    model.load()
    model.warmup()
    return model


def clip(name: str) -> str:
    path = CLIPS / f"{name}.wav"
    if not path.exists():
        pytest.skip(f"{path} missing; run scripts/make_test_clips.py")
    return str(path)


@pytest.mark.parametrize("lang", ["es", "en"])
def test_transcribe(stt: WhisperStt, lang: str) -> None:
    samples, rate = read_wav(clip(lang))
    t0 = time.perf_counter()
    r = stt(resample(samples, rate, 16000))
    took = time.perf_counter() - t0
    print(f"\n{lang}: {r.text!r} lang={r.lang} p={r.no_speech_prob:.2f} {took:.2f}s")
    assert r.lang == lang
    assert "capital" in r.text.lower()
    assert not is_empty(r, 0.6)


def test_silence_is_empty(stt: WhisperStt) -> None:
    samples, _ = read_wav(clip("silence"))
    assert is_empty(stt(samples), 0.6)


@pytest.mark.parametrize(
    ("text", "lang"),
    [("Hola, ¿qué tal estás hoy?", "es"), ("Hello, how are you today?", "en"), ("Bon dia.", "ca")],
)
def test_synthesise(tts: KokoroTts, text: str, lang: str) -> None:
    t0 = time.perf_counter()
    wav = tts(text, lang)
    with wave.open(io.BytesIO(wav)) as w:
        seconds = w.getnframes() / w.getframerate()
        took = time.perf_counter() - t0
        print(f"\n{lang}: {seconds:.2f}s audio at {w.getframerate()} Hz in {took:.2f}s")
        assert w.getframerate() == 24000 and seconds > 0.5


def test_fallbacks(tts: KokoroTts) -> None:
    tts.prerender_fallbacks()
    assert tts.fallback("en")[:4] == b"RIFF" and tts.fallback("ca") == tts.fallback("es")


def test_voices_exist(tts: KokoroTts) -> None:
    voices = set(tts._kokoro.get_voices())
    assert {"ef_dora", "em_alex", "af_heart"} <= voices
