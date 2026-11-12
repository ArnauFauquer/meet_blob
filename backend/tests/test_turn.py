"""Turn pipeline: every failure row, cancel between stages and the watchdogs (injected clock)."""

import asyncio
import json
import threading
from collections.abc import Callable
from typing import Any

import numpy as np
import pytest
from pydantic import BaseModel

from blob.db import Db
from blob.gpu import Gpu
from blob.hermes import HermesFail, HermesTimeout
from blob.schemas import ConvState, Reason, TimeoutKind, Tts, TurnDone
from blob.stt import SttResult
from blob.turn import TurnManager
from tests.conftest import eventually

PCM = (np.ones(1600, dtype="<i2") * 1000).tobytes()
WAV = b"RIFF-reply"


class Owner:
    def __init__(self) -> None:
        self.sent: list[tuple[BaseModel, bytes | None]] = []

    async def send(self, msg: BaseModel, binary: bytes | None = None) -> None:
        self.sent.append((msg, binary))

    def types(self) -> list[str]:
        return [str(getattr(m, "type", "")) for m, _ in self.sent]

    def done(self) -> TurnDone:
        [d] = [m for m, _ in self.sent if isinstance(m, TurnDone)]
        return d


class Clock:
    def __init__(self) -> None:
        self.now = 100.0

    def __call__(self) -> float:
        return self.now


class Sleeps:
    """Injected sleep: each call waits until the test fires it."""

    def __init__(self) -> None:
        self.pending: list[tuple[float, asyncio.Future[None]]] = []

    async def __call__(self, seconds: float) -> None:
        fut = asyncio.get_running_loop().create_future()
        self.pending.append((seconds, fut))
        await fut

    async def fire(self, seconds: float) -> None:
        await settle()  # let watchdog tasks reach their sleep
        for s, fut in self.pending:
            if s == seconds and not fut.done():
                fut.set_result(None)
        await settle()


class Hermes:
    def __init__(self, reply: str | BaseException = "La respuesta.") -> None:
        self.reply = reply
        self.calls: list[str] = []
        self.gate: asyncio.Event | None = None
        self.cancelled = False

    async def ask(self, user_text: str) -> str:
        self.calls.append(user_text)
        if self.gate is not None:
            try:
                await self.gate.wait()
            except asyncio.CancelledError:
                self.cancelled = True
                raise
        if isinstance(self.reply, BaseException):
            raise self.reply
        return self.reply


async def settle() -> None:
    for _ in range(20):
        await asyncio.sleep(0)


class Rig:
    def __init__(
        self,
        *,
        stt: Callable[..., SttResult] | None = None,
        tts: Callable[[str, str | None], bytes] | None = None,
        hermes: Hermes | None = None,
        tts_max_chars: int = 1200,
        **extra: Any,
    ) -> None:
        self.clock, self.sleeps = Clock(), Sleeps()
        self.hermes = hermes or Hermes()
        self.db = Db(":memory:")
        self.convs: list[ConvState] = []
        self.tts_texts: list[tuple[str, str | None]] = []
        self.stt_calls = 0
        self._stt = stt or (lambda _a: SttResult("¿Qué hora es?", "es", 0.1))
        self._tts = tts or (lambda _t, _l: WAV)
        self.tm = TurnManager(
            stt=self.stt,
            tts=self.tts,
            fallback=lambda lang: f"fallback-{lang}".encode(),
            hermes=self.hermes,
            gpu=Gpu(),
            db=self.db,
            on_change=self.changed,
            no_speech_max=0.6,
            tts_max_chars=tts_max_chars,
            listen_watchdog_s=30,
            turn_watchdog_s=120,
            clock=self.clock,
            wall=lambda: 1_700_000_000.0,
            sleep=self.sleeps,
            **extra,
        )
        self.owner = Owner()

    def stt(self, audio: Any) -> SttResult:
        self.stt_calls += 1
        return self._stt(audio)

    def tts(self, text: str, lang: str | None) -> bytes:
        self.tts_texts.append((text, lang))
        return self._tts(text, lang)

    async def changed(self) -> None:
        self.convs.append(self.tm.conv)

    async def run_turn(self, pcm: bytes = PCM, tail: int = 250) -> TurnDone:
        turn = await self.tm.start(self.owner)
        assert turn is not None
        assert await self.tm.submit(self.owner, turn.id, pcm, tail)
        await self.wait_done()
        return self.owner.done()

    async def wait_done(self) -> None:
        for _ in range(500):
            if self.tm.current is None:
                return
            await asyncio.sleep(0.005)
        raise AssertionError("turn did not end")


async def test_happy_path() -> None:
    r = Rig()
    done = await r.run_turn()
    assert done.reason is Reason.OK and done.timeout_kind is None
    assert r.owner.types() == ["tts", "turn_done"]
    tts, audio = r.owner.sent[0]
    assert isinstance(tts, Tts) and (tts.turn, tts.seq, tts.final, tts.followup) == (
        1,
        0,
        True,
        False,
    )
    assert audio == WAV
    assert r.convs == [ConvState.LISTENING, ConvState.THINKING, ConvState.SPEAKING, ConvState.IDLE]
    assert done.timings.model_dump().keys() == {
        "stt_ms",
        "hermes_ms",
        "tts_ms",
        "first_audio_ms",
        "sc1_ms",
    }
    assert done.timings.first_audio_ms == 0 and done.timings.sc1_ms == 250
    assert r.hermes.calls == ["¿Qué hora es?"]
    assert r.tts_texts == [("La respuesta.", "es")]
    [row] = r.db.turns()
    assert (row["reason"], row["lang"], row["user_text"], row["reply_text"]) == (
        "ok",
        "es",
        "¿Qué hora es?",
        "La respuesta.",
    )


async def test_timings_measure_stages() -> None:
    r = Rig()

    def slow_stt(_a: Any) -> SttResult:
        r.clock.now += 1.5
        return SttResult("hola", "es", 0.0)

    r._stt = slow_stt
    r.hermes = Hermes()
    original = r.hermes.ask

    async def slow_ask(text: str) -> str:
        r.clock.now += 3.0
        return await original(text)

    r.tm._hermes = type("H", (), {"ask": staticmethod(slow_ask)})()
    done = await r.run_turn(tail=400)
    t = done.timings
    assert (t.stt_ms, t.hermes_ms, t.tts_ms, t.first_audio_ms, t.sc1_ms) == (
        1500,
        3000,
        0,
        4500,
        4900,
    )


async def test_reply_cleaned_before_synthesis() -> None:
    r = Rig(hermes=Hermes("**Hola** 🙂 mira https://x.org"))
    await r.run_turn()
    assert r.tts_texts == [("Hola mira", "es")]


async def test_tts_cut_is_logged(capsys: pytest.CaptureFixture[str]) -> None:
    r = Rig(hermes=Hermes("Una frase corta. " * 10), tts_max_chars=50)
    await r.run_turn()
    assert r.tts_texts[0][0] == "Una frase corta. Una frase corta. Una frase corta."
    lines = [json.loads(x) for x in capsys.readouterr().out.splitlines()]
    assert {"kind": "tts_cut", "turn": 1, "chars": 169, "kept": 50} in lines


@pytest.mark.parametrize(
    "result", [SttResult("", None, 0.0), SttResult("  ", "es", 0.0), SttResult("hmm", "en", 0.9)]
)
async def test_empty_speech_no_hermes(result: SttResult) -> None:
    r = Rig(stt=lambda _a: result)
    done = await r.run_turn()
    assert done.reason is Reason.EMPTY
    assert r.hermes.calls == [] and r.owner.types() == ["turn_done"]


async def test_zero_length_utterance_is_empty() -> None:
    r = Rig()
    done = await r.run_turn(pcm=b"")
    assert done.reason is Reason.EMPTY and r.stt_calls == 0 and r.hermes.calls == []


async def test_stt_fail_speaks_spanish_fallback() -> None:
    def boom(_a: Any) -> SttResult:
        raise RuntimeError("CUDA out of memory")

    r = Rig(stt=boom)
    done = await r.run_turn()
    assert done.reason is Reason.STT_FAIL
    assert r.owner.sent[0][1] == b"fallback-None"  # language unknown: the Spanish line
    assert r.hermes.calls == []
    assert done.timings.stt_ms is not None and done.timings.first_audio_ms is None


@pytest.mark.parametrize(
    ("error", "reason", "kind"),
    [
        (HermesFail("status 500"), Reason.HERMES_FAIL, None),
        (RuntimeError("unexpected"), Reason.HERMES_FAIL, None),
        (HermesTimeout(), Reason.TIMEOUT, TimeoutKind.HERMES),
    ],
)
async def test_hermes_failure_plays_fallback(
    error: BaseException, reason: Reason, kind: TimeoutKind | None
) -> None:
    r = Rig(stt=lambda _a: SttResult("what time is it", "en", 0.0), hermes=Hermes(error))
    done = await r.run_turn()
    assert (done.reason, done.timeout_kind) == (reason, kind)
    assert r.owner.types() == ["tts", "turn_done"]
    assert r.owner.sent[0][1] == b"fallback-en"
    assert r.tts_texts == []
    assert ConvState.SPEAKING in r.convs
    [row] = r.db.turns()
    assert row["reply_text"] == ""  # the fallback line is never stored as a reply


async def test_tts_fail_sends_no_audio() -> None:
    def boom(_t: str, _l: str | None) -> bytes:
        raise RuntimeError("onnx")

    r = Rig(tts=boom)
    done = await r.run_turn()
    assert done.reason is Reason.TTS_FAIL and r.owner.types() == ["turn_done"]
    assert ConvState.SPEAKING not in r.convs


async def test_busy() -> None:
    r = Rig()
    assert await r.tm.start(r.owner) is not None
    assert await r.tm.start(Owner()) is None
    assert await r.tm.start(r.owner) is None


async def test_utterance_rules() -> None:
    r = Rig()
    turn = await r.tm.start(r.owner)
    assert turn is not None
    assert not await r.tm.submit(Owner(), turn.id, PCM, 0)  # another connection
    assert not await r.tm.submit(r.owner, turn.id + 1, PCM, 0)  # wrong turn id
    await r.tm.cancel(Owner(), turn.id)  # someone else's cancel is ignored
    await r.tm.cancel(r.owner, turn.id + 1)
    assert r.tm.current is turn
    assert await r.tm.submit(r.owner, turn.id, PCM, 0)
    assert not await r.tm.submit(r.owner, turn.id, PCM, 0)  # no longer listening
    await r.wait_done()


async def test_no_turn_open() -> None:
    r = Rig()
    assert not await r.tm.submit(r.owner, 1, PCM, 0)
    await r.tm.cancel(r.owner, 1)
    await r.tm.drop_owner(r.owner)
    assert r.owner.sent == []


async def test_cancel_while_listening() -> None:
    r = Rig()
    turn = await r.tm.start(r.owner)
    assert turn is not None
    await r.tm.cancel(r.owner, turn.id)
    assert r.owner.done().reason is Reason.CANCEL and r.tm.current is None
    assert r.tm.conv is ConvState.IDLE
    await r.sleeps.fire(30)  # the listening watchdog was cancelled with the turn
    assert r.owner.types() == ["turn_done"]


async def test_cancel_during_stt_discards_result() -> None:
    release = threading.Event()

    def slow(_a: Any) -> SttResult:
        release.wait(5)
        return SttResult("hola", "es", 0.0)

    r = Rig(stt=slow)
    turn = await r.tm.start(r.owner)
    assert turn is not None
    await r.tm.submit(r.owner, turn.id, PCM, 0)
    await asyncio.sleep(0.05)
    await r.tm.cancel(r.owner, turn.id)
    release.set()
    await asyncio.sleep(0.1)
    assert r.owner.done().reason is Reason.CANCEL
    assert r.hermes.calls == [] and r.owner.types() == ["turn_done"]
    # The next turn waits for the GPU thread to finish, then works.
    r.owner = Owner()
    assert (await r.run_turn()).reason is Reason.OK


async def test_cancel_during_hermes_closes_request() -> None:
    r = Rig()
    r.hermes.gate = asyncio.Event()
    turn = await r.tm.start(r.owner)
    assert turn is not None
    await r.tm.submit(r.owner, turn.id, PCM, 0)
    await eventually(lambda: r.hermes.calls)
    await r.tm.cancel(r.owner, turn.id)
    await settle()
    assert r.hermes.cancelled
    assert r.owner.types() == ["turn_done"] and r.owner.done().reason is Reason.CANCEL
    assert r.tts_texts == []


async def test_cancel_during_tts_drops_audio() -> None:
    release = threading.Event()

    def slow(_t: str, _l: str | None) -> bytes:
        release.wait(5)
        return WAV

    r = Rig(tts=slow)
    turn = await r.tm.start(r.owner)
    assert turn is not None
    await r.tm.submit(r.owner, turn.id, PCM, 0)
    await eventually(lambda: r.tts_texts)
    await r.tm.cancel(r.owner, turn.id)
    release.set()
    await asyncio.sleep(0.1)
    assert r.owner.types() == ["turn_done"] and r.owner.done().reason is Reason.CANCEL


async def test_listen_watchdog() -> None:
    r = Rig()
    turn = await r.tm.start(r.owner)
    assert turn is not None
    await r.sleeps.fire(30)
    done = r.owner.done()
    assert (done.reason, done.timeout_kind) == (Reason.TIMEOUT, TimeoutKind.LISTEN)
    assert r.owner.types() == ["turn_done"]  # no fallback line for listen
    assert r.tm.current is None


async def test_turn_watchdog_from_utterance() -> None:
    r = Rig(stt=lambda _a: SttResult("hello", "en", 0.0))
    r.hermes.gate = asyncio.Event()
    turn = await r.tm.start(r.owner)
    assert turn is not None
    await r.tm.submit(r.owner, turn.id, PCM, 0)
    await r.sleeps.fire(30)  # the listening watchdog stopped when the utterance came
    assert r.tm.current is turn
    await eventually(lambda: r.hermes.calls)
    await r.sleeps.fire(120)
    done = r.owner.done()
    assert (done.reason, done.timeout_kind) == (Reason.TIMEOUT, TimeoutKind.TURN)
    assert r.owner.sent[0][1] == b"fallback-en"
    assert r.hermes.cancelled and r.tm.current is None


async def test_drop_owner_frees_lock() -> None:
    r = Rig()
    r.hermes.gate = asyncio.Event()
    turn = await r.tm.start(r.owner)
    assert turn is not None
    await r.tm.submit(r.owner, turn.id, PCM, 0)
    await eventually(lambda: r.hermes.calls)
    await r.tm.drop_owner(Owner())  # not the owner: nothing happens
    assert r.tm.current is turn
    await r.tm.drop_owner(r.owner)
    assert r.tm.current is None and r.owner.done().reason is Reason.CANCEL
    assert await r.tm.start(Owner()) is not None


async def test_turn_done_exactly_once() -> None:
    r = Rig()
    r.hermes.gate = asyncio.Event()
    turn = await r.tm.start(r.owner)
    assert turn is not None
    await r.tm.submit(r.owner, turn.id, PCM, 0)
    await eventually(lambda: r.hermes.calls)
    # Cancel, watchdog and a late Hermes reply race; one turn_done goes out.
    await asyncio.gather(r.tm.cancel(r.owner, turn.id), r.sleeps.fire(120))
    r.hermes.gate.set()
    await r.tm.cancel(r.owner, turn.id)
    await settle()
    assert r.owner.types().count("turn_done") == 1
    assert len(r.db.turns()) == 1


async def test_ids_increase() -> None:
    r = Rig()
    assert (await r.run_turn()).turn == 1
    r.owner = Owner()
    assert (await r.run_turn()).turn == 2


# S3: follow-up flag and chain guard


def followups(r: Rig) -> list[bool]:
    return [m.followup for m, _ in r.owner.sent if isinstance(m, Tts)]


async def flag(r: Rig, pcm: bytes = PCM) -> bool | None:
    """Run one turn with a fresh owner; the tts followup flag, or None when nothing was spoken."""
    r.owner = Owner()
    await r.run_turn(pcm=pcm)
    return followups(r)[0] if followups(r) else None


async def test_reply_ending_with_question_sets_followup() -> None:
    r = Rig(hermes=Hermes("¿Apago las **luces** del salón? 🙂"))
    done = await r.run_turn()
    assert done.reason is Reason.OK and followups(r) == [True]


async def test_reply_without_question_has_no_followup() -> None:
    r = Rig()
    await r.run_turn()
    assert followups(r) == [False]


async def test_followup_chain_is_capped() -> None:
    r = Rig(hermes=Hermes("¿Seguro?"), followup_max=3)
    got = []
    for _ in range(5):
        got.append(await flag(r))
        r.clock.now += 3  # the follow-up starts within 10 s
    assert got == [True, True, True, False, False]


async def test_chain_resets_on_a_reply_without_question() -> None:
    r = Rig(hermes=Hermes("¿Seguro?"), followup_max=2)
    got = [await flag(r), await flag(r), await flag(r)]  # the third is capped
    r.hermes.reply = "Hecho."
    got.append(await flag(r))
    r.hermes.reply = "¿Algo más?"
    got.append(await flag(r))
    assert got == [True, True, False, False, True]


async def test_chain_resets_on_an_empty_turn() -> None:
    r = Rig(hermes=Hermes("¿Seguro?"), followup_max=1)
    got = [await flag(r), await flag(r, pcm=b""), await flag(r)]
    assert got == [True, None, True]  # nobody answered the follow-up: the chain ended


async def test_chain_resets_after_10_s_idle() -> None:
    r = Rig(hermes=Hermes("¿Seguro?"), followup_max=1)
    got = [await flag(r)]
    r.clock.now += 5
    got.append(await flag(r))  # capped: within 10 s
    r.clock.now += 10.5
    got.append(await flag(r))  # more than 10 s idle: a new chain
    assert got == [True, False, True]


async def test_fallback_never_asks_for_followup() -> None:
    r = Rig(hermes=Hermes(HermesFail("down")))
    await r.run_turn()
    assert followups(r) == [False]


# S4: timer rule before Hermes


class Timers:
    def __init__(self, fail: bool = False) -> None:
        self.created: list[Any] = []
        self.fail = fail

    async def __call__(self, req: Any) -> None:
        if self.fail:
            raise RuntimeError("database locked")
        self.created.append(req)


async def test_timer_rule_skips_hermes() -> None:
    timers = Timers()
    r = Rig(
        stt=lambda _a: SttResult("Pon un temporizador de 10 minutos.", "es", 0.0),
        create_timer=timers,
    )
    done = await r.run_turn()
    assert done.reason is Reason.OK and r.hermes.calls == []
    [req] = timers.created
    assert (req.key, req.in_s, req.lang) == ("timer-1700000000", 600, "es")
    assert r.tts_texts == [("Vale, temporizador de 10 minutos.", "es")]
    assert done.timings.hermes_ms is None and done.timings.first_audio_ms is not None
    assert followups(r) == [False]
    assert r.db.turns()[0]["reply_text"] == "Vale, temporizador de 10 minutos."


async def test_timer_rule_off_asks_hermes() -> None:
    r = Rig(stt=lambda _a: SttResult("pon un temporizador de 10 minutos", "es", 0.0))
    await r.run_turn()
    assert r.hermes.calls == ["pon un temporizador de 10 minutos"]


async def test_no_match_asks_hermes() -> None:
    timers = Timers()
    r = Rig(create_timer=timers)
    await r.run_turn()
    assert timers.created == [] and r.hermes.calls == ["¿Qué hora es?"]


async def test_timer_creation_failure_asks_hermes() -> None:
    r = Rig(
        stt=lambda _a: SttResult("set a timer for 5 minutes", "en", 0.0),
        create_timer=Timers(fail=True),
    )
    done = await r.run_turn()
    assert done.reason is Reason.OK and r.hermes.calls == ["set a timer for 5 minutes"]


async def test_synth_for_alert_read() -> None:
    r = Rig()
    assert await r.tm.synth("Fin del temporizador", "es") == WAV
    assert r.tts_texts == [("Fin del temporizador", "es")]
