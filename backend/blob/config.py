"""Settings read from the environment (and an optional .env file) and validated at startup."""

import re
from typing import Literal, Self
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

from pydantic import Field, field_validator, model_validator
from pydantic_settings import BaseSettings, SettingsConfigDict

_HOURS = r"([01]\d|2[0-3]):[0-5]\d-([01]\d|2[0-3]):[0-5]\d"


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_file=".env", extra="ignore")

    # S1: Hermes
    hermes_url: str
    hermes_key: str
    hermes_model: str
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

    # Sign-in: browsers sign in with OpenID Connect (Pocket ID). PUBLIC_URL is the address the
    # browser uses; the redirect URI registered at the provider is PUBLIC_URL/auth/callback.
    # Required unless AUTH_DISABLED is on.
    public_url: str = ""
    oidc_issuer: str = ""
    oidc_client_id: str = ""
    oidc_client_secret: str = ""  # empty: public client (PKCE only)
    # Local development only: no sign-in, every browser and script is the user "dev", in the sound
    # and wake groups. Never on a reachable deployment: anyone on the network gets in.
    auth_disabled: bool = False
    # Group names in the ID token's "groups" claim that turn a signed-in browser's flags on.
    oidc_sound_group: str = "blob-sound"
    oidc_wake_group: str = "blob-wake"
    # A session ends after this many days without use (each page load or connection renews it).
    session_idle_days: int = Field(30, ge=1)
    # Machine sources (Hermes, Home Assistant) send this to /alerts as Authorization: Bearer.
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
    # Recurring alerts: the IANA zone their "HH:MM" is in. Read from TZ, which the chart already
    # sets for the container; glibc's ":Europe/Madrid" form is accepted.
    tz: str = "Europe/Madrid"

    # Night mode: HH:MM-HH:MM in the browser's local time, may cross midnight. Served to the page
    # as night {start, end} (null when empty). The page dims, slows down and holds info alerts.
    night_hours: str = ""

    # Idle screen weather (Open-Meteo, no key). Off unless both are set.
    weather_lat: float | None = Field(None, ge=-90, le=90)
    weather_lon: float | None = Field(None, ge=-180, le=180)
    weather_refresh_s: float = Field(1200, ge=60)

    # Presence wake: once the room's sensor says nobody is there (POST /presence), the idle blob
    # rests as the clock and the screen goes dark this many seconds after the last activity.
    presence_sleep_s: float = Field(600, ge=10)

    # Debug switch: keep the last DEBUG_AUDIO_KEEP utterances as WAV files in this folder (off when
    # empty). Personal voice recordings: turn it off and delete the folder after debugging.
    debug_audio_dir: str = ""
    debug_audio_keep: int = Field(20, ge=1, le=500)
    # Wake word clips (wake_clip) go to <DEBUG_AUDIO_DIR>/wake/<label>/, this many per label.
    debug_wake_keep: int = Field(500, ge=1, le=5000)

    # Development switch: canned transcript and tone audio instead of the speech models.
    blob_fake_models: bool = False
    blob_fake_transcript: str = "¿Qué hora es?"
    blob_fake_lang: str = "es"

    @field_validator("hermes_url", "hermes_alerts_url")
    @classmethod
    def _hermes_url(cls, v: str) -> str:
        if not v.startswith(("http://", "https://")):
            raise ValueError("HERMES_URL and HERMES_ALERTS_URL must start with http:// or https://")
        return v.rstrip("/")

    @field_validator("public_url", "oidc_issuer")
    @classmethod
    def _url(cls, v: str) -> str:
        if v and not v.startswith(("http://", "https://")):
            raise ValueError("PUBLIC_URL and OIDC_ISSUER must start with http:// or https://")
        return v.rstrip("/")

    @model_validator(mode="after")
    def _sign_in(self) -> Self:
        if not self.auth_disabled:
            missing = [
                name.upper()
                for name in ("public_url", "oidc_issuer", "oidc_client_id")
                if not getattr(self, name)
            ]
            if missing:
                raise ValueError(
                    f"{', '.join(missing)} required (or AUTH_DISABLED=1 for local dev)"
                )
        return self

    @field_validator("tz")
    @classmethod
    def _tz(cls, v: str) -> str:
        v = v.removeprefix(":")
        try:
            ZoneInfo(v)
        except (ZoneInfoNotFoundError, ValueError):
            raise ValueError("TZ must be an IANA zone name such as Europe/Madrid") from None
        return v

    @field_validator("quiet_hours")
    @classmethod
    def _quiet_hours(cls, v: str) -> str:
        if v and not re.fullmatch(_HOURS, v):
            raise ValueError("QUIET_HOURS must look like 22:00-07:00")
        return v

    @field_validator("night_hours")
    @classmethod
    def _night_hours(cls, v: str) -> str:
        v = v.strip()
        if v and not re.fullmatch(_HOURS, v):
            raise ValueError("NIGHT_HOURS must look like 23:00-07:30")
        if v and v[:5] == v[6:]:
            raise ValueError("NIGHT_HOURS must not start and end at the same time")
        return v

    @property
    def night(self) -> dict[str, str] | None:
        """The night window for /device-config, or None when night mode is off."""
        if not self.night_hours:
            return None
        start, end = self.night_hours.split("-")
        return {"start": start, "end": end}
