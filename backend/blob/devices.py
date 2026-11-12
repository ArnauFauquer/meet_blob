"""Per-device flags from DEVICES_PATH, served by GET /device-config."""

import json
import logging
from pathlib import Path

from pydantic import BaseModel, TypeAdapter

log = logging.getLogger(__name__)


class Device(BaseModel):
    sound: bool = False
    wake: bool = False


class DeviceConfig(BaseModel):
    device: str
    sound: bool
    wake: bool
    quiet_hours: str
    followup_listen_s: float
    listen_no_speech_s: float
    silence_rms: float


_devices = TypeAdapter(dict[str, Device])


def load_devices(path: str) -> dict[str, Device]:
    """A missing file means no device has sound or wake; a malformed file stops startup."""
    p = Path(path)
    if not p.exists():
        log.warning("devices file %s not found; every device gets sound=false, wake=false", path)
        return {}
    try:
        return _devices.validate_python(json.loads(p.read_text()))
    except ValueError as e:
        raise ValueError(f"malformed devices file {path}: {e}") from e
