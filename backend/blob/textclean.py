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
