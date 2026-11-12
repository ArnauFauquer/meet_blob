import pytest

from blob.textclean import clean_for_speech, truncate_for_speech


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
