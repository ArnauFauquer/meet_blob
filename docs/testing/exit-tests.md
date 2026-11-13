# Exit tests

Each slice passes when its numbered list passes. Commands run from `backend/` unless noted.

## S1: tap-to-talk on the desktop

### Part A: backend exit test (run on 2026-11-12, CPU only, fake Hermes)

This part needs no page, no GPU and no real Hermes. It was run on a machine with no GPU, with
`STT_MODEL=small STT_COMPUTE=int8` and Kokoro on the CPU. Every step passed.

Setup:

```sh
uv sync
uv run python scripts/make_test_clips.py      # es.wav, en.wav, ca.wav, silence.wav in tests/clips/
uv run python tests/fakes/fake_hermes.py --port 18642 &
HERMES_URL=http://127.0.0.1:18642 HERMES_KEY=dev-key HERMES_MODEL=hermes-agent \
DEVICE_TOKEN=devtoken STT_MODEL=small STT_COMPUTE=int8 MODEL_DIR=.models DB_PATH=/tmp/blob.db \
STATIC_DIR=../web/dist DEVICES_PATH=../config/devices.example.json PORT=18000 uv run blob > blob.log &
E() { uv run python scripts/e2e_turn.py --url ws://127.0.0.1:18000/ws --token devtoken "$@"; }
```

1.  Static checks: `uv run ruff check`, `uv run ruff format --check`, `uv run mypy blob` report
    no issues.
2.  Unit tests: `uv run pytest -m "not gpu" --cov --cov-fail-under=80` passes (144 tests,
    coverage about 99%).
3.  Real-model smoke test: `uv run pytest -m gpu -s` passes (8 tests): whisper `small`
    transcribes the Spanish and English clips with the right language, silence is empty, Kokoro
    synthesises Spanish, English and Catalan (Spanish voice) at 24 kHz, the fallback lines
    render, and the voices `ef_dora`, `em_alex`, `af_heart` exist.
4.  Tap before ready: right after the port opens, `E --expect-error not_ready` gets
    `error{not_ready}`, and `/readyz` is 503 until the models are loaded (7.6 s here).
5.  Spanish turn: `E --wav tests/clips/es.wav --expect ok` ends `turn_done` `ok`, the states go
    listening, thinking, speaking, the `tts` header is followed by one WAV frame (24 kHz, 3.86 s),
    and `timings` has the five keys.
6.  English turn: `E --wav tests/clips/en.wav --expect ok`, same checks (4.33 s of audio).
    The fake Hermes recorded both questions verbatim, one `X-Hermes-Session-Id` for both, and
    `Authorization: Bearer dev-key` (`curl localhost:18642/requests`).
7.  Silent utterance: `E --wav tests/clips/silence.wav --expect empty` and a zero-length
    utterance `E --empty --expect empty` both end `empty`, and the fake Hermes counts zero
    requests.
8.  Cancel and busy: `E --wav tests/clips/es.wav --busy-check --cancel-after 0.5 --expect cancel`:
    a tap from a second connection during the turn gets `error{busy}`, and the cancel ends the
    turn `cancel` with no audio.
9.  Hermes down (fake Hermes stopped): `E --wav tests/clips/en.wav --expect hermes_fail` gets the
    English fallback line as a `tts` frame (3.22 s), then `turn_done` `hermes_fail`.
10. Hermes slow (restarted with `BLOB_FAKE_MODELS=1 HERMES_TOTAL_S=1` and
    `fake_hermes.py --delay 3`): the turn ends `timeout` with `timeout_kind` `hermes` and the
    fallback line.
11. Wrong token: `hello` with a wrong token is closed with code 4401;
    `GET /device-config?device=tablet` without the token is 401, with it returns
    `{"sound": true, "wake": true, ...}` from `config/devices.example.json`.
12. Page: with `STATIC_DIR` pointing at a built page, `GET /` is 200 with
    `Cache-Control: no-cache` and hashed assets have no such header; without it, `GET /` is 404
    with "Page not built".
13. Timing line: `grep '"kind": "turn"' blob.log` shows one JSON line per turn with `reason`,
    `timeout_kind`, `lang` and the timings, and no user text. Example from step 5:

    ```json
    {"kind": "turn", "turn": 1, "reason": "ok", "timeout_kind": null, "lang": "es", "stt_ms": 5272, "hermes_ms": 4, "tts_ms": 2161, "first_audio_ms": 7438, "sc1_ms": 7938}
    ```

    `uv run python scripts/timings_report.py --db /tmp/blob.db` prints the `sc1_ms` median and
    the counts by reason and language.

### Part B: full S1 exit test (not run yet; needs the page, the GPU and the real Hermes)

From the design's Verification Plan. Run with the deployed or local backend on the GPU machine
(`STT_MODEL=large-v3`, `STT_COMPUTE=int8_float16`), the real Hermes, and the page in a desktop
browser.

1.  Ten spoken turns by tap, each ending with spoken audio and `turn_done` `ok`: 4 Spanish,
    3 English, 3 Catalan (including short commands). Record the detected language of each.
2.  One turn asking in Spanish for an English phrase: record whether the voice mismatches.
3.  A tap on silence: `empty`, no Hermes request, back to idle.
4.  Hermes failure (wrong `HERMES_URL` or Hermes stopped): grey overlay, spoken fallback, idle
    within the 75 s timeout plus the fallback audio.
5.  Stop and cancel taps: a tap while speaking stops playback and sends `cancel`; a tap while
    thinking ends the turn `cancel`.
6.  History: a follow-up question within 5 minutes is answered with context; after 5 minutes
    idle it is not.
7.  Each of the five states (idle, listening, thinking, speaking, error) shows its row of the
    state table.
8.  Peak GPU memory under 8 GB: `nvidia-smi --query-gpu=memory.used --format=csv -lms 500`
    during the turns.
9.  SC1: `uv run python scripts/timings_report.py --db /data/blob.db --last 20` reports the
    median and p90 of `sc1_ms` over 20 turns (about 6 s expected, no pass mark).

<!-- PAGE S3/S4 (web session). Kept here, away from the backend's S3/S4 sections, so the two
branches merge without a conflict; move it next to them after the merge if you like. -->

## S3 and S4: page exit test (web)

### Part A: page checks (run on 2026-11-13, headless Chromium, mock backend)

No tablet, no GPU, no real backend. Commit: see `docs/coordination/reports/web-s3-s4.md`.
From `web/` (`MOCK_PORT` only if 8787 is taken):

1.  `npm run lint`, `npm run typecheck`, `npm run build`: no errors. `npm test`: 17 files, 136 tests passed.
    S3/S4 unit tests: `state.test.ts` (alert precedence and hold), `taps.test.ts` (alert rows),
    `alert-reader.test.ts`, `audio/chime.test.ts` (once per alert, quiet hours, held during a
    turn), `render/tables.test.ts`, `render/morph.test.ts`, `wake/wake-gate.test.ts`,
    `vad.test.ts` (limits with an injected clock), `turn-client.test.ts` (wake, follow-up,
    zero-length utterance), `wake/oww.models.test.ts` (the real openWakeWord models on the
    synthetic clip, in Node).
2.  `MOCK_PORT=8797 npm run e2e`: 26 passed (2.5 min; 16 S1/S2 + 10 S3/S4). S3/S4 specs:
    *   `alerts.spec.ts`: an alert appears (view `alert`, shape uniform 1 = triangle, green colour
        uniform), an urgent calendar alert goes on top (morph seen with `0 < uMix < 1`, then
        shape 2 = square, red), clearing returns to the sphere; ordering (urgent first, then
        oldest); a tap sends `alert_read`, the returned WAV plays, `alert_ack` is sent only after
        playback ends; an alert raised during a turn is held until the turn ends; the chime plays
        once per alert on a `sound=true` device and is held during a turn; a failed synthesis
        keeps the alert, plays the beep and sends no `alert_ack` (mock only).
    *   `wake.spec.ts`: the fake microphone plays synthetic Kokoro "Hey Jarvis. What time is
        it?"; the page sends `wake{followup:false}` (nothing sent before it, one shared
        `getUserMedia`), the turn listens, the VAD sends the utterance without a stop tap.
    *   `vad.spec.ts`: a tap turn ends by itself after the spoken question; `tail_silence_ms`
        between 500 and 1500 ms.
    *   `no-speech.spec.ts`: silence for 8 s sends `utterance{dur_ms: 0}` with no binary frame and
        the turn ends `empty`; after a reply with `followup: true` the page sends
        `wake{followup: true}` once playback ends and sends a zero-length utterance after 6 s
        of silence (mock only).
3.  Screenshots: `npm run screenshots` writes `docs/screenshots/alert-*.png` (timer triangle
    info and urgent, calendar square, a frame mid-morph).

Against a real backend (not run here):
`BLOB_URL=http://host:port BLOB_TOKEN=<DEVICE_TOKEN> BLOB_ALERT_TOKEN=<ALERT_TOKEN> npx playwright test`.
The backend must serve the freshly built `web/dist`, and `config/devices.json` must list the
e2e devices: `hf-wake`, `hf-vad`, `hf-quiet` with `"wake": true`, `e2e-sound` with
`"sound": true`, the others (`e2e-alert-*`) with both false. Mock-only flows (synthesis
failure, follow-up) are skipped unless `BLOB_SCENARIOS=1`.

### Part B: page on the tablet (not run; needs the tablet and the deployment)

1.  Install with `#t=<DEVICE_TOKEN>&device=tablet` (`wake: true`, `sound: true`). Long press:
    the diagnostics view shows `wake: {ready: true, ...}` and `vad`.
2.  Say "hey blob" (the phrase in `web/public/models/wake.json`): the blob flashes and
    listens; ask a question and stop talking; the utterance is sent about 0.7 s after the end
    of speech. Say nothing after the wake word: back to idle after 8 s (`turn_done empty`).
3.  While a reply plays and for 0.5 s after it, saying the wake word does nothing.
4.  A question back from Hermes (reply ends with `?`): the microphone reopens for 6 s without
    the wake word; silence returns to idle; "sí" continues.
5.  `curl` an urgent timer alert: within 1 s the blob morphs to a red triangle pulsing about
    once a second and the chime plays once; an info calendar alert shows a green square
    pulsing half as fast. A tap reads the alert and clears it on every screen.
6.  Raise an alert during a turn: it shows, and chimes, only when the turn ends.
7.  Set `QUIET_HOURS` to include the current time: no chime, the alert still shows.
8.  On the desktop (`wake: false`, `sound: false`): no microphone until a tap, no chime, a
    follow-up `tts` is ignored.
9.  SC2 (with a trained "hey blob" model, see `docs/wake-word-training.md`): fewer than 1 false
    accept per day over 3 days with the TV on, fewer than 2 misses in 10 attempts.

<!-- /PAGE S3/S4 -->

## S2: tablet and deployment

*To be written in S2.*

## S3 and S4: backend exit test (run on 2026-11-13, CPU only, fake Hermes)

This part needs no page, no GPU, no tablet and no real Hermes. Every step passed on commit
`dc3e521` (branch `t3/blob-backend-s3-s4`). Setup, from `backend/`:

```sh
uv sync
uv run python scripts/make_test_clips.py --model-dir <MODEL_DIR>   # adds timer_es.wav
uv run python tests/fakes/fake_hermes.py --port 18642 &            # step 7: --mode question
COMMON="HERMES_URL=http://127.0.0.1:18642 HERMES_KEY=dev-key HERMES_MODEL=hermes-agent \
  DEVICE_TOKEN=devtoken ALERT_TOKEN=alerttoken STATIC_DIR=../web/dist \
  DEVICES_PATH=../config/devices.example.json PORT=18000"
A() { uv run python scripts/e2e_alerts.py --url ws://127.0.0.1:18000/ws --token devtoken \
  --alert-token alerttoken --hermes http://127.0.0.1:18642 "$@"; }
E() { uv run python scripts/e2e_turn.py --url ws://127.0.0.1:18000/ws --token devtoken "$@"; }
```

1.  Static checks: `uv run ruff check`, `uv run ruff format --check`, `uv run mypy blob` report
    no issues.
2.  Unit tests: `uv run pytest -m "not gpu" --cov --cov-fail-under=80`: 300 passed, coverage
    98.95%. New files: `test_alerts_api.py` (every rule of the contract table), `test_scheduler.py`
    (injected clock, 250 ms cap, late firing, `ttl_s`, 24 h after ack, restart with a real
    SQLite file and the app object restarted twice), `test_timer_rule.py`; additions to
    `test_hub.py` (wake gating, alerts in the snapshot, `alert_read`/`alert_ack`, a 1 s timer,
    the voice timer, `TIMER_RULE=off`), `test_turn.py` (follow-up flag, `FOLLOWUP_MAX` chain,
    10 s idle reset, timer rule), `test_db.py` (an S1 file opens with S4 code),
    `test_textclean.py` (`ends_with_question`), `test_config.py`, `test_protocol.py`.
3.  Fake models: `env $COMMON BLOB_FAKE_MODELS=1 BLOB_FAKE_TRANSCRIPT="pon un temporizador de 1
    minuto" DB_PATH=/tmp/fake.db uv run blob`, then `A`: 13/13 checks passed. Alert over HTTP
    seen in the snapshot of two connections after 6 ms; `alert_read` gave `tts{alert: key, turn:
    null, final: true}` and a 24 kHz WAV; `alert_ack` removed it from the snapshot and
    `GET /alerts` showed `acked`; `alert_read` of an unknown key gave `error{bad_message}`; a timer
    with `in_s: 2` fired after 1.58 s (whole-second `fire_at`) and the snapshot changed; the
    spoken timer turn ended `ok` with audio and `hermes_ms: null`, created
    `timer-<unix time>` pending 60 s ahead, and the fake Hermes counted 0 requests; `wake` from
    `desktop` got `bad_message` and from `tablet` opened a turn.
4.  Restart: with the same server, `POST` an urgent alert and a timer with `in_s: 4`, stop the
    server (SIGTERM), wait 6 s, start it again on the same `DB_PATH`. `GET /alerts` shows both
    `active`, and the first snapshot after `hello` lists the door alert (`late: false`) and the
    timer with `late: true` and `activated_at` equal to its `fire_at`.
5.  Real models: `env $COMMON STT_MODEL=small STT_COMPUTE=int8 MODEL_DIR=<MODEL_DIR>
    DB_PATH=/tmp/real.db uv run blob` (ready in 14.8 s), then
    `A --timer-wav tests/clips/timer_es.wav`: 13/13 checks passed. Whisper heard "Pon un
    temporizador de un minuto." (`es`, `stt_ms` 4226), the timer rule created
    `timer-1794524734` with `in_s` 60, the confirmation "Vale, temporizador de 1 minuto." was
    synthesised (`tts_ms` 637), and the fake Hermes counted 0 requests. `alert_read` gave a
    2.13 s Kokoro WAV. Then `E --wav tests/clips/es.wav --expect ok` still reached Hermes (1
    request, the exact transcript).
6.  Lines printed by the server for step 5:

    ```json
    {"kind": "timer_rule", "turn": 1, "key": "timer-1794524734", "in_s": 60}
    {"kind": "turn", "turn": 1, "reason": "ok", "timeout_kind": null, "lang": "es", "stt_ms": 4226, "hermes_ms": null, "tts_ms": 637, "first_audio_ms": 4864, "sc1_ms": 5364}
    ```

7.  Follow-up chain (fake models, fake Hermes `--mode question`, whose reply ends with `?`):
    `E --wav tests/clips/es.wav --device tablet --wake --expect ok --expect-followup true`,
    then three times `E ... --wake --followup` expecting `true`, `true`, `false` (the 4th reply in
    a row is capped by `FOLLOWUP_MAX=3`), then `E --device tablet --wake --followup --empty
    --expect empty` (no speech in the follow-up window), then a new chain gets `true` again. All
    passed. `E --device desktop --wake --expect-error bad_message` passed.
8.  `docs/alerts.md`: every `curl` command in it was run against the server (201, 201, 201, the
    Hermes skill's create with the `%{http_code}` line, list, `DELETE` 204 twice); a `fire_at`
    without an offset got 422 and a request without the token got 401. The Home Assistant YAML
    was not run.

### Full S3 exit test (not run; needs the page, the tablet and the wake word)

From the design. Run on the tablet with the deployed backend and the real Hermes.

1.  Follow-up: a reply that ends with a question opens the microphone for 6 s without the wake
    word; silence returns to idle; answering "sí" continues the conversation.
2.  Three days with the TV on: count wake-word false accepts (SC2: fewer than 1 per day) and
    misses (fewer than 2 in 10 attempts).
3.  Replay recorded TV or radio audio through the detector faster than real time, when the
    detector allows it (otherwise skipped).
4.  Manual: VAD limits (8 s no speech, 15 s total), microphone permission after a restart.

### Full S4 exit test (not run; needs the page and the deployment)

1.  An alert is visible after a pod restart.
2.  A voice timer works end to end: "pon un temporizador de 10 minutos", the triangle in red after
    10 minutes, a tap reads it and clears it; the same timer twice gives two timers.
3.  An alert from `curl` shows the right shape within 1 s (SC5), measured with `curl` timestamps
    against a 60 fps screen recording.
4.  Whether Hermes can create and cancel timers with the skill in `docs/alerts.md`; if it can,
    set `TIMER_RULE=off` and repeat item 2 through Hermes.
