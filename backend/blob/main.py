"""Application entry: startup order, HTTP routes, the WebSocket and the built page."""

import asyncio
import logging
import os
import time
from collections.abc import AsyncIterator, Callable
from contextlib import asynccontextmanager, suppress
from pathlib import Path
from typing import Any, Protocol

import httpx
import numpy as np
import uvicorn
from fastapi import Depends, FastAPI, Request, WebSocket
from fastapi.responses import JSONResponse, PlainTextResponse
from fastapi.staticfiles import StaticFiles
from numpy.typing import NDArray
from starlette.responses import Response
from starlette.types import Scope

from . import alerts
from .alerts import Alerts, run_scheduler
from .auth import require_device_token
from .config import Settings
from .db import Db
from .devices import Device, DeviceConfig, load_devices
from .fakes import FakeStt, FakeTts
from .gpu import Gpu
from .hermes import HermesClient
from .hub import Hub
from .stt import SttResult, WhisperStt
from .tts import KokoroTts
from .turn import TurnManager

log = logging.getLogger(__name__)

HERMES_CHECK_S = 30
RETENTION_EVERY_S = 24 * 3600


class SttModel(Protocol):
    def load(self) -> None: ...

    def warmup(self) -> None: ...

    def __call__(self, audio: NDArray[np.float32]) -> SttResult: ...


class TtsModel(Protocol):
    def load(self) -> None: ...

    def warmup(self) -> None: ...

    def prerender_fallbacks(self) -> None: ...

    def fallback(self, lang: str | None) -> bytes: ...

    def __call__(self, text: str, lang: str | None) -> bytes: ...


class PageFiles(StaticFiles):
    """The built page; index.html is never cached so a new deploy is picked up."""

    def file_response(
        self, full_path: Any, stat_result: os.stat_result, scope: Scope, status_code: int = 200
    ) -> Response:
        resp = super().file_response(full_path, stat_result, scope, status_code)
        if os.path.basename(full_path) == "index.html":
            resp.headers["Cache-Control"] = "no-cache"
        return resp


def _models(settings: Settings) -> tuple[SttModel, TtsModel]:
    if settings.blob_fake_models:
        return (
            FakeStt(settings.blob_fake_transcript, settings.blob_fake_lang, settings.silence_rms),
            FakeTts(),
        )
    return (
        WhisperStt(settings.stt_model, settings.stt_compute, settings.model_dir),
        KokoroTts(settings.model_dir, settings.kokoro_device),
    )


def create_app(
    settings: Settings,
    *,
    models: tuple[SttModel, TtsModel] | None = None,
    hermes_transport: httpx.AsyncBaseTransport | None = None,
    wall: Callable[[], float] = time.time,
) -> FastAPI:
    devices = load_devices(settings.devices_path)  # a malformed file stops startup here
    stt, tts = models or _models(settings)

    @asynccontextmanager
    async def lifespan(app: FastAPI) -> AsyncIterator[None]:
        st = app.state
        st.db = Db(settings.db_path)
        st.hermes = HermesClient(
            settings.hermes_url,
            settings.hermes_key,
            settings.hermes_model,
            settings.hermes_connect_s,
            settings.hermes_total_s,
            settings.session_idle_s,
            transport=hermes_transport,
        )
        st.hub = Hub(settings.device_token, lambda: st.ready, devices)
        st.alerts = st.hub.alerts = Alerts(st.db, st.hub.broadcast_snapshot, wall)
        await st.alerts.load()  # overdue timers fire once, marked late
        st.hub.turns = TurnManager(
            stt=stt,
            tts=tts,
            fallback=tts.fallback,
            hermes=st.hermes,
            gpu=Gpu(),
            db=st.db,
            on_change=st.hub.broadcast,
            no_speech_max=settings.no_speech_max,
            tts_max_chars=settings.tts_max_chars,
            listen_watchdog_s=settings.listen_watchdog_s,
            turn_watchdog_s=settings.turn_watchdog_s,
            followup_max=settings.followup_max,
            create_timer=st.alerts.create_timer if settings.timer_rule else None,
            wall=wall,
        )
        tasks = [
            asyncio.create_task(run_scheduler(st.alerts)),
            asyncio.create_task(_load_models(app, stt, tts)),
            asyncio.create_task(_check_hermes(app)),
            asyncio.create_task(_retention(app, settings.retention_days)),
        ]
        try:
            yield
        finally:
            for t in tasks:
                t.cancel()
            for t in tasks:
                with suppress(asyncio.CancelledError):
                    await t
            await st.hermes.aclose()
            st.db.close()

    app = FastAPI(title="Blob", lifespan=lifespan)
    app.state.settings = settings
    app.state.devices = devices
    app.state.ready = False
    app.state.hermes_reachable = None

    @app.get("/healthz")
    async def healthz(request: Request) -> dict[str, Any]:
        st = request.app.state
        return {"alive": True, "ready": st.ready, "hermes_reachable": st.hermes_reachable}

    @app.get("/readyz")
    async def readyz(request: Request) -> JSONResponse:
        ready = bool(request.app.state.ready)
        return JSONResponse({"ready": ready}, status_code=200 if ready else 503)

    @app.get("/device-config", dependencies=[Depends(require_device_token)])
    async def device_config(device: str) -> DeviceConfig:
        flags = devices.get(device, Device())
        return DeviceConfig(
            device=device,
            sound=flags.sound,
            wake=flags.wake,
            quiet_hours=settings.quiet_hours,
            followup_listen_s=settings.followup_listen_s,
            listen_no_speech_s=settings.listen_no_speech_s,
            silence_rms=settings.silence_rms,
        )

    app.include_router(alerts.router)

    @app.websocket("/ws")
    async def ws(websocket: WebSocket) -> None:
        await websocket.app.state.hub.serve(websocket)

    static = Path(settings.static_dir)
    if (static / "index.html").is_file():
        app.mount("/", PageFiles(directory=static, html=True), name="page")
    else:
        log.warning("no built page at %s/index.html; / returns 404", static)

        @app.get("/")
        async def no_page() -> PlainTextResponse:
            return PlainTextResponse(
                f"Page not built: {static}/index.html not found (set STATIC_DIR or build web/).",
                status_code=404,
            )

    return app


async def _load_models(app: FastAPI, stt: SttModel, tts: TtsModel) -> None:
    def load() -> None:
        t0 = time.perf_counter()
        stt.load()
        stt.warmup()
        tts.load()
        tts.warmup()
        tts.prerender_fallbacks()
        log.info("models ready in %.1f s", time.perf_counter() - t0)

    try:
        await asyncio.to_thread(load)
    except Exception:
        log.exception("model loading failed; /readyz stays 503")
        return
    app.state.ready = True


async def _check_hermes(app: FastAPI) -> None:
    while True:
        app.state.hermes_reachable = await app.state.hermes.reachable()
        await asyncio.sleep(HERMES_CHECK_S)


async def _retention(app: FastAPI, days: int) -> None:
    while True:
        try:
            n = await app.state.db.delete_turns_older_than(days, time.time())
            log.info("deleted %d turns older than %d days", n, days)
        except Exception:
            log.exception("retention failed")
        await asyncio.sleep(RETENTION_EVERY_S)


def run() -> None:
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s %(message)s")
    settings = Settings()  # type: ignore[call-arg]  # required values come from the environment
    uvicorn.run(create_app(settings), host=settings.host, port=settings.port)
