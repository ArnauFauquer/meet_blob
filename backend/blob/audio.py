"""PCM and WAV helpers shared by the model wrappers, the fakes and the scripts."""

import io
import wave

import numpy as np
from numpy.typing import NDArray


def pcm_to_float(pcm: bytes) -> NDArray[np.float32]:
    """Little-endian signed 16-bit PCM to float samples in [-1, 1]."""
    return np.frombuffer(pcm, dtype="<i2").astype(np.float32) / 32768.0


def wav_bytes(samples: NDArray[np.floating], rate: int) -> bytes:
    """Mono float samples to a 16-bit WAV file."""
    pcm = (np.clip(samples, -1.0, 1.0) * 32767).astype("<i2")
    buf = io.BytesIO()
    with wave.open(buf, "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(rate)
        w.writeframes(pcm.tobytes())
    return buf.getvalue()


def tone_wav(seconds: float = 0.4, freq: float = 440.0, rate: int = 24000) -> bytes:
    t = np.arange(int(seconds * rate)) / rate
    return wav_bytes(0.3 * np.sin(2 * np.pi * freq * t), rate)
