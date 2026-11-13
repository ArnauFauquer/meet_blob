"""Debug switch: keep the last utterances a device sent, as WAV files, to listen to them.

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
    def __init__(self, folder: str, keep: int, wall: Callable[[], float] = time.time) -> None:
        self.dir = Path(folder)
        self.keep = keep
        self._wall = wall

    def save(self, device: str, turn: int, pcm: bytes) -> Path | None:
        """Write one utterance (16 kHz mono s16le) and drop the oldest files beyond `keep`."""
        try:
            self.dir.mkdir(parents=True, exist_ok=True)
            stamp = time.strftime("%Y%m%d-%H%M%S", time.gmtime(self._wall()))
            safe = "".join(c if c.isalnum() or c in "-_" else "_" for c in device)[:32]
            path = self.dir / f"{stamp}_{safe}_turn{turn}.wav"
            with wave.open(str(path), "wb") as w:
                w.setnchannels(1)
                w.setsampwidth(2)
                w.setframerate(PCM_RATE)
                w.writeframes(pcm)
            for old in sorted(self.dir.glob("*.wav"))[: -self.keep]:
                old.unlink(missing_ok=True)
            log.info("debug audio: saved %s (%d ms)", path.name, len(pcm) * 1000 // (2 * PCM_RATE))
            return path
        except OSError:
            log.exception("debug audio: could not save turn %s", turn)
            return None
