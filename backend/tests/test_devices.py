import json
from pathlib import Path
from typing import Any

import pytest
from fastapi.testclient import TestClient

from blob.devices import load_devices
from tests.conftest import TOKEN

AUTH = {"Authorization": f"Bearer {TOKEN}"}
EXAMPLE = Path(__file__).resolve().parents[2] / "config" / "devices.example.json"


def test_example_file_loads() -> None:
    devices = load_devices(str(EXAMPLE))
    assert devices["tablet"].sound and devices["tablet"].wake
    assert not devices["desktop"].sound and not devices["desktop"].wake


def test_missing_file_means_no_devices(tmp_path: Path) -> None:
    assert load_devices(str(tmp_path / "none.json")) == {}


@pytest.mark.parametrize("content", ["{not json", '{"tablet": {"sound": "loud"}}', "[]"])
def test_malformed_file(tmp_path: Path, content: str) -> None:
    p = tmp_path / "devices.json"
    p.write_text(content)
    with pytest.raises(ValueError, match="malformed devices file"):
        load_devices(str(p))


def test_malformed_file_stops_startup(tmp_path: Path, app_factory: Any) -> None:
    (tmp_path / "devices.json").write_text("{")
    with pytest.raises(ValueError):
        app_factory()


def test_device_config(tmp_path: Path, app_factory: Any) -> None:
    (tmp_path / "devices.json").write_text(json.dumps({"tablet": {"sound": True, "wake": True}}))
    with TestClient(app_factory(quiet_hours="22:00-07:00")) as c:
        tablet = c.get("/device-config?device=tablet", headers=AUTH).json()
        other = c.get("/device-config?device=kitchen", headers=AUTH).json()
    assert tablet == {
        "device": "tablet",
        "sound": True,
        "wake": True,
        "quiet_hours": "22:00-07:00",
        "followup_listen_s": 6.0,
        "listen_no_speech_s": 8.0,
        "silence_rms": 0.01,
    }
    assert (other["sound"], other["wake"]) == (False, False)
