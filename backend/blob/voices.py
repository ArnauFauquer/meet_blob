"""Language to Kokoro voice, and the fixed fallback lines."""

from typing import NamedTuple


class Voice(NamedTuple):
    name: str  # Kokoro voice id in voices-v1.0.bin
    lang: str  # espeak language code passed to Kokoro


SPANISH = Voice("ef_dora", "es")
ENGLISH = Voice("af_heart", "en-us")

# Replacing the "ca" entry is how Catalan speech gets added later.
VOICES: dict[str, Voice] = {"ca": SPANISH, "es": SPANISH, "en": ENGLISH}

FALLBACK_LINES: dict[str, str] = {
    "es": "Lo siento, ahora no puedo responder. Inténtalo de nuevo más tarde.",
    "en": "Sorry, I can't answer right now. Please try again later.",
}


def voice_for(lang: str | None) -> Voice:
    return VOICES.get(lang or "", SPANISH)


def fallback_lang(lang: str | None) -> str:
    """The fallback line language: English for English, Spanish for everything else."""
    return "en" if voice_for(lang) is ENGLISH else "es"
