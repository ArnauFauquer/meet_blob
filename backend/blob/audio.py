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


def read_wav(path: str) -> tuple[NDArray[np.float32], int]:
    """A 16-bit WAV file to mono float samples and its sample rate."""
    with wave.open(path, "rb") as w:
        if w.getsampwidth() != 2:
            raise ValueError(f"{path}: only 16-bit WAV is supported")
        rate, channels = w.getframerate(), w.getnchannels()
        samples = pcm_to_float(w.readframes(w.getnframes()))
    return samples.reshape(-1, channels).mean(axis=1, dtype=np.float32), rate


def resample(samples: NDArray[np.float32], src: int, dst: int) -> NDArray[np.float32]:
    """Linear resampling; good enough for test clips and scripts, not used on live audio."""
    if src == dst or samples.size == 0:
        return samples
    n = round(samples.size * dst / src)
    return np.interp(np.arange(n) * src / dst, np.arange(samples.size), samples).astype(np.float32)


def to_pcm16k(samples: NDArray[np.float32], rate: int) -> bytes:
    """What the page sends: little-endian signed 16-bit mono PCM at 16 kHz."""
    out = resample(samples, rate, 16000)
    return (np.clip(out, -1.0, 1.0) * 32767).astype("<i2").tobytes()
