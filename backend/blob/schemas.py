"""WebSocket message models. Must match protocol/messages.json (checked by tests/test_protocol.py).

Also the POST /alerts payload and its validation rules (S4).
"""

from datetime import datetime
from enum import StrEnum
from typing import Annotated, Literal, Self

from pydantic import (
    BaseModel,
    BeforeValidator,
    ConfigDict,
    Field,
    StrictFloat,
    StrictInt,
    TypeAdapter,
    field_validator,
    model_validator,
)


class ConvState(StrEnum):
    IDLE = "idle"
    LISTENING = "listening"
    THINKING = "thinking"
    SPEAKING = "speaking"


class Reason(StrEnum):
    OK = "ok"
    EMPTY = "empty"
    STT_FAIL = "stt_fail"
    HERMES_FAIL = "hermes_fail"
    TIMEOUT = "timeout"
    TTS_FAIL = "tts_fail"
    CANCEL = "cancel"


class TimeoutKind(StrEnum):
    HERMES = "hermes"
    TURN = "turn"
    LISTEN = "listen"


class ErrorCode(StrEnum):
    BUSY = "busy"
    BAD_MESSAGE = "bad_message"
    NOT_READY = "not_ready"


# Client to server


class Hello(BaseModel):
    type: Literal["hello"] = "hello"
    version: str
    token: str
    device: str


class Tap(BaseModel):
    type: Literal["tap"] = "tap"


class Utterance(BaseModel):
    type: Literal["utterance"] = "utterance"
    turn: int
    format: Literal["pcm_s16le"]
    # messages.json writes the value as "16000"; accept the string form too.
    rate: Annotated[Literal[16000], BeforeValidator(lambda v: 16000 if v == "16000" else v)]
    dur_ms: int = Field(ge=0)
    tail_silence_ms: int = Field(ge=0)


class Cancel(BaseModel):
    type: Literal["cancel"] = "cancel"
    turn: int


class Ping(BaseModel):
    type: Literal["ping"] = "ping"


class ClientEvent(BaseModel):
    model_config = ConfigDict(extra="allow")
    type: Literal["client_event"] = "client_event"
    kind: str


class Wake(BaseModel):
    type: Literal["wake"] = "wake"
    followup: bool = False


class AlertRead(BaseModel):
    type: Literal["alert_read"] = "alert_read"
    key: str


class AlertAck(BaseModel):
    type: Literal["alert_ack"] = "alert_ack"
    key: str


ClientMessage = Annotated[
    Hello | Tap | Utterance | Cancel | Ping | ClientEvent | Wake | AlertRead | AlertAck,
    Field(discriminator="type"),
]
client_message: TypeAdapter[ClientMessage] = TypeAdapter(ClientMessage)


# Server to client


class AlertItem(BaseModel):
    key: str
    source: str
    urgency: Literal["info", "urgent"]
    text: str
    lang: str
    late: bool
    activated_at: int


class HelloOk(BaseModel):
    type: Literal["hello_ok"] = "hello_ok"
    version: str
    ok: bool


class Snapshot(BaseModel):
    type: Literal["snapshot"] = "snapshot"
    conv: ConvState
    alerts: list[AlertItem] = []


class State(BaseModel):
    type: Literal["state"] = "state"
    conv: ConvState
    turn: int | None


class Tts(BaseModel):
    type: Literal["tts"] = "tts"
    turn: int | None
    alert: str | None = None
    seq: int
    final: bool
    followup: bool = False


class Timings(BaseModel):
    stt_ms: int | None = None
    hermes_ms: int | None = None
    tts_ms: int | None = None
    first_audio_ms: int | None = None
    sc1_ms: int | None = None


class TurnDone(BaseModel):
    type: Literal["turn_done"] = "turn_done"
    turn: int
    reason: Reason
    timeout_kind: TimeoutKind | None
    timings: Timings


class Error(BaseModel):
    type: Literal["error"] = "error"
    code: ErrorCode


class Pong(BaseModel):
    type: Literal["pong"] = "pong"


SERVER_MESSAGES: tuple[type[BaseModel], ...] = (
    HelloOk,
    Snapshot,
    State,
    Tts,
    TurnDone,
    Error,
    Pong,
)
CLIENT_MESSAGES: tuple[type[BaseModel], ...] = (
    Hello,
    Tap,
    Utterance,
    Cancel,
    Ping,
    ClientEvent,
    Wake,
    AlertRead,
    AlertAck,
)


# HTTP: the alerts API (S4)

AlertKey = Annotated[str, Field(pattern=r"^[A-Za-z0-9._-]{1,64}$")]
MAX_EPOCH = 10**11  # bounds keep NaN, infinity and huge numbers out of SQLite (422 instead)
MAX_SPAN_S = 10**9


class AlertIn(BaseModel):
    """POST /alerts body. Unknown fields are refused (422) so a typo cannot fire an alert now."""

    model_config = ConfigDict(extra="forbid")
    key: AlertKey
    source: str = Field(min_length=1, max_length=64)
    text: str = Field(min_length=1, max_length=300)
    urgency: Literal["info", "urgent"] | None = None  # None: urgent for source=timer, else info
    lang: str = Field(default="es", min_length=1, max_length=16)
    # Epoch seconds or RFC3339 with an offset. Strict numbers: a bool is not an epoch.
    fire_at: StrictInt | StrictFloat | str | None = None
    in_s: StrictInt | StrictFloat | None = Field(default=None, ge=-MAX_SPAN_S, le=MAX_SPAN_S)
    ttl_s: int | None = Field(default=None, gt=0, le=MAX_SPAN_S)

    @field_validator("fire_at")
    @classmethod
    def _epoch(cls, v: int | float | str | None) -> int | float | None:
        if v is None:
            return v
        if isinstance(v, str):
            try:
                dt = datetime.fromisoformat(v)
            except ValueError as e:
                raise ValueError("fire_at must be epoch seconds or RFC3339") from e
            if dt.tzinfo is None:
                raise ValueError("fire_at needs a UTC offset")
            v = dt.timestamp()
        if not 0 <= v <= MAX_EPOCH:  # also false for NaN
            raise ValueError("fire_at out of range")
        return v

    @model_validator(mode="after")
    def _one_time(self) -> Self:
        if self.fire_at is not None and self.in_s is not None:
            raise ValueError("give fire_at or in_s, not both")
        return self


class AlertOut(BaseModel):
    key: str
    state: Literal["pending", "active", "acked"]
    fire_at: int | None
