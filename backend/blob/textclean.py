"""Turn a Hermes reply into text that sounds right when spoken."""

import re

_URL = re.compile(r"(https?://|www\.)\S+", re.IGNORECASE)
_MD_LINK = re.compile(r"!?\[([^\]]*)\]\([^)]*\)")
_CODE_FENCE = re.compile(r"```[^\n]*\n?")
_HEADING = re.compile(r"^\s{0,3}#{1,6}\s+", re.MULTILINE)
_BULLET = re.compile(r"^\s*(?:[-*+]|\d+[.)])\s+", re.MULTILINE)
_QUOTE = re.compile(r"^\s*>\s?", re.MULTILINE)
_MARKERS = re.compile(r"(\*\*|__|\*|`|~~|(?<!\w)_|_(?!\w))")
_EMOJI = re.compile(
    "[\U0001f000-\U0001faff\U00002600-\U000027bf\U0001f1e6-\U0001f1ff"
    "\U0000fe0f\U0000200d\U00002300-\U000023ff\U00002b00-\U00002bff]"
)
_SPACE = re.compile(r"\s+")
_SENTENCE_END = re.compile(r"[.!?…](?=\s|$)")
_TRAILING_QUOTES = "\"'»”\u2019)] \t\n"


# Unit symbols after a number, as words: (singular, plural). espeak spells the symbols
# letter by letter ("3680 W" -> "uve doble"). Bare "º" is left alone: in Spanish it is
# usually an ordinal ("1º").
_UNITS: dict[str, dict[str, tuple[str, str]]] = {
    "es": {
        "kWh": ("kilovatio hora", "kilovatios hora"),
        "Wh": ("vatio hora", "vatios hora"),
        "kW": ("kilovatio", "kilovatios"),
        "W": ("vatio", "vatios"),
        "mA": ("miliamperio", "miliamperios"),
        "A": ("amperio", "amperios"),
        "V": ("voltio", "voltios"),
        "°C": ("grado", "grados"),
        "ºC": ("grado", "grados"),
        "°": ("grado", "grados"),
        "km/h": ("kilómetro por hora", "kilómetros por hora"),
        "km": ("kilómetro", "kilómetros"),
        "cm": ("centímetro", "centímetros"),
        "mm": ("milímetro", "milímetros"),
        "kg": ("kilo", "kilos"),
        "€": ("euro", "euros"),
    },
    "en": {
        "kWh": ("kilowatt hour", "kilowatt hours"),
        "Wh": ("watt hour", "watt hours"),
        "kW": ("kilowatt", "kilowatts"),
        "W": ("watt", "watts"),
        "mA": ("milliamp", "milliamps"),
        "A": ("amp", "amps"),
        "V": ("volt", "volts"),
        "°C": ("degree", "degrees"),
        "ºC": ("degree", "degrees"),
        "°": ("degree", "degrees"),
        "km/h": ("kilometer per hour", "kilometers per hour"),
        "km": ("kilometer", "kilometers"),
        "cm": ("centimeter", "centimeters"),
        "mm": ("millimeter", "millimeters"),
        "kg": ("kilogram", "kilograms"),
        "€": ("euro", "euros"),
    },
}
_UNIT = re.compile(
    r"(?<![\w.,])(\d+(?:[.,]\d+)?) ?("
    + "|".join(re.escape(u) for u in sorted(_UNITS["es"], key=len, reverse=True))
    + r")(?![\w/])"
)
_CLOCK = re.compile(r"(?<![\w:])([01]?\d|2[0-3]):([0-5]\d)(?![\w:])")


def say_units(text: str, lang: str) -> str:
    """Spell unit symbols after numbers and HH:MM times as words, for espeak's lang ("es", "en-us").

    Numbers stay digits: espeak reads them well in both languages.
    """
    en = lang.startswith("en")
    units = _UNITS["en" if en else "es"]

    def unit(m: re.Match[str]) -> str:
        one, many = units[m[2]]
        return f"{m[1]} {one if m[1] == '1' else many}"

    def clock(m: re.Match[str]) -> str:
        h, mm = m[1], m[2]
        if mm == "00":
            return f"{h} o'clock" if en else f"{h} en punto"
        if en:
            return f"{h} {mm}" if mm[0] != "0" else f"{h} oh {mm[1]}"
        return f"{h} y {int(mm)}"

    return _CLOCK.sub(clock, _UNIT.sub(unit, text))


def clean_for_speech(text: str) -> str:
    """Remove markdown markers, emoji and URLs, and collapse whitespace."""
    text = _MD_LINK.sub(r"\1", text)
    text = _URL.sub("", text)
    text = _CODE_FENCE.sub("", text)
    text = _HEADING.sub("", text)
    text = _BULLET.sub("", text)
    text = _QUOTE.sub("", text)
    text = _MARKERS.sub("", text)
    text = _EMOJI.sub("", text)
    return _SPACE.sub(" ", text).strip()


def truncate_for_speech(text: str, max_chars: int) -> tuple[str, bool]:
    """Cut at the last sentence end before max_chars, else at the last space.

    Returns the text and whether it was cut, so the caller can log the cut.
    """
    if len(text) <= max_chars:
        return text, False
    head = text[:max_chars]
    ends = [m.end() for m in _SENTENCE_END.finditer(head)]
    if ends:
        return head[: ends[-1]].strip(), True
    space = head.rfind(" ")
    return (head[:space] if space > 0 else head).strip(), True


def ends_with_question(text: str) -> bool:
    """True when the text ends with "?", ignoring trailing quotes, brackets and whitespace."""
    return text.rstrip(_TRAILING_QUOTES).endswith("?")
