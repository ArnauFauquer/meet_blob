"""Settings read from the environment (and an optional .env file) and validated at startup."""

import re
from typing import Literal

from pydantic import Field, field_validator
from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_file=".env", extra="ignore")

    # S1: Hermes
    hermes_url: str
    hermes_key: str
    hermes_model: str
    # Only "session" is built: the S0 Hermes test showed X-Hermes-Session-Id keeps a session.
    hermes_history_mode: Literal["session"] = "session"
    hermes_connect_s: float = Field(5, gt=0)
    hermes_total_s: float = Field(75, gt=0)
    session_idle_s: float = Field(300, gt=0)
    # S4: Blob's /alerts as Hermes reaches it; goes into the skill Blob sends with every request.
    hermes_alerts_url: str = "http://blob.blob.svc.cluster.local:80"

    # S1: turn watchdogs
    listen_watchdog_s: float = Field(30, gt=0)
    turn_watchdog_s: float = Field(120, gt=0)

    # S1: models
    stt_model: str = "large-v3"
    stt_compute: str = "int8_float16"
    no_speech_max: float = Field(0.6, ge=0, le=1)
    silence_rms: float = Field(0.01, ge=0, le=1)
    kokoro_device: Literal["cpu", "cuda"] = "cpu"
    tts_max_chars: int = Field(1200, ge=50)
    model_dir: str = "/data/models"

    # S1: storage and server
    retention_days: int = Field(14, ge=1)
    host: str = "0.0.0.0"
    port: int = Field(8000, ge=1, le=65535)
    db_path: str = "/data/blob.db"
    static_dir: str = "web/dist"

    # S2: devices and tokens
    devices_path: str = "config/devices.json"
    device_token: str = Field(min_length=1)
    alert_token: str = Field(min_length=1)

    # S3: follow-up chain guard (server); the listening limits are served to the page.
    followup_max: int = Field(3, ge=0)
    followup_listen_s: float = Field(6, gt=0)
    listen_no_speech_s: float = Field(8, gt=0)
    # S4: read by the page from GET /device-config.
    quiet_hours: str = ""
    # S4: the local timer rule before Hermes (on/off). Turn it off once Hermes creates timers
    # itself through POST /alerts.
    timer_rule: bool = True

    # Debug switch: keep the last DEBUG_AUDIO_KEEP utterances as WAV files in this folder (off when
    # empty). Personal voice recordings: turn it off and delete the folder after debugging.
    debug_audio_dir: str = ""
    debug_audio_keep: int = Field(20, ge=1, le=500)

    # Development switch: canned transcript and tone audio instead of the speech models.
    blob_fake_models: bool = False
    blob_fake_transcript: str = "¿Qué hora es?"
    blob_fake_lang: str = "es"

    @field_validator("hermes_url", "hermes_alerts_url")
    @classmethod
    def _strip_slash(cls, v: str) -> str:
        if not v.startswith(("http://", "https://")):
            raise ValueError("HERMES_URL and HERMES_ALERTS_URL must start with http:// or https://")
        return v.rstrip("/")

    @field_validator("quiet_hours")
    @classmethod
    def _quiet_hours(cls, v: str) -> str:
        if v and not re.fullmatch(r"([01]\d|2[0-3]):[0-5]\d-([01]\d|2[0-3]):[0-5]\d", v):
            raise ValueError("QUIET_HOURS must look like 22:00-07:00")
        return v
