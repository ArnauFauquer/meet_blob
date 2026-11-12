import pytest

from blob import voices
from blob.voices import ENGLISH, FALLBACK_LINES, SPANISH, fallback_lang, voice_for


@pytest.mark.parametrize(
    ("lang", "voice"),
    [
        ("es", SPANISH),
        ("ca", SPANISH),
        ("en", ENGLISH),
        ("fr", SPANISH),
        ("", SPANISH),
        (None, SPANISH),
    ],
)
def test_voice_for(lang: str | None, voice: voices.Voice) -> None:
    assert voice_for(lang) is voice


def test_voice_names() -> None:
    # Confirmed against kokoro-onnx 0.6.1 voices-v1.0.bin (see docs/notes/backend.md).
    assert SPANISH == ("ef_dora", "es")
    assert ENGLISH == ("af_heart", "en-us")


def test_override(monkeypatch: pytest.MonkeyPatch) -> None:
    catalan = voices.Voice("cf_test", "ca")
    monkeypatch.setitem(voices.VOICES, "ca", catalan)
    assert voice_for("ca") is catalan


@pytest.mark.parametrize(("lang", "line"), [("en", "en"), ("es", "es"), ("ca", "es"), (None, "es")])
def test_fallback_lang(lang: str | None, line: str) -> None:
    assert fallback_lang(lang) == line
    assert FALLBACK_LINES[line]
