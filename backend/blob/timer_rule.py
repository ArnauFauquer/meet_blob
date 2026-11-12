"""Voice timer rule (S4): "pon un temporizador de 10 minutos" becomes a timer without Hermes.

Built because it is untested whether Hermes can call POST /alerts itself. TIMER_RULE=off turns
it off once Hermes creates timers. A transcript that does not match goes to Hermes unchanged.
"""

import re
from dataclasses import dataclass

from .voices import fallback_lang

_TIMER = re.compile(r"\b(?:temporizador(?:es)?|temporitzador(?:s)?|timers?)\b")
# Cancel, change, ask-about and negation words: those requests go to Hermes. ("para" is not
# here: in Spanish it also means "for", as in "un temporizador para 5 minutos".)
_NOT_A_NEW_TIMER = re.compile(
    r"\b(?:cancela\w*|cancel·la\w*|cancel\.la\w*|cancel\w*|quita\w*|borra\w*|elimina\w*|"
    r"parar|det[eé]n\w*|apaga\w*|cambia\w*|canvia\w*|modifica\w*|atura\w*|esborra\w*|treu\w*|"
    r"stop\w*|delete\w*|remove\w*|clear\w*|change\w*|cu[aá]nto|quant|queda\w*|how|left|"
    r"no|not|don'?t|never)\b"
)
_WORDS = {
    # Spanish
    "un": 1, "uno": 1, "una": 1, "dos": 2, "tres": 3, "cuatro": 4, "cinco": 5,
    "seis": 6, "siete": 7, "ocho": 8, "nueve": 9, "diez": 10,
    # Catalan (un, una, dos, tres as in Spanish)
    "dues": 2, "quatre": 4, "cinc": 5, "sis": 6, "set": 7, "vuit": 8, "nou": 9, "deu": 10,
    # English
    "a": 1, "an": 1, "one": 1, "two": 2, "three": 3, "four": 4, "five": 5,
    "six": 6, "seven": 7, "eight": 8, "nine": 9, "ten": 10,
}  # fmt: skip
_UNITS = {
    1: r"segundos?|segons?|seg|seconds?|secs?",
    60: r"minutos?|minuts?|min|minutes?|mins?",
    3600: r"horas?|hores|hours?|hrs?",
}
_UNIT = "|".join(f"(?P<u{s}>{p})" for s, p in _UNITS.items())
_NUMBER = r"\d+(?:[.,]\d+)?|" + "|".join(sorted(_WORDS, key=len, reverse=True))
_HALF = r"media|medio|mitja|mig|half an?|half"
_AMOUNT = re.compile(
    rf"\b(?:(?P<half>{_HALF})|(?P<n>{_NUMBER}))\s+(?:{_UNIT})\b"
    rf"(?P<plus_half>\s+(?:y|i|and)\s+(?:media|medio|mitja|mig|a half))?"
)


@dataclass(frozen=True)
class TimerRequest:
    key: str  # timer-<unix time>
    in_s: int
    text: str  # spoken when the timer fires
    lang: str  # "es" or "en"
    reply: str  # the confirmation spoken now


def parse_seconds(transcript: str) -> int | None:
    """The timer length in seconds, or None when the transcript is not a new timer."""
    text = transcript.lower()
    if not _TIMER.search(text) or _NOT_A_NEW_TIMER.search(text):
        return None
    total = 0.0
    for m in _AMOUNT.finditer(text):
        unit = next(s for s in _UNITS if m.group(f"u{s}"))
        n = m.group("n")  # None for "media hora", "half an hour"
        count = 0.5 if n is None else _WORDS.get(n) or float(n.replace(",", "."))
        total += (count + (0.5 if m.group("plus_half") else 0)) * unit
    seconds = round(total)
    return seconds if seconds > 0 else None


def _amount(seconds: int) -> tuple[int, str, str, str]:
    """(n, Spanish singular, Spanish plural, English) in the largest unit that divides evenly."""
    if seconds % 3600 == 0:
        return seconds // 3600, "hora", "horas", "hour"
    if seconds % 60 == 0:
        return seconds // 60, "minuto", "minutos", "minute"
    return seconds, "segundo", "segundos", "second"


def match(transcript: str, lang: str | None, now: float) -> TimerRequest | None:
    seconds = parse_seconds(transcript)
    if seconds is None:
        return None
    n, one, many, en = _amount(seconds)
    key = f"timer-{int(now)}"
    if fallback_lang(lang) == "en":
        return TimerRequest(
            key, seconds, f"Your {n} {en} timer is done.", "en", f"Okay, {n} {en} timer."
        )
    es = f"{n} {one if n == 1 else many}"
    return TimerRequest(
        key, seconds, f"El temporizador de {es} ha terminado.", "es", f"Vale, temporizador de {es}."
    )
