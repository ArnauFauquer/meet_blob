"""WebSocket message models. Must match protocol/messages.json (checked by tests/test_protocol.py).

S3 (wake, tts.followup in use) and S4 (alert_read, alert_ack, alerts in snapshot) add their
client messages to ClientMessage and their handlers to the hub dispatch table.
"""

from enum import StrEnum
from typing import Annotated, Literal

from pydantic import BaseModel, ConfigDict, Field, TypeAdapter


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
    rate: Literal[16000]
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


ClientMessage = Annotated[
    Hello | Tap | Utterance | Cancel | Ping | ClientEvent, Field(discriminator="type")
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
CLIENT_MESSAGES: tuple[type[BaseModel], ...] = (Hello, Tap, Utterance, Cancel, Ping, ClientEvent)
