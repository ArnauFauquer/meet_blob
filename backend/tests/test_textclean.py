import pytest

from blob.textclean import clean_for_speech, ends_with_question, say_units, truncate_for_speech


@pytest.mark.parametrize(
    ("raw", "spoken"),
    [
        ("**Hola** _mundo_ `code`", "Hola mundo code"),
        ("# Título\n- uno\n- dos\n1. tres", "Título uno dos tres"),
        ("Mira [esto](https://example.com) ya", "Mira esto ya"),
        ("Ver https://example.com/a?b=1 y www.x.org fin", "Ver y fin"),
        ("Hola 🙂 adiós 👍🏽!", "Hola adiós !"),
        ("> cita\n\n  con   espacios\t\n", "cita con espacios"),
        ("```python\nprint(1)\n```", "print(1)"),
        ("snake_case_name stays", "snake_case_name stays"),
        ("~~tachado~~", "tachado"),
    ],
)
def test_clean(raw: str, spoken: str) -> None:
    assert clean_for_speech(raw) == spoken


def test_no_cut_under_limit() -> None:
    assert truncate_for_speech("Corto.", 100) == ("Corto.", False)


def test_cut_at_sentence_end() -> None:
    text = "Primera frase. Segunda frase! Tercera frase muy larga que no cabe"
    assert truncate_for_speech(text, 40) == ("Primera frase. Segunda frase!", True)


def test_cut_at_space_without_sentence_end() -> None:
    assert truncate_for_speech("uno dos tres cuatro cinco", 12) == ("uno dos", True)


def test_cut_hard_without_space() -> None:
    assert truncate_for_speech("a" * 30, 10) == ("a" * 10, True)


def test_decimal_point_is_not_a_sentence_end() -> None:
    assert truncate_for_speech("Vale 3.5 euros y algo más", 15) == ("Vale 3.5 euros", True)


@pytest.mark.parametrize(
    ("text", "expected"),
    [
        ("¿Apago las luces del salón?", True),
        ("Shall I?  ", True),
        ('Did he say "really?"', True),
        ("¿Seguro?»", True),
        ("¿Qué quieres? (dímelo)", False),
        ("Vale. ¿Algo más?\n", True),
        ("Hecho.", False),
        ("¿Pregunta? No, ya está.", False),
        ("", False),
    ],
)
def test_ends_with_question(text: str, expected: bool) -> None:
    assert ends_with_question(text) is expected


@pytest.mark.parametrize(
    ("text", "lang", "spoken"),
    [
        ("Consume 3680 W.", "es", "Consume 3680 vatios."),
        ("16 A a 230 V", "es", "16 amperios a 230 voltios"),
        ("Entre 20,7 y 23,8 ºC, 21°C fuera", "es", "Entre 20,7 y 23,8 grados, 21 grados fuera"),
        ("1 kWh y 1 W", "es", "1 kilovatio hora y 1 vatio"),
        ("A 50 km/h, hasta 600 €.", "es", "A 50 kilómetros por hora, hasta 600 euros."),
        ("Son las 14:30, 9:05 o 8:00.", "es", "Son las 14 y 30, 9 y 5 o 8 en punto."),
        ("It's 14:30, 9:05 or 8:00.", "en-us", "It's 14 30, 9 oh 5 or 8 o'clock."),
        ("Uses 87 W and 2 A", "en-us", "Uses 87 watts and 2 amps"),
        # Left alone: ordinals, words that start with a unit letter, ratios, IDs and long clocks.
        ("Es el 1º, 2 Avenida, 4 Wifi", "es", "Es el 1º, 2 Avenida, 4 Wifi"),
        ("3 W/m2, v1.2 V, 10:30:15, A1 W", "es", "3 W/m2, v1.2 V, 10:30:15, A1 W"),
    ],
)
def test_say_units(text: str, lang: str, spoken: str) -> None:
    assert say_units(text, lang) == spoken
