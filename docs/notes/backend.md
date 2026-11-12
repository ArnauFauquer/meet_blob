# Backend notes: decisions and deviations

Where the design (`docs/designs/blob_design.md`) was ambiguous or did not fit, the backend took the
simplest option consistent with it. Each entry gives the decision and the reason.

## Scope

*   **Built:** design entries 13 to 29 and 32 to 38 for S1, plus the S2 backend parts: the device
    token on `hello` (close 4401) and on `GET /device-config` (401), `devices.py`,
    `Cache-Control: no-cache` on `index.html`, and serving `STATIC_DIR`.
*   **Not built (S3/S4):** `wake`, follow-up chains and `FOLLOWUP_MAX`, alerts, scheduler,
    `timer_rule.py`, `alert_read`/`alert_ack`, `ALERT_TOKEN`. The hub dispatches through a table
    (`Hub._handlers`), and `schemas.py` already has `AlertItem`, `Snapshot.alerts` and
    `Tts.alert`/`Tts.followup`, so these slices add entries without restructuring. A `wake`
    message gets `error{bad_message}` today.

## Decisions

1.  **Python 3.12, not 3.11.** The design pins 3.11; the brief asked for 3.12 through uv, which
    has faster-whisper and ctranslate2 wheels. `requires-python = ">=3.12,<3.13"`.
2.  **History mode `session` only.** The Hermes test confirmed `X-Hermes-Session-Id` keeps a
    session, and the design says to build only the selected mode. `HERMES_HISTORY_MODE=replay`
    fails validation at startup. `HISTORY_PAIRS` and `HERMES_NO_BYTES_S` (streaming only) are not
    read. Because Hermes keeps the history, a cancelled or failed request that reached Hermes may
    still be in Hermes's session; Blob cannot prevent that.
3.  **`MODEL_DIR` setting** (default `/data/models`, not in the design's table). Whisper downloads
    into it (`download_root`) and Kokoro into `MODEL_DIR/kokoro`. The brief asked for a
    configurable model directory.
4.  **`/device-config` also returns `device` and `silence_rms`.** The page computes
    `tail_silence_ms` against `silence_rms` (entry 50), and the design keeps `SILENCE_RMS` as a
    backend setting, so the page needs to read it. `followup_listen_s`, `listen_no_speech_s` and
    `quiet_hours` are served now (entry 29) although their features are S3/S4.
5.  **`utterance.rate` accepts `16000` and `"16000"`.** `protocol/messages.json` writes the value
    quoted while the design writes `rate: 16000`. The number is preferred; the string is accepted
    so the two readings interoperate. Reported to the coordinator.
6.  **Missing `devices.json`** logs a warning and gives every device `sound=false, wake=false`.
    A malformed file stops startup (design). Running from `backend/`, point `DEVICES_PATH` at
    `../config/devices.json`.
7.  **Speech-to-text warm-up** transcribes 1 s of zeros with `vad_filter=False` instead of
    `fixtures/short_es.wav`, so startup does not depend on a fixture file that may hold a personal
    voice. The model call still runs.
8.  **`stt(audio)` has no `lang` argument.** S1 always auto-detects; the argument would be unused.
9.  **`stt_fail` speaks the Spanish fallback line.** The language is unknown when speech-to-text
    fails; Spanish is the default of `voice_for`.
10. **Fallback audio sets `conv = speaking`** while it plays, like a reply. `first_audio_ms` and
    `sc1_ms` are set only for `ok`, because SC1 measures the first audio of the real reply.
11. **Hermes errors.** A non-200 status, an unreadable or empty reply, a connect error and a
    connect timeout are `hermes_fail`; the total timeout (asyncio or httpx read timeout) is
    `timeout`/`hermes`; any other exception from the client is treated as `hermes_fail`.
12. **Cancel** cancels the pipeline task. That is stronger than the three checkpoints in the
    design: the result is discarded at whatever await the pipeline is in. A model call already
    running in its thread finishes under the GPU lock and its output is dropped; the Hermes HTTP
    request is closed.
13. **Hub input conditions.** Any first message that is not a valid `hello` (including a binary
    frame) closes with 4400. A version mismatch answers `hello_ok{ok: false}` and keeps the socket
    open; the page applies the reload rule. A binary frame with no pending `utterance` header is
    dropped silently ("the server drops audio unless a turn is open"). A text message that
    arrives while the hub waits for an utterance's binary frame gets `error{bad_message}` and the
    turn stays in listening (the 30 s watchdog ends it if nothing else comes). Frames over 1 MB
    get `error{bad_message}` and the turn ends `cancel`; frames over uvicorn's 16 MB WebSocket
    limit close the socket, which also cancels the turn.
14. **Broadcasts** send `state` then `snapshot` to every client on every turn transition.
15. **Fake models** (`BLOB_FAKE_MODELS=1`): `FakeStt` returns an empty result when the audio RMS is
    below `SILENCE_RMS`, so silent turns still end `empty`; otherwise it returns
    `BLOB_FAKE_TRANSCRIPT` in `BLOB_FAKE_LANG`. `FakeTts` returns a 0.4 s tone (0.6 s for the
    fallback). They are plugged into the same `TurnManager` and `Hub`.
16. **Database close takes the writer lock.** Closing the connection at shutdown while a turn row
    was being written in a worker thread crashed the process (an intermittent segfault in the test
    suite). Writes after the close raise `sqlite3.ProgrammingError`, which `turnlog` logs.

## Kokoro findings (kokoro-onnx 0.6.1, model files v1.0)

*   54 voices in `voices-v1.0.bin`. Spanish: `ef_dora` (female, used), `em_alex`, `em_santa`.
    English (US): `af_heart` (used), `af_bella`, `am_adam`, `am_michael` and others; British
    `bf_*`/`bm_*`.
*   Language codes passed to Kokoro: `es` and `en-us`. Output sample rate: 24000 Hz.
*   No system `espeak-ng` is needed: `espeakng-loader` 0.2.4 ships the phonemizer data in the wheel.
*   On this CPU (12 threads), a short sentence takes 0.3 to 0.6 s; a 4 s reply took about 2 s.

## Speech-to-text findings (faster-whisper 1.2.1, `small`, `int8`, CPU)

*   Kokoro-made clips: Spanish and English transcribed exactly with the right language. A
    2.5 to 3.5 s clip takes 3.9 to 5.3 s on this CPU (`large-v3` on the GPU was not tested).
*   The Catalan clip is Catalan text read by the Spanish Kokoro voice; it was detected as `es` and
    partly garbled. It says nothing about real Catalan detection, which needs the author's clips.
*   Silence gives an empty text and `no_speech_prob` 1.0.

## Open issues

*   GPU path not tested (no GPU here): `large-v3` with `int8_float16`, peak memory, and
    `KOKORO_DEVICE=cuda`.
*   Real Hermes not used (no cluster access by rule); all turns used `tests/fakes/fake_hermes.py`.
*   SC1 on CPU with the fake Hermes was about 7.9 s, dominated by `small` speech-to-text on the CPU.
*   `hermes_reachable` is `null` until the first background check (right after startup).
