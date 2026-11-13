"""Debug switch: keep the last utterances a device sent, as WAV files, to listen to them.

Also the wake word clips the page sends (wake_clip), in <dir>/wake/<label>/, to retrain the wake
word on the real microphone and voice (tools/wake-word/train_verifier.py).

Off unless DEBUG_AUDIO_DIR is set. Personal voice recordings: turn it off again after debugging
and delete the folder.
"""

import logging
import time
import wave
from collections.abc import Callable
from pathlib import Path

log = logging.getLogger(__name__)

PCM_RATE = 16000  # the utterance format: 16 kHz mono signed 16-bit little-endian


class AudioDump:
    def __init__(
        self,
        folder: str,
        keep: int,
        wake_keep: int = 500,
        wall: Callable[[], float] = time.time,
    ) -> None:
        self.dir = Path(folder)
        self.keep = keep
        self.wake_keep = wake_keep
        self._wall = wall

    def save(self, device: str, turn: int, pcm: bytes) -> Path | None:
        """Write one utterance (16 kHz mono s16le) and drop the oldest files beyond `keep`."""
        return self._write(self.dir, f"{_safe(device)}_turn{turn}", pcm, self.keep)

    def save_wake(self, device: str, label: str, peak: float, pcm: bytes) -> Path | None:
        """Write one wake word clip under wake/<label>/; the file name carries the peak score."""
        name = f"{_safe(device)}_p{round(peak * 1000):04d}"
        return self._write(self.dir / "wake" / _safe(label), name, pcm, self.wake_keep)

    def _write(self, folder: Path, name: str, pcm: bytes, keep: int) -> Path | None:
        try:
            folder.mkdir(parents=True, exist_ok=True)
            t = self._wall()
            stamp = time.strftime("%Y%m%d-%H%M%S", time.gmtime(t)) + f"{int(t * 1000) % 1000:03d}"
            path = folder / f"{stamp}_{name}.wav"
            with wave.open(str(path), "wb") as w:
                w.setnchannels(1)
                w.setsampwidth(2)
                w.setframerate(PCM_RATE)
                w.writeframes(pcm)
            for old in sorted(folder.glob("*.wav"))[:-keep]:
                old.unlink(missing_ok=True)
            log.info("debug audio: saved %s (%d ms)", path.name, len(pcm) * 1000 // (2 * PCM_RATE))
            return path
        except OSError:
            log.exception("debug audio: could not save %s", name)
            return None


def _safe(s: str) -> str:
    return "".join(c if c.isalnum() or c in "-_" else "_" for c in s)[:32]
