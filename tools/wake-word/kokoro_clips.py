"""Write Kokoro clips (16 kHz) for each phrase x voice x speed into eval/kokoro/<phrase>/."""

import re
from pathlib import Path

import numpy as np
import scipy.io.wavfile
from kokoro_onnx import Kokoro

MODELS = Path.home() / ".cache/blob-models/kokoro"
PHRASES = [
    "Hey Blob.",
    "hey blob, what time is it?",
    "Hey Bob.",
    "Hey blog.",
    "A blob.",
    "Hey Rob.",
    "The bulb is broken.",
    "Hey Jarvis.",
    "Oye, Bob.",
]
VOICE_PREFIXES = ("af", "am", "bf", "bm", "ef", "em")  # American, British and Spanish voices
SPEEDS = (0.9, 1.1)


def main() -> None:
    k = Kokoro(str(MODELS / "kokoro-v1.0.onnx"), str(MODELS / "voices-v1.0.bin"))
    voices = [v for v in k.get_voices() if v[:2] in VOICE_PREFIXES]
    print(len(voices), "voices")
    for text in PHRASES:
        out = Path("eval/kokoro") / re.sub(r"\W+", "_", text.lower()).strip("_")
        out.mkdir(parents=True, exist_ok=True)
        for v in voices:
            for sp in SPEEDS:
                s, sr = k.create(text, voice=v, speed=sp, lang="es" if v[0] == "e" else "en-us")
                n = int(len(s) * 16000 / sr)
                a = np.interp(np.linspace(0, len(s) - 1, n), np.arange(len(s)), s) * 0.7
                pcm = (np.clip(a, -1, 1) * 32767).astype(np.int16)
                scipy.io.wavfile.write(out / f"{v}_{sp}.wav", 16000, pcm)


if __name__ == "__main__":
    main()
