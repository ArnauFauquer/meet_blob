from typing import Any

from fastapi.testclient import TestClient

from blob.auth import User
from blob.devices import device_for
from tests.conftest import make_settings, signed_in


def test_flags_come_from_groups(tmp_path: Any) -> None:
    s = make_settings(tmp_path)
    kiosk = device_for(User("1", "tablet", ("blob-sound", "blob-wake", "family")), s)
    assert (kiosk.name, kiosk.sound, kiosk.wake) == ("tablet", True, True)
    person = device_for(User("2", "arnau", ("family",)), s)
    assert (person.sound, person.wake) == (False, False)
    custom = make_settings(tmp_path, oidc_sound_group="chimes", oidc_wake_group="hands-free")
    assert device_for(User("3", "x", ("hands-free",)), custom).wake
    assert not device_for(User("3", "x", ("blob-wake",)), custom).wake


def test_device_config(app_factory: Any) -> None:
    with TestClient(app_factory(quiet_hours="22:00-07:00")) as c:
        tablet = c.get("/device-config", headers=signed_in("tablet")).json()
        desktop = c.get("/device-config", headers=signed_in("desktop")).json()
    assert tablet == {
        "device": "tablet",
        "sound": True,
        "wake": True,
        "quiet_hours": "22:00-07:00",
        "followup_listen_s": 6.0,
        "listen_no_speech_s": 8.0,
        "silence_rms": 0.01,
        "debug_audio": False,
        "night": None,
    }
    assert (desktop["device"], desktop["sound"], desktop["wake"]) == ("desktop", False, False)


def test_device_config_night(app_factory: Any) -> None:
    with TestClient(app_factory(night_hours="23:00-07:30")) as c:
        cfg = c.get("/device-config", headers=signed_in("tablet")).json()
    assert cfg["night"] == {"start": "23:00", "end": "07:30"}
    assert cfg["quiet_hours"] == ""
