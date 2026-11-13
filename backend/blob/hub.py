"""WebSocket hub: connections, hello, the message dispatch table and broadcasts."""

import asyncio
import logging
from collections.abc import Awaitable, Callable
from typing import Any

from fastapi import WebSocket
from pydantic import BaseModel, ValidationError

from . import __version__, turnlog
from .alerts import Alerts
from .auth import token_ok
from .debugaudio import AudioDump
from .devices import Device
from .schemas import (
    AlertAck,
    AlertRead,
    Cancel,
    ClientEvent,
    Error,
    ErrorCode,
    Hello,
    HelloOk,
    Pong,
    Snapshot,
    State,
    Tts,
    Utterance,
    Wake,
    client_message,
)
from .turn import TurnManager

log = logging.getLogger(__name__)

MAX_FRAME = 1 << 20  # 15 s of 16 kHz 16-bit audio is about 480 KB
CLOSE_BEFORE_HELLO = 4400
CLOSE_BAD_TOKEN = 4401


class Connection:
    def __init__(self, ws: WebSocket, device: str) -> None:
        self.ws = ws
        self.device = device
        self._lock = asyncio.Lock()
        self.pending: Utterance | None = None  # utterance header waiting for its binary frame

    async def send(self, msg: BaseModel, binary: bytes | None = None) -> None:
        """Write a header and its binary frame together; a closed socket is ignored."""
        async with self._lock:
            try:
                await self.ws.send_text(msg.model_dump_json())
                if binary is not None:
                    await self.ws.send_bytes(binary)
            except Exception as e:  # the socket closed under us; the receive loop cleans up
                log.debug("send to %s failed: %r", self.device, e)


Handler = Callable[[Connection, Any], Awaitable[None]]


class Hub:
    def __init__(
        self,
        device_token: str,
        is_ready: Callable[[], bool],
        devices: dict[str, Device] | None = None,
    ) -> None:
        self._token = device_token
        self._is_ready = is_ready
        self._devices = devices or {}
        self.clients: set[Connection] = set()
        self._broadcast_lock = asyncio.Lock()
        self.turns: TurnManager  # set by main once the turn manager exists
        self.alerts: Alerts  # set by main once the alert store exists
        self.audio_dump: AudioDump | None = None  # DEBUG_AUDIO_DIR: keep utterances as WAV
        self._handlers: dict[str, Handler] = {
            "tap": self._tap,
            "utterance": self._utterance,
            "cancel": self._cancel,
            "ping": self._ping,
            "client_event": self._client_event,
            "wake": self._wake,
            "alert_read": self._alert_read,
            "alert_ack": self._alert_ack,
        }

    async def broadcast(self) -> None:
        """Send state and snapshot to every client.

        The state is read inside the lock, so the last broadcast always carries the latest state.
        """
        async with self._broadcast_lock:
            state = State(conv=self.turns.conv, turn=self.turns.turn_id)
            snap = self._snapshot()
            for c in list(self.clients):
                await c.send(state)
                await c.send(snap)

    async def broadcast_snapshot(self) -> None:
        """Alert changes: a snapshot to every client (state is only for turn transitions)."""
        async with self._broadcast_lock:
            snap = self._snapshot()
            for c in list(self.clients):
                await c.send(snap)

    def _snapshot(self) -> Snapshot:
        return Snapshot(conv=self.turns.conv, alerts=self.alerts.items())

    async def serve(self, ws: WebSocket) -> None:
        await ws.accept()
        conn = await self._hello(ws)
        if conn is None:
            return
        self.clients.add(conn)
        try:
            await conn.send(self._snapshot())
            while True:
                msg = await ws.receive()
                if msg["type"] == "websocket.disconnect":
                    break
                if msg.get("bytes") is not None:
                    await self._binary(conn, msg["bytes"])
                elif msg.get("text") is not None:
                    await self._text(conn, msg["text"])
        finally:
            self.clients.discard(conn)
            await self.turns.drop_owner(conn)

    async def _hello(self, ws: WebSocket) -> Connection | None:
        msg = await ws.receive()
        if msg["type"] == "websocket.disconnect":
            return None
        try:
            hello = Hello.model_validate_json(msg.get("text") or "")
        except ValidationError:
            await ws.close(CLOSE_BEFORE_HELLO)
            return None
        if not token_ok(hello.token, self._token):
            await ws.close(CLOSE_BAD_TOKEN)
            return None
        conn = Connection(ws, hello.device)
        await conn.send(HelloOk(version=__version__, ok=hello.version == __version__))
        return conn

    async def _text(self, conn: Connection, text: str) -> None:
        if conn.pending is not None:  # the binary frame we waited for never came
            conn.pending = None
            await conn.send(Error(code=ErrorCode.BAD_MESSAGE))
        try:
            msg = client_message.validate_json(text)
        except ValidationError:
            await conn.send(Error(code=ErrorCode.BAD_MESSAGE))
            return
        handler = self._handlers.get(msg.type)
        if handler is None:
            await conn.send(Error(code=ErrorCode.BAD_MESSAGE))
            return
        await handler(conn, msg)

    async def _binary(self, conn: Connection, data: bytes) -> None:
        utt, conn.pending = conn.pending, None
        if utt is None:
            return  # audio is dropped unless a turn is waiting for it
        if len(data) > MAX_FRAME:
            await conn.send(Error(code=ErrorCode.BAD_MESSAGE))
            await self.turns.cancel(conn, utt.turn)
            return
        if self.audio_dump is not None and self.turns.accepts_utterance(conn, utt.turn):
            self.audio_dump.save(conn.device, utt.turn, data)
        if not await self.turns.submit(conn, utt.turn, data, utt.tail_silence_ms):
            await conn.send(Error(code=ErrorCode.BAD_MESSAGE))

    async def _tap(self, conn: Connection, _msg: object) -> None:
        if not self._is_ready():
            await conn.send(Error(code=ErrorCode.NOT_READY))
        elif await self.turns.start(conn) is None:
            await conn.send(Error(code=ErrorCode.BUSY))

    async def _wake(self, conn: Connection, msg: Wake) -> None:
        """Starts a turn like a tap, only from a device marked wake=true in devices.json."""
        if not self._devices.get(conn.device, Device()).wake:
            await conn.send(Error(code=ErrorCode.BAD_MESSAGE))
        else:
            await self._tap(conn, msg)

    async def _alert_read(self, conn: Connection, msg: AlertRead) -> None:
        if not self._is_ready():
            await conn.send(Error(code=ErrorCode.NOT_READY))
            return
        alert = self.alerts.active(msg.key)
        if alert is None or self.turns.current is not None:
            await conn.send(Error(code=ErrorCode.BAD_MESSAGE))
            return
        try:
            wav = await self.turns.synth(alert.text, alert.lang)
        except Exception:
            # The page keeps the alert and plays its beep.
            log.exception("synthesis failed for alert %s", msg.key)
            await conn.send(Error(code=ErrorCode.BAD_MESSAGE))
            return
        await conn.send(Tts(turn=None, alert=msg.key, seq=0, final=True), wav)

    async def _alert_ack(self, conn: Connection, msg: AlertAck) -> None:
        await self.alerts.ack(msg.key)

    async def _utterance(self, conn: Connection, msg: Utterance) -> None:
        if not self.turns.accepts_utterance(conn, msg.turn):
            await conn.send(Error(code=ErrorCode.BAD_MESSAGE))
        elif msg.dur_ms == 0:
            await self.turns.submit(conn, msg.turn, b"", msg.tail_silence_ms)
        else:
            conn.pending = msg

    async def _cancel(self, conn: Connection, msg: Cancel) -> None:
        await self.turns.cancel(conn, msg.turn)

    async def _ping(self, conn: Connection, _msg: object) -> None:
        await conn.send(Pong())

    async def _client_event(self, conn: Connection, msg: ClientEvent) -> None:
        turnlog.client_event(conn.device, msg.model_dump())
