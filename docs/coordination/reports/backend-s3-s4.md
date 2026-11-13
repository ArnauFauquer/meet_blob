# Backend report: S3 and S4

*   **Branch:** `t3/blob-backend-s3-s4`, from local `main` at `e2a9f79`. Nothing pushed or merged.
*   **Commits:** `3185005` (alerts API, scheduler, timer rule, wake, follow-up), `6645260` (tests),
    `a9be003` (bounds on alert times, write before the mirror), `dc3e521` (e2e scripts),
    `af55964` (docs), and the commit that adds this report.
*   **Date:** 2026-11-13, machine with no GPU (12 CPUs), Python 3.12 through uv.

## What was built

*   `backend/blob/alerts.py` (new): alert store (SQLite plus a dict mirror, one asyncio lock),
    `POST`/`GET`/`DELETE /alerts` behind `ALERT_TOKEN`, scheduler (`min(250 ms, time to next)`),
    late firing on startup, `ttl_s` from activation, deletion 24 h after ack, a snapshot broadcast
    on every change.
*   `backend/blob/timer_rule.py` (new): Spanish, Catalan and English timer phrases, behind
    `TIMER_RULE` (default `on`).
*   `db.py`: `alerts` table, `user_version` 1 to 2. `schemas.py`: `Wake`, `AlertRead`, `AlertAck`,
    `AlertIn` (contract validation), `AlertOut`. `config.py`: `ALERT_TOKEN` (required),
    `FOLLOWUP_MAX`, `TIMER_RULE`. `auth.py`: `require_alert_token`. `textclean.py`:
    `ends_with_question`. `turn.py`: follow-up flag and chain counter, timer rule before Hermes,
    `synth()` for `alert_read`. `hub.py`: `wake` (devices.json gate), `alert_read`, `alert_ack`,
    `snapshot.alerts[]`, `broadcast_snapshot()`. `main.py`: wiring, router, scheduler task.
*   Scripts: `scripts/e2e_alerts.py` (new), `e2e_turn.py` (`--wake`, `--followup`,
    `--expect-followup`), `make_test_clips.py` (`timer_es.wav`). Fake Hermes: `--mode question`.
*   Docs: `docs/alerts.md` (contract, `curl`, Home Assistant `rest_command`, Hermes skill),
    `docs/testing/exit-tests.md` (S3/S4 sections), `docs/notes/backend-s3-s4.md` (26 decisions),
    `README.md` and `.env.example` (`ALERT_TOKEN` required, new settings).

## Definition of Done

| Item | Result |
| --- | --- |
| `ruff check`, `ruff format --check`, `mypy blob` (strict) | PASS, no issues |
| `pytest -m "not gpu" --cov --cov-fail-under=80` | PASS, 300 passed (S1 had 144), coverage 98.95% |
| Tests cover contract table, scheduler (injected clock), restart, hub rules, follow-up, chain guard, timer rule | PASS (list in exit-tests step 2) |
| Real `uv run blob`, `BLOB_FAKE_MODELS=1`, e2e flows of item 5 | PASS, `e2e_alerts.py` 13/13 |
| Real `uv run blob`, `STT_MODEL=small STT_COMPUTE=int8`, spoken timer clip | PASS, 13/13, no Hermes call |
| Restart with a real process and SQLite file | PASS, timer due during downtime fired once, `late: true` |
| Follow-up chain over a real socket | PASS, true/true/true/false, reset by an empty follow-up |
| `docs/alerts.md` | PASS, every `curl` command run against the server |
| `docs/testing/exit-tests.md` S3/S4 sections | PASS, lists what was run |

Commands and outputs are in `docs/testing/exit-tests.md`, section "S3 and S4: backend exit test".
The unit suite ran 8 times in a row with no failure.

## Contract notes for the coordinator

1.  **`alert_read` synthesis failure has no error code.** The backend sends `error{bad_message}`
    (and `error{not_ready}` while the models load). The page's rule "keep the alert, play the
    beep, send nothing" fits any error answer. If the page needs to tell the cases apart, the
    contract needs a new code.
2.  **`protocol/messages.json` `http` section does not list `/alerts`.** Not changed (not mine);
    the contract is in the design and in `docs/alerts.md`.
3.  **`tts.followup` is set for any device**, as the design says. A desktop page (`wake=false`)
    must ignore it: its `wake{followup: true}` gets `bad_message`.
4.  **`ALERT_TOKEN` is now required at startup** (design). Any local run or CI job that starts the
    server needs it. The deploy secret already has it.

## Not tested, and why

*   GPU path, real Hermes, real voices: no GPU, no cluster access by rule. The real-model run used
    whisper `small` on the CPU and Kokoro-made clips.
*   Whether Hermes can follow the skill in `docs/alerts.md` (the S0 Hermes test). The skill file
    format is the common `SKILL.md` layout and is unverified against the deployed Hermes.
*   The Home Assistant YAML was not run.
*   The page side of S3/S4 (wake word, VAD limits, chime, shapes, quiet hours) belongs to the web
    session.
*   `NaN`/`Infinity` in a `POST /alerts` body (not valid JSON) are refused by validation but get
    500 from FastAPI's error renderer instead of 422; no row is stored (notes, item 8).
*   `pytest -m gpu` was not re-run: `stt.py` and `tts.py` did not change.
