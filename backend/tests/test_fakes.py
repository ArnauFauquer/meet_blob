import io
import wave

import numpy as np

from blob.audio import pcm_to_float, tone_wav
from blob.fakes import FakeStt, FakeTts


def test_pcm_to_float() -> None:
    pcm = np.array([0, 16384, -32768], dtype="<i2").tobytes()
    assert pcm_to_float(pcm).tolist() == [0.0, 0.5, -1.0]


def test_tone_wav_is_valid() -> None:
    with wave.open(io.BytesIO(tone_wav(0.5, 440, 24000))) as w:
        assert (w.getnchannels(), w.getsampwidth(), w.getframerate(), w.getnframes()) == (
            1,
            2,
            24000,
            12000,
        )


def test_fake_stt() -> None:
    stt = FakeStt("hola", "es", 0.01)
    stt.load()
    stt.warmup()
    assert stt(np.full(1600, 0.2, dtype=np.float32)).text == "hola"
    assert stt(np.zeros(1600, dtype=np.float32)).text == ""
    assert stt(np.zeros(0, dtype=np.float32)).text == ""


def test_fake_tts() -> None:
    tts = FakeTts()
    tts.load()
    tts.warmup()
    tts.prerender_fallbacks()
    assert tts("hola", "es")[:4] == b"RIFF" and tts.fallback(None)[:4] == b"RIFF"
