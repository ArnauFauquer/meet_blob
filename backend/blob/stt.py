"""Speech to text with faster-whisper. Nothing outside this module knows its internals."""

from dataclasses import dataclass
from typing import Any

import numpy as np
from numpy.typing import NDArray


@dataclass(frozen=True)
class SttResult:
    text: str
    lang: str | None
    no_speech_prob: float


def is_empty(result: SttResult, limit: float) -> bool:
    """The one empty rule: no text, or the mean no-speech probability over segments above limit."""
    return not result.text.strip() or result.no_speech_prob > limit


class WhisperStt:
    def __init__(self, model: str, compute: str, model_dir: str) -> None:
        self._name, self._compute, self._dir = model, compute, model_dir
        self._model: Any = None

    def load(self) -> None:
        from faster_whisper import WhisperModel  # heavy import, only when models are used

        self._model = WhisperModel(
            self._name, device="auto", compute_type=self._compute, download_root=self._dir
        )

    def warmup(self) -> None:
        # vad_filter off so the model call is not skipped on silence
        self._run(np.zeros(16000, dtype=np.float32), vad_filter=False)

    def __call__(self, audio: NDArray[np.float32]) -> SttResult:
        return self._run(audio, vad_filter=True)

    def _run(self, audio: NDArray[np.float32], vad_filter: bool) -> SttResult:
        segments, info = self._model.transcribe(audio, vad_filter=vad_filter)
        segs = list(segments)  # the generator does the work; consume it in this thread
        text = " ".join(s.text.strip() for s in segs).strip()
        probs = [s.no_speech_prob for s in segs]
        prob = sum(probs) / len(probs) if probs else 1.0
        return SttResult(text=text, lang=info.language if segs else None, no_speech_prob=prob)
