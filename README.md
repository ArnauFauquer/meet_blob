# Blob

Blob is a self-hosted voice assistant that replaces a smart speaker. Its face is a dark,
liquid-metal blob drawn in the browser, on a tablet and in a desktop tab. You tap the blob and
ask a question in Spanish, Catalan or English. Blob turns the speech into text, asks
[Hermes Agent](https://hermes-agent.nousresearch.com/) for an answer, and speaks the reply.

*   **Backend** (`backend/`): one Python process (FastAPI). It does speech-to-text
    (faster-whisper) and text-to-speech (Kokoro, through `kokoro-onnx`), runs the turn
    pipeline, talks to Hermes over its OpenAI-compatible API, and serves the page.
*   **Page** (`web/`): one static web app (TypeScript, Vite, three.js). It owns the
    microphone, playback, taps and the blob.
*   **Contract**: [`protocol/messages.json`](protocol/messages.json) lists every WebSocket
    message between the two.

The design is [`docs/designs/blob_design.md`](docs/designs/blob_design.md). It covers four
slices: S1 tap-to-talk on the desktop, S2 tablet and deployment, S3 hands-free, S4 alerts and
timers. The backend implements S1 and the S2 backend parts (device token, `/device-config`,
serving the built page).

## Backend quickstart

Needs [uv](https://docs.astral.sh/uv/). uv installs Python 3.12 (newer Pythons have no
faster-whisper wheels). No GPU and no system packages are needed: Kokoro's phonemizer data comes
from the `espeakng-loader` wheel.

```sh
cd backend
uv sync
cp ../.env.example .env        # then edit: HERMES_URL, HERMES_KEY, HERMES_MODEL, DEVICE_TOKEN, ALERT_TOKEN
```

### Fast run, no models (`BLOB_FAKE_MODELS=1`)

`BLOB_FAKE_MODELS=1` replaces speech-to-text with a canned transcript (`BLOB_FAKE_TRANSCRIPT`,
`BLOB_FAKE_LANG`) and synthesis with a short tone. Quiet audio still ends as `empty`. Everything
else (turn pipeline, hub, Hermes client, database) is the real code. Use it to develop the page
or run end-to-end tests in seconds.

```sh
# terminal 1: a fake Hermes that records what it receives (GET /requests)
uv run python tests/fakes/fake_hermes.py --port 8642     # --mode error|markdown|question, --delay S

# terminal 2
BLOB_FAKE_MODELS=1 HERMES_URL=http://127.0.0.1:8642 HERMES_KEY=dev HERMES_MODEL=hermes-agent \
DEVICE_TOKEN=devtoken ALERT_TOKEN=alerttoken DB_PATH=./blob.db STATIC_DIR=../web/dist \
DEVICES_PATH=../config/devices.example.json uv run blob
```

### Real models on a CPU

```sh
STT_MODEL=small STT_COMPUTE=int8 MODEL_DIR=.models \
HERMES_URL=http://127.0.0.1:8642 HERMES_KEY=dev HERMES_MODEL=hermes-agent \
DEVICE_TOKEN=devtoken ALERT_TOKEN=alerttoken DB_PATH=./blob.db STATIC_DIR=../web/dist \
DEVICES_PATH=../config/devices.example.json uv run blob
```

The first start downloads the whisper model from Hugging Face and the Kokoro files
(`kokoro-v1.0.onnx`, `voices-v1.0.bin`, about 340 MB) from the kokoro-onnx GitHub release into
`MODEL_DIR`. `/readyz` returns 503 until the models are loaded and warmed up; a tap before that
gets `error{not_ready}`. Production defaults are `STT_MODEL=large-v3`,
`STT_COMPUTE=int8_float16`, `MODEL_DIR=/data/models`, `DB_PATH=/data/blob.db`.

### One turn from the command line

```sh
uv run python scripts/make_test_clips.py          # Kokoro-made clips in tests/clips/ (gitignored)
uv run python scripts/e2e_turn.py --url ws://127.0.0.1:8000/ws --token devtoken \
    --wav tests/clips/es.wav --expect ok
```

`e2e_turn.py` also takes `--empty`, `--cancel-after S`, `--busy-check`,
`--expect-error not_ready`, `--save-tts out.wav`, and (S3) `--wake [--followup]` with
`--device tablet` and `--expect-followup true|false`. `scripts/e2e_alerts.py` drives the S4 flows
(alert over HTTP, `alert_read`, `alert_ack`, a 2 s timer, a spoken timer through the timer rule,
`wake` gating); see [`docs/testing/exit-tests.md`](docs/testing/exit-tests.md). Other tools: `scripts/stt_cli.py` (transcribe
a WAV), `scripts/tts_cli.py` (synthesise text), `scripts/timings_report.py` (SC1 median).

### Endpoints

| Path | What |
| --- | --- |
| `/ws` | the WebSocket ([`protocol/messages.json`](protocol/messages.json)); first message `hello` with the device token |
| `/healthz` | always 200 while the process runs; body `{alive, ready, hermes_reachable}` |
| `/readyz` | 503 until the database is open and both models are loaded, then 200 |
| `/device-config?device=NAME` | `Authorization: Bearer DEVICE_TOKEN`; the device's `sound`/`wake` flags and page limits |
| `/alerts` | `Authorization: Bearer ALERT_TOKEN`; `POST`, `GET`, `DELETE /alerts/{key}` ([`docs/alerts.md`](docs/alerts.md)) |
| `/` | the built page from `STATIC_DIR` (`index.html` with `Cache-Control: no-cache`), or 404 with a message if it is not built |

### Configuration

Every environment variable, its default and its slice is in [`.env.example`](.env.example).
Per-device flags live in `config/devices.json` (example:
[`config/devices.example.json`](config/devices.example.json)).

### Tests

```sh
cd backend
uv run ruff check && uv run ruff format --check && uv run mypy blob
uv run pytest -m "not gpu" --cov --cov-fail-under=80
uv run pytest -m gpu -s        # real models (small/int8 on CPU by default); needs make_test_clips.py
```

### The timing line

At the end of every turn the backend prints one JSON line on standard output. It has no user
text (that goes to the `turns` table, kept 14 days):

```json
{"kind": "turn", "turn": 1, "reason": "ok", "timeout_kind": null, "lang": "es",
 "stt_ms": 5272, "hermes_ms": 4, "tts_ms": 2161, "first_audio_ms": 7438, "sc1_ms": 7938}
```

*   `reason`: `ok`, `empty`, `stt_fail`, `hermes_fail`, `timeout`, `tts_fail` or `cancel`;
    `timeout_kind` is `hermes`, `turn` or `listen` for a timeout.
*   `stt_ms`, `hermes_ms`, `tts_ms`: time spent in each stage (`null` if the stage did not run).
*   `first_audio_ms`: from the arrival of `utterance` to sending the reply audio.
*   `sc1_ms`: `first_audio_ms` plus the page's `tail_silence_ms`, i.e. from the last voiced
    frame to the first audio of the real reply (success criterion SC1). Only set for `ok`.

`client_event` messages from the page are printed the same way (`"kind": "client_event"`), and a
reply cut at `TTS_MAX_CHARS` prints `"kind": "tts_cut"`.

## Web page

The page is a static TypeScript app in `web/` (Vite, three.js, vitest, Playwright). The backend serves the built files from `web/dist` (`STATIC_DIR`) and sends `index.html` with `Cache-Control: no-cache`.

```sh
cd web
npm ci
npm run dev          # http://localhost:5173, proxies /ws and the HTTP endpoints to BLOB_BACKEND (default http://localhost:8000)
npm run lint && npm run typecheck && npm test && npm run build   # build after the backend is merged: the page version comes from backend/blob/__init__.py
```

Install a browser once with its token: open `https://<host>/#t=<DEVICE_TOKEN>&device=<name>`. The page stores both in `localStorage` and removes them from the address bar. Tap the blob to talk, tap again to send; tap while it thinks or speaks to cancel; long press opens diagnostics; tap an alert to hear it and clear it. On a device with `wake: true` in `config/devices.json` the page also loads the wake-word and voice-activity models from `/models/` and listens for the phrase in `web/public/models/wake.json` (stock phrase "hey jarvis"; see `docs/wake-word-training.md` for "hey blob").

End-to-end tests (Chromium headless, fake microphone, software GL):

```sh
npx playwright install chromium
npm run e2e                                  # against the mock backend (web/e2e/mock-backend.ts)
BLOB_URL=http://localhost:8000 BLOB_TOKEN=<DEVICE_TOKEN> BLOB_ALERT_TOKEN=<ALERT_TOKEN> npx playwright test   # against a running backend (mock-only specs are skipped)
npm run screenshots                          # rewrites docs/screenshots/ and the PWA icons
```

For the real-backend run, `config/devices.json` needs the devices `hf-wake`, `hf-vad`, `hf-quiet` (`wake: true`) and `e2e-sound` (`sound: true`). Screenshots of every state and of alerts are in `docs/screenshots/`; the look and its limits are in `docs/notes/look.md`.

## Deployment

The container image (`Dockerfile`) is built and pushed to `ghcr.io/arnaufauquer/meet_blob` by `.github/workflows/image.yml` (tag `sha-<short commit>`). The Kubernetes side lives in the `home_lab` repo (branch `feat/blob`: Helm chart `faukinator/blob`, Argo application, Terraform secret, and a NetworkPolicy for Hermes). Read `deploy/README.md` and `docs/notes/deploy.md` first. Alerts are created through `POST /alerts` (see `docs/alerts.md`). What was verified, and what was not, is in `docs/coordination/integration.md`.
