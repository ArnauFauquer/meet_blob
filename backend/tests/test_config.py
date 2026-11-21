from pathlib import Path

import pytest
from pydantic import ValidationError

from blob.config import Settings
from tests.conftest import make_settings

REQUIRED = (
    "HERMES_URL",
    "HERMES_KEY",
    "HERMES_MODEL",
    "PUBLIC_URL",
    "OIDC_ISSUER",
    "OIDC_CLIENT_ID",
    "ALERT_TOKEN",
)
URLS = ("HERMES_URL", "PUBLIC_URL", "OIDC_ISSUER")


def test_defaults(tmp_path: Path) -> None:
    s = make_settings(tmp_path)
    assert (s.hermes_connect_s, s.hermes_total_s, s.session_idle_s) == (5, 75, 300)
    assert (s.listen_watchdog_s, s.turn_watchdog_s) == (30, 120)
    assert (s.stt_model, s.stt_compute, s.kokoro_device) == ("large-v3", "int8_float16", "cpu")
    assert (s.no_speech_max, s.silence_rms, s.tts_max_chars) == (0.6, 0.01, 1200)
    assert (s.retention_days, s.host, s.port) == (14, "0.0.0.0", 8000)
    assert (s.followup_listen_s, s.listen_no_speech_s, s.quiet_hours) == (6, 8, "")
    assert (s.followup_max, s.timer_rule) == (3, True)


def test_reads_environment(monkeypatch: pytest.MonkeyPatch) -> None:
    for name, value in {
        "HERMES_URL": "http://hermes:8642/",
        "HERMES_KEY": "k",
        "HERMES_MODEL": "hermes-agent",
        "PUBLIC_URL": "https://blob.example/",
        "OIDC_ISSUER": "https://id.example/",
        "OIDC_CLIENT_ID": "blob",
        "ALERT_TOKEN": "a",
        "PORT": "9000",
        "BLOB_FAKE_MODELS": "1",
        "TIMER_RULE": "off",
        "FOLLOWUP_MAX": "5",
    }.items():
        monkeypatch.setenv(name, value)
    s = Settings(_env_file=None)  # type: ignore[call-arg]
    assert s.hermes_url == "http://hermes:8642"  # trailing slash removed
    assert s.port == 9000
    assert s.blob_fake_models is True
    assert (s.alert_token, s.timer_rule, s.followup_max) == ("a", False, 5)
    assert (s.public_url, s.oidc_issuer) == ("https://blob.example", "https://id.example")
    assert (s.oidc_client_id, s.oidc_client_secret) == ("blob", "")
    assert (s.oidc_sound_group, s.oidc_wake_group, s.session_idle_days) == (
        "blob-sound",
        "blob-wake",
        30,
    )


@pytest.mark.parametrize("missing", REQUIRED)
def test_required(monkeypatch: pytest.MonkeyPatch, missing: str) -> None:
    for name in REQUIRED:
        monkeypatch.setenv(name, "http://x" if name in URLS else "v")
    monkeypatch.delenv(missing)
    with pytest.raises(ValidationError):
        Settings(_env_file=None)  # type: ignore[call-arg]


@pytest.mark.parametrize(
    "override",
    [
        {"hermes_url": "hermes:8642"},
        {"hermes_total_s": 0},
        {"no_speech_max": 1.5},
        {"port": 0},
        {"kokoro_device": "tpu"},
        {"quiet_hours": "22-07"},
        {"night_hours": "23-07"},
        {"night_hours": "24:00-07:30"},
        {"night_hours": "23:00-23:00"},
        {"oidc_client_id": ""},
        {"public_url": "blob.test"},
        {"oidc_issuer": "id.test"},
        {"session_idle_days": 0},
        {"alert_token": ""},
        {"followup_max": -1},
        {"timer_rule": "maybe"},
    ],
)
def test_validation(tmp_path: Path, override: dict[str, object]) -> None:
    with pytest.raises(ValidationError):
        make_settings(tmp_path, **override)


def test_quiet_hours_ok(tmp_path: Path) -> None:
    assert make_settings(tmp_path, quiet_hours="22:00-07:00").quiet_hours == "22:00-07:00"


def test_tz(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.delenv("TZ", raising=False)
    assert make_settings(tmp_path).tz == "Europe/Madrid"
    monkeypatch.setenv("TZ", ":Europe/Madrid")  # glibc form, as some images set it
    assert make_settings(tmp_path).tz == "Europe/Madrid"
    monkeypatch.setenv("TZ", "America/New_York")
    assert make_settings(tmp_path).tz == "America/New_York"
    for bad in ("Mars/Olympus", "CET+1", "/etc/localtime", ""):
        monkeypatch.setenv("TZ", bad)
        with pytest.raises(ValidationError, match="TZ must be an IANA zone"):
            make_settings(tmp_path)


def test_night_hours(tmp_path: Path) -> None:
    assert make_settings(tmp_path).night is None
    s = make_settings(tmp_path, night_hours=" 23:00-07:30 ")
    assert s.night_hours == "23:00-07:30"
    assert s.night == {"start": "23:00", "end": "07:30"}
    day = make_settings(tmp_path, night_hours="13:30-15:00")
    assert day.night == {"start": "13:30", "end": "15:00"}
