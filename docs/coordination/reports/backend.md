# Backend report (wave 1)

*   **Branch:** `t3/blob-backend-s1-s2`
*   **Commits:** `3f028f6` (pipeline, hub, Hermes client, models, app; earlier sub-agent, kept),
    `6e27919` (unit tests), `454f1e5` (scripts and real-model smoke test), `363eb4d` (database
    close fix), `35830dc` (docs, CI, `.env.example`), and the commit that adds this report.
    Nothing was pushed or merged.
*   **Date:** 2026-11-12, on a machine with no GPU (12 CPUs), Python 3.12 through uv.

## What was there and what was done

The cancelled sub-agent left a complete `backend/blob/` package and the fake Hermes. I reviewed
it against the design and kept it. I added the tests, scripts, docs, CI and `.env.example`. I
fixed two things: a real crash (closing SQLite at shutdown while a worker thread was writing a
turn row caused an intermittent segfault, fixed in `db.py`) and an ambiguity in the contract
(`utterance.rate` is now accepted as `16000` or `"16000"`).

## Files

*   `backend/blob/`: `__init__.py`, `audio.py`, `auth.py`, `config.py`, `db.py`, `devices.py`,
    `fakes.py`, `gpu.py`, `hermes.py`, `hub.py`, `main.py`, `schemas.py`, `stt.py`,
    `textclean.py`, `tts.py`, `turn.py`, `turnlog.py`, `voices.py`
*   `backend/scripts/`: `make_test_clips.py`, `e2e_turn.py`, `stt_cli.py`, `tts_cli.py`,
    `timings_report.py`
*   `backend/tests/`: `conftest.py`, `fakes/fake_hermes.py` (also a runnable server), and
    `test_auth`, `test_config`, `test_db`, `test_devices`, `test_fakes`, `test_gpu`,
    `test_hermes`, `test_hub`, `test_main`, `test_protocol`, `test_speech_gpu` (marker `gpu`),
    `test_textclean`, `test_turn`, `test_turnlog`, `test_voices`
*   `backend/pyproject.toml`, `backend/uv.lock`, `backend/.python-version`, `backend/.gitignore`
*   `README.md` (with a "Web page" stub and a "Deployment" stub), `.env.example`,
    `.github/workflows/ci.yml`, `docs/testing/exit-tests.md`, `docs/notes/backend.md`,
    `config/devices.example.json` (unchanged)

## Definition of Done

### 1. Static checks and unit tests: PASS

Run in `backend/`:

```text
$ uv run ruff check                 -> All checks passed
$ uv run ruff format --check        -> 42 files already formatted
$ uv run mypy blob                  -> no issues (strict)
$ uv run pytest -m "not gpu" --cov --cov-fail-under=80
  144 passed, 8 deselected; total coverage 98.62%
```

After the database fix, the suite ran 25 times in a row with no failure (before the fix, 1 run in
8 crashed with a segfault at teardown).

Coverage by test file, against design entry 37 (S1/S2):

*   `test_config`: defaults, environment, every required variable, validation errors.
*   `test_textclean`, `test_voices`: markdown, emoji, URLs, whitespace, truncation with and
    without a sentence end; the voice map, unknown languages, overrides, fallback language.
*   `test_hermes` (fake Hermes over `httpx.ASGITransport`, records headers and bodies): body and
    `Authorization`, `X-Hermes-Session-Id` kept and rotated after 300 s idle (injected clock),
    error status and empty reply to `HermesFail`, connect timeout and refused to `HermesFail`,
    read and total timeout to `HermesTimeout`, cancel propagates, `/health` check.
*   `test_gpu`: a cancelled caller keeps the lock until its thread returns; a second call waits.
*   `test_turn` (injected clock and sleep): happy path with stage timings and `sc1_ms`; cleaning;
    the `tts_max_chars` cut logged; empty text, high no-speech probability and zero-length audio
    end `empty` with zero Hermes calls; `stt_fail` with the Spanish fallback; `hermes_fail` and
    `timeout`/`hermes` with the fallback in the question's language; `tts_fail` with no audio;
    `busy`; utterance rules; cancel while listening, during speech-to-text, during Hermes and
    during synthesis; listening watchdog (`listen`, no fallback); processing watchdog (`turn`,
    fallback); a closed socket frees the lock; `turn_done` exactly once under a cancel, watchdog
    and late reply race.
*   `test_hub` (real in-process WebSocket): full turn with state order and the `tts` header
    followed by its frame; mirrors get state but not audio; silence and zero-length utterance;
    Hermes down; message before `hello` closes 4400 (tap, ping, bad JSON, binary); wrong token
    closes 4401; version mismatch; ping/pong; `bad_message` cases including `wake` (S3, not
    built); `client_event` printed; `busy`; utterance with no turn, wrong turn, bad format, bad
    rate leaves the lock; header without frame; 1 MB frame ends `cancel`; cancel; close releases
    the lock; listening watchdog; `not_ready` while models load.
*   `test_db`, `test_turnlog`: schema and `user_version` 1, insert, 14-day deletion, a newer file
    (version 2 with an extra table) still opens, close during writes, the timing line carries no
    text, a database failure is logged, `client_event` printed and not stored.
*   `test_main`: `/healthz` and `/readyz` states, model failure keeps 503, retention at startup,
    `/` 404 with no page, page served with `Cache-Control: no-cache` on `index.html` only, the
    fake-models switch, `run()`.
*   `test_auth`, `test_devices`: constant-time compare; 401 without, with a wrong, and with a
    scheme-less token; the example file; missing file; malformed file (and startup stops);
    unknown device gets false and false.
*   `test_protocol`: the Pydantic models match `protocol/messages.json` (message names and fields
    in both directions, the four enums, `alert_item`, close codes, version, timings keys). The
    S3/S4 messages `wake`, `alert_read`, `alert_ack` are listed as not built.

### 2. Real-model smoke test: PASS (CPU)

```text
$ uv run python scripts/make_test_clips.py
  ca.wav 3.50 s, en.wav 2.56 s, es.wav 2.77 s, silence.wav 2.00 s (16 kHz)
$ uv run pytest -m gpu -s          # STT_MODEL=small, STT_COMPUTE=int8, MODEL_DIR=.models defaults
  es: '¿Cuál es la capital de Francia?' lang=es p=0.04 4.18s
  en: 'What is the capital of France?' lang=en p=0.02 3.86s
  es: 1.51s audio at 24000 Hz in 0.58s
  en: 1.43s audio at 24000 Hz in 0.58s
  ca: 0.73s audio at 24000 Hz in 0.32s
  8 passed, 140 deselected in 21.18s
```

Also run: `stt_cli.py tests/clips/silence.wav` gives empty text and `no_speech_prob` 1.000;
`tts_cli.py "Hola, ¿qué tal?" es out.wav` gives `ef_dora (es)`, 24000 Hz, 0.39 s.
Voices confirmed in kokoro-onnx 0.6.1: `ef_dora`, `em_alex`, `em_santa` (Spanish), `af_heart`
and others (English). No system `espeak-ng` was needed.

### 3. End-to-end run with `uv run blob`: PASS

Real faster-whisper `small`/`int8` and Kokoro on the CPU, fake Hermes as a server on port 18642,
`backend/scripts/e2e_turn.py` over a real WebSocket. Results:

| Check | Result |
| --- | --- |
| Tap right after the port opens | `error{not_ready}`; `/readyz` 503; models ready in 7.6 s |
| Spanish turn (`es.wav`) | `turn_done` `ok`; WAV 24000 Hz, 3.86 s; timings keys present |
| English turn (`en.wav`) | `turn_done` `ok`; WAV 24000 Hz, 4.33 s |
| Fake Hermes records | 2 requests, the exact transcripts, one session id, `Bearer dev-key` |
| Silent clip and zero-length utterance | both `empty`; fake Hermes counted 0 requests |
| Cancel 0.5 s after the utterance, plus a tap from a second connection | second tap `error{busy}`; turn `cancel`, no audio |
| Hermes stopped | English fallback WAV (3.22 s), then `hermes_fail` |
| Slow Hermes (`--delay 3`, `HERMES_TOTAL_S=1`, fake models) | fallback, `timeout` / `hermes` |
| Wrong token on `hello` | closed with 4401 |
| `/device-config` | 401 without token; with it `{"device":"tablet","sound":true,"wake":true,...}` |

Timing lines printed by the server (standard output):

```json
{"kind": "turn", "turn": 1, "reason": "ok", "timeout_kind": null, "lang": "es", "stt_ms": 5272, "hermes_ms": 4, "tts_ms": 2161, "first_audio_ms": 7438, "sc1_ms": 7938}
{"kind": "turn", "turn": 2, "reason": "ok", "timeout_kind": null, "lang": "en", "stt_ms": 5291, "hermes_ms": 3, "tts_ms": 2004, "first_audio_ms": 7301, "sc1_ms": 7801}
{"kind": "turn", "turn": 3, "reason": "empty", "timeout_kind": null, "lang": null, "stt_ms": 2626, "hermes_ms": null, "tts_ms": null, "first_audio_ms": null, "sc1_ms": null}
{"kind": "turn", "turn": 4, "reason": "empty", "timeout_kind": null, "lang": null, "stt_ms": null, "hermes_ms": null, "tts_ms": null, "first_audio_ms": null, "sc1_ms": null}
{"kind": "turn", "turn": 5, "reason": "cancel", "timeout_kind": null, "lang": null, "stt_ms": null, "hermes_ms": null, "tts_ms": null, "first_audio_ms": null, "sc1_ms": null}
{"kind": "turn", "turn": 6, "reason": "hermes_fail", "timeout_kind": null, "lang": "en", "stt_ms": 3867, "hermes_ms": 1, "tts_ms": null, "first_audio_ms": null, "sc1_ms": null}
```

`timings_report.py`: 6 turns, `sc1_ms` median 7870, p90 7938; by reason ok 2, empty 2, cancel 1,
hermes_fail 1.

### 4. Built page from `STATIC_DIR`: PASS

With a stand-in `dist/` (`index.html`, `assets/app-abc.js`): `GET /` 200 with
`Cache-Control: no-cache`, the asset 200 without it. With no page (`../web/dist` absent):
`GET /` 404 "Page not built: ../web/dist/index.html not found (set STATIC_DIR or build web/)."
Also covered by `test_main.py`. The real page from the web session was not available to test.

### 5. `docs/testing/exit-tests.md`: PASS

Part A is the numbered S1 backend exit test exactly as run above (13 steps). Part B is the full
S1 exit test from the design (page, GPU, real Hermes), marked not run. S2 to S4 are stubs.

## Not tested, and why

*   GPU: `large-v3` with `int8_float16`, peak memory under 8 GB, `KOKORO_DEVICE=cuda`. There is
    no GPU on this machine.
*   Real Hermes: not reachable by rule (no cluster access). All turns used the fake Hermes.
*   Real voices and real Catalan: the clips are synthetic. The Catalan clip (Catalan text read
    by the Spanish voice) was detected as `es`; that says nothing about the author's Catalan.
*   The CI workflow was checked as valid YAML with the expected steps; it was not run on GitHub.
    The web job depends on the script names promised by the web session.
*   The full S1 exit test (Part B) needs the page, the GPU and the real Hermes.

## Deviations and open issues

All are in [`docs/notes/backend.md`](../../notes/backend.md). The main ones:

*   Python 3.12 instead of 3.11 (wheels; as the brief asked).
*   Only `HERMES_HISTORY_MODE=session` is built; `replay`, `HISTORY_PAIRS`, `HERMES_NO_BYTES_S`,
    `FOLLOWUP_MAX` and `ALERT_TOKEN` are not read (later slices or not selected).
*   New setting `MODEL_DIR` (model cache, default `/data/models`).
*   `/device-config` also returns `device` and `silence_rms` (the page needs `silence_rms`).
*   Contract ambiguity: `protocol/messages.json` writes `"rate": "16000"` (quoted), the design
    writes `rate: 16000`. The backend accepts both; reported to the coordinator.
*   Speech-to-text warm-up uses 1 s of zeros (with the VAD off), not a fixture file.
*   SC1 on the CPU with the fake Hermes is about 7.9 s, mostly speech-to-text with `small` on CPU.

## How to start the server locally

From `backend/`, after `uv sync`:

```sh
# Fake Hermes (any mode: --mode ok|error|markdown|empty, --delay S)
uv run python tests/fakes/fake_hermes.py --port 8642

# Fake models (canned transcript, tone audio): starts in about a second
BLOB_FAKE_MODELS=1 HERMES_URL=http://127.0.0.1:8642 HERMES_KEY=dev HERMES_MODEL=hermes-agent \
DEVICE_TOKEN=devtoken DB_PATH=./blob.db STATIC_DIR=../web/dist \
DEVICES_PATH=../config/devices.example.json uv run blob

# Real models on the CPU (first start downloads about 800 MB into .models/)
STT_MODEL=small STT_COMPUTE=int8 MODEL_DIR=.models \
HERMES_URL=http://127.0.0.1:8642 HERMES_KEY=dev HERMES_MODEL=hermes-agent \
DEVICE_TOKEN=devtoken DB_PATH=./blob.db STATIC_DIR=../web/dist \
DEVICES_PATH=../config/devices.example.json uv run blob

# One turn
uv run python scripts/make_test_clips.py
uv run python scripts/e2e_turn.py --url ws://127.0.0.1:8000/ws --token devtoken \
    --wav tests/clips/es.wav --expect ok
```
