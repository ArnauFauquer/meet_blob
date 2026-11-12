"""The Pydantic models must match protocol/messages.json: names, fields and enums."""

import json
from pathlib import Path
from typing import Any

import pytest
from pydantic import BaseModel

from blob import __version__, schemas

PROTOCOL = json.loads(
    (Path(__file__).resolve().parents[2] / "protocol" / "messages.json").read_text()
)
# Messages of later slices that are not built yet (S3: wake; S4: alerts).
NOT_BUILT = {"wake", "alert_read", "alert_ack"}


def _name(model: type[BaseModel]) -> str:
    return str(model.model_fields["type"].default)


def _fields(model: type[BaseModel]) -> set[str]:
    return set(model.model_fields) - {"type"}


def _spec_fields(spec: dict[str, Any]) -> set[str]:
    return set(spec["fields"]) - {"..."}


def test_version() -> None:
    assert str(PROTOCOL["version"]) == __version__


@pytest.mark.parametrize(
    ("models", "direction"),
    [(schemas.CLIENT_MESSAGES, "client_to_server"), (schemas.SERVER_MESSAGES, "server_to_client")],
)
def test_messages(models: tuple[type[BaseModel], ...], direction: str) -> None:
    spec = PROTOCOL[direction]
    ours = {_name(m): m for m in models}
    assert set(ours) == set(spec) - NOT_BUILT
    for name, model in ours.items():
        assert _fields(model) == _spec_fields(spec[name]), name


@pytest.mark.parametrize(
    ("enum", "key"),
    [
        (schemas.ConvState, "conv_states"),
        (schemas.Reason, "turn_done_reasons"),
        (schemas.TimeoutKind, "timeout_kinds"),
        (schemas.ErrorCode, "error_codes"),
    ],
)
def test_enums(enum: type[Any], key: str) -> None:
    assert [e.value for e in enum] == PROTOCOL[key]


def test_alert_item() -> None:
    assert set(schemas.AlertItem.model_fields) == set(PROTOCOL["alert_item"])


def test_timings_keys() -> None:
    assert set(schemas.Timings.model_fields) == {
        "stt_ms",
        "hermes_ms",
        "tts_ms",
        "first_audio_ms",
        "sc1_ms",
    }


def test_close_codes() -> None:
    from blob.hub import CLOSE_BAD_TOKEN, CLOSE_BEFORE_HELLO

    assert {str(CLOSE_BEFORE_HELLO), str(CLOSE_BAD_TOKEN)} == set(PROTOCOL["close_codes"])


def test_client_message_parsing() -> None:
    utt = schemas.client_message.validate_json(
        '{"type":"utterance","turn":3,"format":"pcm_s16le","rate":16000,'
        '"dur_ms":1200,"tail_silence_ms":300}'
    )
    assert isinstance(utt, schemas.Utterance)
    event = schemas.client_message.validate_json('{"type":"client_event","kind":"x","ms":5}')
    assert event.model_dump() == {"type": "client_event", "kind": "x", "ms": 5}


@pytest.mark.parametrize(("rate", "ok"), [("16000", True), ('"16000"', True), ("48000", False)])
def test_utterance_rate_number_or_string(rate: str, ok: bool) -> None:
    head = '{"type":"utterance","turn":1,"format":"pcm_s16le","dur_ms":0,"tail_silence_ms":0,'
    raw = f'{head}"rate":{rate}}}'
    if ok:
        assert schemas.client_message.validate_json(raw).rate == 16000  # type: ignore[union-attr]
    else:
        with pytest.raises(ValueError):
            schemas.client_message.validate_json(raw)
