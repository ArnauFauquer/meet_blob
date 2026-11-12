"""BLOB_FAKE_MODELS=1: a canned transcript and a tone instead of the speech models.

It lets the page and end-to-end tests run fast without model files. The fakes plug into
the same turn pipeline and hub as the real models.
"""

import numpy as np
from numpy.typing import NDArray

from .audio import tone_wav
from .stt import SttResult


class FakeStt:
    def __init__(self, transcript: str, lang: str, silence_rms: float) -> None:
        self._transcript, self._lang, self._rms = transcript, lang, silence_rms

    def load(self) -> None: ...

    def warmup(self) -> None: ...

    def __call__(self, audio: NDArray[np.float32]) -> SttResult:
        # Quiet audio gives an empty result, so the empty-turn path works with fakes too.
        if audio.size == 0 or float(np.sqrt(np.mean(audio**2))) < self._rms:
            return SttResult(text="", lang=None, no_speech_prob=1.0)
        return SttResult(text=self._transcript, lang=self._lang, no_speech_prob=0.0)


class FakeTts:
    def load(self) -> None: ...

    def warmup(self) -> None: ...

    def prerender_fallbacks(self) -> None: ...

    def fallback(self, lang: str | None) -> bytes:
        return tone_wav(0.6, 330.0)

    def __call__(self, text: str, lang: str | None) -> bytes:
        return tone_wav(0.4, 440.0)
