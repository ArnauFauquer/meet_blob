"""Per-browser flags from the signed-in user's Pocket ID groups, served by GET /device-config.

A kiosk (the tablet) signs in as its own Pocket ID user and is put in the sound and wake groups;
a person signing in on a desktop is in neither, so that page only answers taps and stays silent.
"""

from dataclasses import dataclass

from pydantic import BaseModel

from .auth import User
from .config import Settings


@dataclass(frozen=True)
class Device:
    name: str  # the user's name: diagnostics, logs and debug audio file names
    sound: bool
    wake: bool


def device_for(user: User, settings: Settings) -> Device:
    return Device(
        name=user.name,
        sound=settings.oidc_sound_group in user.groups,
        wake=settings.oidc_wake_group in user.groups,
    )


class DeviceConfig(BaseModel):
    device: str
    sound: bool
    wake: bool
    quiet_hours: str
    followup_listen_s: float
    listen_no_speech_s: float
    silence_rms: float
    debug_audio: bool = False  # DEBUG_AUDIO_DIR is set: the page may send wake_clip audio
