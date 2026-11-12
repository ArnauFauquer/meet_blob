from pathlib import Path

import pytest
from pydantic import ValidationError

from blob.config import Settings
from tests.conftest import make_settings

REQUIRED = ("HERMES_URL", "HERMES_KEY", "HERMES_MODEL", "DEVICE_TOKEN")


def test_defaults(tmp_path: Path) -> None:
    s = make_settings(tmp_path)
    assert (s.hermes_connect_s, s.hermes_total_s, s.session_idle_s) == (5, 75, 300)
    assert (s.listen_watchdog_s, s.turn_watchdog_s) == (30, 120)
    assert (s.stt_model, s.stt_compute, s.kokoro_device) == ("large-v3", "int8_float16", "cpu")
    assert (s.no_speech_max, s.silence_rms, s.tts_max_chars) == (0.6, 0.01, 1200)
    assert (s.retention_days, s.host, s.port) == (14, "0.0.0.0", 8000)
    assert s.hermes_history_mode == "session"
    assert (s.followup_listen_s, s.listen_no_speech_s, s.quiet_hours) == (6, 8, "")


def test_reads_environment(monkeypatch: pytest.MonkeyPatch) -> None:
    for name, value in {
        "HERMES_URL": "http://hermes:8642/",
        "HERMES_KEY": "k",
        "HERMES_MODEL": "hermes-agent",
        "DEVICE_TOKEN": "t",
        "PORT": "9000",
        "BLOB_FAKE_MODELS": "1",
    }.items():
        monkeypatch.setenv(name, value)
    s = Settings(_env_file=None)  # type: ignore[call-arg]
    assert s.hermes_url == "http://hermes:8642"  # trailing slash removed
    assert s.port == 9000
    assert s.blob_fake_models is True


@pytest.mark.parametrize("missing", REQUIRED)
def test_required(monkeypatch: pytest.MonkeyPatch, missing: str) -> None:
    for name in REQUIRED:
        monkeypatch.setenv(name, "http://x" if name == "HERMES_URL" else "v")
    monkeypatch.delenv(missing)
    with pytest.raises(ValidationError):
        Settings(_env_file=None)  # type: ignore[call-arg]


@pytest.mark.parametrize(
    "override",
    [
        {"hermes_url": "hermes:8642"},
        {"hermes_history_mode": "replay"},
        {"hermes_total_s": 0},
        {"no_speech_max": 1.5},
        {"port": 0},
        {"kokoro_device": "tpu"},
        {"quiet_hours": "22-07"},
        {"device_token": ""},
    ],
)
def test_validation(tmp_path: Path, override: dict[str, object]) -> None:
    with pytest.raises(ValidationError):
        make_settings(tmp_path, **override)


def test_quiet_hours_ok(tmp_path: Path) -> None:
    assert make_settings(tmp_path, quiet_hours="22:00-07:00").quiet_hours == "22:00-07:00"
