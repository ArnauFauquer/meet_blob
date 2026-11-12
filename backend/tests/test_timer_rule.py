import pytest

from blob.timer_rule import TimerRequest, match, parse_seconds


@pytest.mark.parametrize(
    ("text", "seconds"),
    [
        # Spanish: digits and words, seconds, minutes, hours, halves
        ("Pon un temporizador de 10 minutos.", 600),
        ("pon un temporizador de 1 minuto", 60),
        ("Pon un temporizador de un minuto", 60),
        ("Temporizador de cinco minutos", 300),
        ("¿Puedes poner un temporizador de diez segundos?", 10),
        ("pon un temporizador de 30 seg", 30),
        ("Pon un temporizador de dos horas", 7200),
        ("pon un temporizador de media hora", 1800),
        ("Pon un temporizador de una hora y media", 5400),
        ("pon un temporizador de 1 hora y 15 minutos", 4500),
        ("pon un temporizador para 5 minutos", 300),
        ("pon un temporizador de 1,5 minutos", 90),
        ("pon un temporizador de medio minuto", 30),
        # Catalan
        ("Posa un temporitzador de cinc minuts", 300),
        ("posa un temporitzador de dues hores", 7200),
        ("posa un temporitzador de mitja hora", 1800),
        ("Posa un temporitzador de vuit segons", 8),
        ("posa un temporitzador d'un minut i mig", 90),
        ("posa un temporitzador de nou minuts", 540),
        # English
        ("Set a timer for 5 minutes.", 300),
        ("set a timer for ten seconds", 10),
        ("Set a 15 minute timer", 900),
        ("set a timer for an hour", 3600),
        ("set a timer for half an hour", 1800),
        ("Timer for two hours", 7200),
        ("set a timer for a minute and a half", 90),
        ("start a timer, 45 secs", 45),
    ],
)
def test_matches(text: str, seconds: int) -> None:
    assert parse_seconds(text) == seconds


@pytest.mark.parametrize(
    "text",
    [
        "¿Qué hora es?",
        "pon un temporizador",  # no length
        "Espera 5 minutos y llámame",  # no timer word
        "Cancela el temporizador de 10 minutos",
        "quita el temporizador de cinco minutos",
        "¿Cuánto queda del temporizador de 10 minutos?",
        "No pongas un temporizador de 5 minutos",
        "cambia el temporizador a 5 minutos",
        "Cancel the 5 minute timer",
        "stop the timer for 10 minutes",
        "how long is left on the 10 minute timer",
        "don't set a timer for 5 minutes",
        "Atura el temporitzador de cinc minuts",
        "esborra el temporitzador de 3 minuts",
        "pon un temporizador de 0 minutos",
        "los temporizadores de la cocina son de muchos tipos",
        "un timer de mucho tiempo",
        "the timers are broken",
    ],
)
def test_does_not_match(text: str) -> None:
    assert parse_seconds(text) is None
    assert match(text, "es", 0) is None


def test_spanish_request() -> None:
    assert match("Pon un temporizador de 10 minutos", "es", 1_700_000_000.7) == TimerRequest(
        key="timer-1700000000",
        in_s=600,
        text="El temporizador de 10 minutos ha terminado.",
        lang="es",
        reply="Vale, temporizador de 10 minutos.",
    )


def test_catalan_gets_spanish_words() -> None:
    req = match("posa un temporitzador d'una hora", "ca", 5)
    assert req is not None
    assert (req.lang, req.reply, req.in_s) == ("es", "Vale, temporizador de 1 hora.", 3600)


def test_english_request() -> None:
    req = match("set a timer for 90 seconds", "en", 7)
    assert req == TimerRequest(
        "timer-7", 90, "Your 90 second timer is done.", "en", "Okay, 90 second timer."
    )


@pytest.mark.parametrize(
    ("text", "reply"),
    [
        ("pon un temporizador de 1 minuto", "Vale, temporizador de 1 minuto."),
        ("pon un temporizador de 1 segundo", "Vale, temporizador de 1 segundo."),
        ("pon un temporizador de 2 horas", "Vale, temporizador de 2 horas."),
        ("pon un temporizador de 90 segundos", "Vale, temporizador de 90 segundos."),
        ("pon un temporizador de una hora y media", "Vale, temporizador de 90 minutos."),
    ],
)
def test_spanish_units(text: str, reply: str) -> None:
    req = match(text, None, 0)  # unknown language: Spanish, like voice_for
    assert req is not None and req.reply == reply


def test_same_timer_twice_gets_two_keys() -> None:
    a = match("pon un temporizador de 10 minutos", "es", 100)
    b = match("pon un temporizador de 10 minutos", "es", 160)
    assert a is not None and b is not None and a.key != b.key
