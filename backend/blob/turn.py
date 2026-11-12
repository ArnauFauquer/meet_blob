"""Turn manager: the one turn lock, the conversation state and the turn pipeline."""

import asyncio
import itertools
import logging
import time
from collections.abc import Awaitable, Callable
from dataclasses import dataclass, field
from typing import Protocol

import numpy as np
from numpy.typing import NDArray
from pydantic import BaseModel

from .audio import pcm_to_float
from .db import Db
from .gpu import Gpu
from .hermes import HermesTimeout
from .schemas import ConvState, Reason, TimeoutKind, Timings, Tts, TurnDone
from .stt import SttResult, is_empty
from .textclean import clean_for_speech, truncate_for_speech
from .turnlog import emit, record_turn

log = logging.getLogger(__name__)


class Owner(Protocol):
    """The connection that started a turn. send() never raises."""

    async def send(self, msg: BaseModel, binary: bytes | None = None) -> None: ...


class Asker(Protocol):
    async def ask(self, user_text: str) -> str: ...


SttFn = Callable[[NDArray[np.float32]], SttResult]
TtsFn = Callable[[str, str | None], bytes]
FallbackFn = Callable[[str | None], bytes]


@dataclass(eq=False)
class Turn:
    id: int
    owner: Owner
    ts: int
    conv: ConvState = ConvState.LISTENING
    utt_at: float | None = None
    tail_silence_ms: int = 0
    lang: str | None = None
    user_text: str = ""
    reply_text: str = ""
    done: bool = False
    timings: Timings = field(default_factory=Timings)
    task: asyncio.Task[None] | None = None
    watchdog: asyncio.Task[None] | None = None


def _ms(seconds: float) -> int:
    return round(seconds * 1000)


class TurnManager:
    def __init__(
        self,
        *,
        stt: SttFn,
        tts: TtsFn,
        fallback: FallbackFn,
        hermes: Asker,
        gpu: Gpu,
        db: Db,
        on_change: Callable[[], Awaitable[None]],
        no_speech_max: float,
        tts_max_chars: int,
        listen_watchdog_s: float,
        turn_watchdog_s: float,
        clock: Callable[[], float] = time.monotonic,
        wall: Callable[[], float] = time.time,
        sleep: Callable[[float], Awaitable[None]] = asyncio.sleep,
    ) -> None:
        self._stt, self._tts, self._fallback = stt, tts, fallback
        self._hermes, self._gpu, self._db = hermes, gpu, db
        self._on_change = on_change
        self._no_speech_max, self._max_chars = no_speech_max, tts_max_chars
        self._listen_s, self._turn_s = listen_watchdog_s, turn_watchdog_s
        self._clock, self._wall, self._sleep = clock, wall, sleep
        self._ids = itertools.count(1)
        self.current: Turn | None = None

    @property
    def conv(self) -> ConvState:
        return self.current.conv if self.current else ConvState.IDLE

    @property
    def turn_id(self) -> int | None:
        return self.current.id if self.current else None

    async def start(self, owner: Owner) -> Turn | None:
        """Take the turn lock and enter listening. None means busy."""
        if self.current is not None:
            return None
        turn = Turn(id=next(self._ids), owner=owner, ts=int(self._wall()))
        self.current = turn
        await self._on_change()
        if not turn.done:
            turn.watchdog = asyncio.create_task(self._listen_watchdog(turn))
        return turn

    def accepts_utterance(self, owner: Owner, turn_id: int) -> bool:
        t = self.current
        return (
            t is not None
            and t.id == turn_id
            and t.owner is owner
            and t.conv is ConvState.LISTENING
            and not t.done
        )

    async def submit(self, owner: Owner, turn_id: int, pcm: bytes, tail_silence_ms: int) -> bool:
        """Start the pipeline for the open turn. False if the turn is no longer listening."""
        if not self.accepts_utterance(owner, turn_id):
            return False
        t = self.current
        assert t is not None
        t.utt_at = self._clock()
        t.tail_silence_ms = tail_silence_ms
        if t.watchdog is not None:
            t.watchdog.cancel()
        t.conv = ConvState.THINKING
        # Broadcast before the pipeline runs, so "thinking" cannot arrive after the turn ends.
        await self._on_change()
        if not t.done:
            t.task = asyncio.create_task(self._pipeline(t, pcm))
            t.watchdog = asyncio.create_task(self._turn_watchdog(t))
        return True

    async def cancel(self, owner: Owner, turn_id: int) -> None:
        """A cancel for a turn that already ended is ignored (a normal race)."""
        t = self.current
        if t is not None and t.id == turn_id and t.owner is owner:
            await self._finish(t, Reason.CANCEL)

    async def drop_owner(self, owner: Owner) -> None:
        """The owner's WebSocket closed: release the lock and cancel the pipeline."""
        t = self.current
        if t is not None and t.owner is owner:
            await self._finish(t, Reason.CANCEL)

    async def _listen_watchdog(self, t: Turn) -> None:
        await self._sleep(self._listen_s)
        await self._finish(t, Reason.TIMEOUT, TimeoutKind.LISTEN)

    async def _turn_watchdog(self, t: Turn) -> None:
        await self._sleep(self._turn_s)
        await self._finish(t, Reason.TIMEOUT, TimeoutKind.TURN, self._fallback(t.lang))

    async def _pipeline(self, t: Turn, pcm: bytes) -> None:
        if not pcm:
            return await self._finish(t, Reason.EMPTY)

        start = self._clock()
        try:
            result = await self._gpu.run(self._stt, pcm_to_float(pcm))
        except Exception:
            log.exception("speech to text failed (turn %s)", t.id)
            t.timings.stt_ms = _ms(self._clock() - start)
            return await self._finish(t, Reason.STT_FAIL, audio=self._fallback(None))
        t.timings.stt_ms = _ms(self._clock() - start)
        t.lang, t.user_text = result.lang, result.text
        if is_empty(result, self._no_speech_max):
            return await self._finish(t, Reason.EMPTY)

        start = self._clock()
        try:
            reply = await self._hermes.ask(result.text)
        except HermesTimeout:
            t.timings.hermes_ms = _ms(self._clock() - start)
            return await self._finish(t, Reason.TIMEOUT, TimeoutKind.HERMES, self._fallback(t.lang))
        except Exception as e:
            log.warning("hermes failed (turn %s): %r", t.id, e)
            t.timings.hermes_ms = _ms(self._clock() - start)
            return await self._finish(t, Reason.HERMES_FAIL, audio=self._fallback(t.lang))
        t.timings.hermes_ms = _ms(self._clock() - start)

        cleaned = clean_for_speech(reply)
        t.reply_text, cut = truncate_for_speech(cleaned, self._max_chars)
        if cut:
            emit(
                {"kind": "tts_cut", "turn": t.id, "chars": len(cleaned), "kept": len(t.reply_text)}
            )

        start = self._clock()
        try:
            wav = await self._gpu.run(self._tts, t.reply_text, t.lang)
        except Exception:
            log.exception("synthesis failed (turn %s)", t.id)
            t.timings.tts_ms = _ms(self._clock() - start)
            return await self._finish(t, Reason.TTS_FAIL)
        t.timings.tts_ms = _ms(self._clock() - start)
        await self._finish(t, Reason.OK, audio=wav)

    async def _finish(
        self,
        t: Turn,
        reason: Reason,
        kind: TimeoutKind | None = None,
        audio: bytes | None = None,
    ) -> None:
        """Send the turn's audio and turn_done exactly once, then release the lock."""
        if t.done:
            return
        t.done = True
        me = asyncio.current_task()
        for task in (t.task, t.watchdog):
            if task is not None and task is not me:
                task.cancel()
        if audio is not None:
            t.conv = ConvState.SPEAKING
            await self._on_change()
            if reason is Reason.OK and t.utt_at is not None:
                first = _ms(self._clock() - t.utt_at)
                t.timings.first_audio_ms = first
                t.timings.sc1_ms = first + t.tail_silence_ms
            await t.owner.send(Tts(turn=t.id, seq=0, final=True), audio)
        await t.owner.send(TurnDone(turn=t.id, reason=reason, timeout_kind=kind, timings=t.timings))
        if self.current is t:
            self.current = None
        await self._on_change()
        await record_turn(
            self._db,
            turn=t.id,
            ts=t.ts,
            lang=t.lang,
            user_text=t.user_text,
            reply_text=t.reply_text,
            reason=reason,
            timeout_kind=kind,
            timings=t.timings,
        )
