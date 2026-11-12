import io
import wave
from pathlib import Path

import numpy as np
import pytest

from blob.audio import pcm_to_float, read_wav, resample, to_pcm16k, tone_wav
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


def test_read_wav_and_resample(tmp_path: Path) -> None:
    path = tmp_path / "t.wav"
    path.write_bytes(tone_wav(1.0, 440, 24000))
    samples, rate = read_wav(str(path))
    assert rate == 24000 and samples.size == 24000
    assert resample(samples, rate, rate) is samples
    assert len(to_pcm16k(samples, rate)) == 32000


def test_read_wav_stereo_and_8bit(tmp_path: Path) -> None:
    stereo = tmp_path / "s.wav"
    with wave.open(str(stereo), "wb") as w:
        w.setnchannels(2)
        w.setsampwidth(2)
        w.setframerate(16000)
        w.writeframes(np.array([1000, 3000] * 10, dtype="<i2").tobytes())
    samples, _ = read_wav(str(stereo))
    assert samples.size == 10 and abs(samples[0] - 2000 / 32768) < 1e-6
    byte = tmp_path / "b.wav"
    with wave.open(str(byte), "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(1)
        w.setframerate(8000)
        w.writeframes(bytes(10))
    with pytest.raises(ValueError, match="16-bit"):
        read_wav(str(byte))
