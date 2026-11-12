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

## S2: tablet and deployment

*To be written in S2.*

## S3: hands-free

*To be written in S3.*

## S4: alerts and timers

*To be written in S4.*
