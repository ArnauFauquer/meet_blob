"""Text to speech with kokoro-onnx. Nothing outside this module knows its internals."""

import logging
import os
from pathlib import Path
from typing import Any

import httpx

from .audio import wav_bytes
from .voices import FALLBACK_LINES, fallback_lang, voice_for

log = logging.getLogger(__name__)

RELEASE = "https://github.com/thewh1teagle/kokoro-onnx/releases/download/model-files-v1.0"
FILES = ("kokoro-v1.0.onnx", "voices-v1.0.bin")


def download(model_dir: Path) -> None:
    """Fetch the model files once; a .part file means an interrupted download is retried."""
    model_dir.mkdir(parents=True, exist_ok=True)
    for name in FILES:
        dest = model_dir / name
        if dest.exists():
            continue
        log.info("downloading %s", name)
        part = dest.with_suffix(dest.suffix + ".part")
        with httpx.stream("GET", f"{RELEASE}/{name}", follow_redirects=True, timeout=60) as r:
            r.raise_for_status()
            with part.open("wb") as f:
                for chunk in r.iter_bytes(1 << 20):
                    f.write(chunk)
        os.replace(part, dest)


class KokoroTts:
    def __init__(self, model_dir: str, device: str) -> None:
        self._dir = Path(model_dir) / "kokoro"
        self._device = device
        self._kokoro: Any = None
        self.rate = 24000
        self._fallbacks: dict[str, bytes] = {}

    def load(self) -> None:
        import onnxruntime as rt
        from kokoro_onnx import Kokoro

        download(self._dir)
        providers = ["CUDAExecutionProvider"] if self._device == "cuda" else []
        session = rt.InferenceSession(
            str(self._dir / FILES[0]), providers=[*providers, "CPUExecutionProvider"]
        )
        self._kokoro = Kokoro.from_session(session, str(self._dir / FILES[1]))

    def warmup(self) -> None:
        self("Hola.", "es")

    def prerender_fallbacks(self) -> None:
        self._fallbacks = {lang: self(text, lang) for lang, text in FALLBACK_LINES.items()}

    def fallback(self, lang: str | None) -> bytes:
        return self._fallbacks[fallback_lang(lang)]

    def __call__(self, text: str, lang: str | None) -> bytes:
        voice = voice_for(lang)
        samples, rate = self._kokoro.create(text, voice=voice.name, speed=1.0, lang=voice.lang)
        self.rate = rate
        return wav_bytes(samples, rate)
