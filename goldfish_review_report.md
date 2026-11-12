# Goldfish Annotated Review Report

**Status:** resolved (auto accept applied 2026-11-12; F-M3 and F-M17 answered by the author's delegation: kokoro-onnx chosen, cluster defaults marked ASSUMED)
**Target:** `/home/arnau/workspace/meet_blob/docs/designs/blob_design.md` (lines 541-1018, `## Detailed Implementation Plan` to the end)
**Source of findings:** `implementation_readiness_report.md`, Stage 9, round 1 (reviewers `egm-implementation-readiness`, `egm-codebase-details`, `egm-style`, all completed). The Stage 7 resolve report is kept as `goldfish_review_report_stage7.md`.

Counts: 2 Blocker, 27 Major, 7 Nit groups (F-M1 to F-M27, F-N1 to F-N7). Suggestions: 30 PROPOSE FIX, 2 ESCALATE, 0 CONTEST, 3 DECLINE (F-N1, F-N5, F-N7) and 1 partial DECLINE (F-N6). "#n" is the file number in the plan. Edits are applied from the bottom of the file upward.

**ESCALATE (need your knowledge, not only approval):**

*   **F-M3 (Kokoro package, WAV writer, system packages, CUDA image).** Two defensible choices and the evidence is outside the reviewers' files. Option 1: the PyTorch package `kokoro` with `soundfile` or the standard `wave` module; larger image, follows the main project. Option 2: `kokoro-onnx` with ONNX Runtime; smaller, a CPU path is easy, less common. Both are unverified here. Either may need the `espeak-ng` system package. Which do you want? I will not pick one for you.
*   **F-M17 (deploy facts that only you know).** Which ingress controller does the cluster use (nginx, Traefik, other)? Which namespace and storage class? Which GPU resource name (`nvidia.com/gpu`?) and CUDA version does the node driver support? What internal DNS name? The plan names none of these.

**Review these default-changing fixes first:** F-B1 (the page measures trailing silence and `utterance` carries it), F-B2 (`error` becomes a client-only overlay), F-M4 (`/healthz` always 200, new `/readyz`), F-M12 (the page enforces the 6, 8 and 15 s limits; the server keeps only the 30 s and 120 s watchdogs), F-M25 (drop `first_sentence_split` from S1), F-M26 (scheduler wakes at the next `fire_at`, 250 ms minimum poll).

---

## Blockers

### [Issue 1] [`egm-implementation-readiness`, `egm-codebase-details`, `egm-style`] F-B1 - Severity: Blocker
*   **Affected Scope:** #13, #21, #33, #52, #8; spec lines 41, 245, 494; S1 exit test
*   **Discrepancy Description:** SC1/G9 "last voiced frame" has no protocol field and no owner. `utterance` carries no trailing-silence value, `capture.ts` measures none in S1, and the `timings` keys are never defined.
*   ***AI Suggestion:*** PROPOSE FIX
*   ***Justification:*** Valid. The S1 exit test cannot be judged without it. The server's `utterance` arrival time is the zero point, and the page reports the silence it measured.
*   ***Proposed Edit:***
    *   Location: protocol table (`utterance`), SC1 text, #13, #21, #33, #52, Pipeline step 2.
    *   Change: `utterance` gains `dur_ms` and `tail_silence_ms`. "Last voiced frame" is the server arrival time of `utterance` minus `tail_silence_ms`. "First audio" is the server send time of the first `tts` frame. `capture.ts` computes `tail_silence_ms` as the time since the last 20 ms window whose RMS was above a threshold (config `silence_rms`, default 0.01), also in S1. `timings` keys: `stt_ms`, `hermes_ms`, `tts_ms`, `first_audio_ms` (utterance arrival to first `tts` send), `sc1_ms` (`first_audio_ms` plus `tail_silence_ms`). `timings_report.py` reads `sc1_ms`. Client and server clocks are never compared.

### [Issue 2] [`egm-implementation-readiness`, `egm-codebase-details`, `egm-style`] F-B2 - Severity: Blocker
*   **Affected Scope:** #22, #50, #51, #53, #56, #59; spec lines 115, 150-154
*   **Discrepancy Description:** The `error` state, its 3 s hold, the fallback-audio tap row and the `tts_fail` beep have no owner. The backend cannot know when client playback ended.
*   ***AI Suggestion:*** PROPOSE FIX
*   ***Justification:*** Valid. The spec already says `error` is an overlay; this makes it explicitly client-side.
*   ***Proposed Edit:***
    *   Location: state-machine table row `error`, #50, #51, #53, #59.
    *   Change: `error` is a client-only overlay. The backend never sends `conv = error`; `snapshot.conv` returns to `idle` when the lock is released. `state.ts` sets the overlay on `turn_done` with a reason other than `ok`, `empty` or `cancel`, and clears it when local playback is empty and 3 s have passed. #53 plays the beep when `turn_done.reason == tts_fail`. #51 and the tap table gain "tap during fallback audio stops it". Tests: `state.test.ts` (overlay set and cleared), `playback.test.ts` (beep), `taps.test.ts` (row).

---

## Major

### [Issue 3] F-M1 - Severity: Major
*   **Affected Scope:** #8, #9, #12, #13, #22/#80, #23/#85, #37, #45, #47, #51/#84, #53, #54/#74, #55/#83, #56/#83, #57, #59, #75/#81/#82/#87, #32
*   **Discrepancy Description:** Files are listed more than once, #80 and #83 bundle several files, and slice tags do not match what each slice edits.
*   ***AI Suggestion:*** PROPOSE FIX
*   ***Justification:*** Valid. A write allowlist built from the tags would block S3 work.
*   ***Proposed Edit:***
    *   Location: the entries named above.
    *   Change: one entry per file. Fold #80 into #22 and into #13/#23 (wake and follow-up), #85 into #23, #74 into #54, #83 into #55/#56/#51, #75/#81/#82 into #8, #87 into #9. Retag: #12 "S1, S2, S3, S4"; #13 "S1, S3, S4"; #23 "S1, S2, S3, S4"; #37 "S1, S3, S4"; #57 "S1, S3"; #51 "S1, S2, S4". The audio-locked tap row belongs to S2 only (move it out of S1's tests, #59). State which slice owns which protocol message (the table already has the slice column). #32 gets a `--token` argument for S2. Renumber the list.

### [Issue 4] F-M2 - Severity: Major
*   **Affected Scope:** #6, #12, #15, #17, #19, #83; Configuration
*   **Discrepancy Description:** Environment variable names, types and defaults are not defined.
*   ***AI Suggestion:*** PROPOSE FIX
*   ***Justification:*** Valid.
*   ***Proposed Edit:***
    *   Location: Configuration section; #12; #6; new `backend/tests/test_config.py`.
    *   Change: replace the prose with a table (name, type, default, slice): `HERMES_URL`, `HERMES_KEY`, `HERMES_MODEL` (required), `HERMES_HISTORY_MODE` (`session` or `replay`, default set by the S0 test), `HERMES_CONNECT_S` 5, `HERMES_TOTAL_S` 75, `HERMES_NO_BYTES_S` 30, `LISTEN_WATCHDOG_S` 30, `TURN_WATCHDOG_S` 120, `SESSION_IDLE_S` 300, `HISTORY_PAIRS` 6, `STT_MODEL` `large-v3`, `STT_COMPUTE` `int8_float16`, `NO_SPEECH_MAX` 0.6 (applied to the mean over segments in a function in `stt.py`), `SILENCE_RMS` 0.01, `KOKORO_DEVICE` `cuda`, `TTS_MAX_CHARS` 1200, `FOLLOWUP_MAX` 3, `FOLLOWUP_LISTEN_S` 6, `RETENTION_DAYS` 14, `HOST` `0.0.0.0`, `PORT` 8000, `DB_PATH`, `DEVICES_PATH`, `STATIC_DIR`, `QUIET_HOURS` (format `22:00-07:00`, server local time), `ALERT_TOKEN`, `DEVICE_TOKEN`, `FALLBACK_LINE_ES` and `FALLBACK_LINE_EN` (text in `voices.py`, not env). The urgency colours move from "config values" to constants in `tables.ts`. `.env.example` lists the S1 variables first and marks the later ones with their slice.

### [Issue 5] F-M3 - Severity: Major
*   **Affected Scope:** #10, #18, #61; spec Assumption 5
*   **Discrepancy Description:** The Kokoro package, WAV writer, system packages and CUDA image are left to the implementer.
*   ***AI Suggestion:*** ESCALATE
*   ***Justification:*** The critique is valid, but the choice depends on your preference between two packages and on facts about your GPU and node driver that no reviewer could read. See the question at the top.
*   ***Proposed Edit:***
    *   Location: #10, #18, #61.
    *   Change: after you choose: #10 names the package and `soundfile` or `wave`; #18 states the sample rate `tts()` returns; #61 installs `espeak-ng` if needed and names the CUDA base image tag. I will not edit until you answer.

### [Issue 6] F-M4 - Severity: Major
*   **Affected Scope:** #24, #63; spec Startup
*   **Discrepancy Description:** `/healthz` cannot drive Kubernetes probes (status code only), `hermes_reachable` is undefined, and nothing tests it.
*   ***AI Suggestion:*** PROPOSE FIX
*   ***Justification:*** Valid. This changes the earlier `/healthz` shape.
*   ***Proposed Edit:***
    *   Location: Startup bullet, #24, #63, new `backend/tests/test_main.py`.
    *   Change: `/healthz` always returns 200 while the process runs (liveness) and its JSON body includes `alive`, `ready` and `hermes_reachable`. `/readyz` returns 503 until the database is open and both models are loaded, then 200. `#63` uses `httpGet /healthz` for liveness, `httpGet /readyz` for readiness, and a `startupProbe` on `/readyz` with a long failure threshold (model load can take minutes). `hermes_reachable` is a background check every 30 s with a 3 s timeout against Hermes's `GET /health` (documented in the saved Hermes page; not run) and is shown in the body and the diagnostics view only. `test_main.py` checks the states and the startup order.

### [Issue 7] F-M5 - Severity: Major
*   **Affected Scope:** #47, #49, #51, #52
*   **Discrepancy Description:** No owner for the client turn controller (tap, wait for turn id, open microphone, stop, send).
*   ***AI Suggestion:*** PROPOSE FIX
*   ***Justification:*** Valid.
*   ***Proposed Edit:***
    *   Location: new entry `web/src/turn-client.ts` and `web/src/turn-client.test.ts` (S1); #47, #51.
    *   Change: `turn-client.ts` holds the explicit client turn table: on tap in `idle`, send `tap`; on the first `state` with `conv = listening` and a turn id, open the microphone (not before); on `error{busy}`, do nothing and show a short flash; on a double tap, ignore the second until `state` arrives; on microphone denial, send `cancel` and set the fault line (also in S1: `fault.ts` is needed in S1 for this, so move `fault.ts` to S1); on stop tap or the cap, send `utterance`. `main.ts` only wires it. #51 calls `turn-client`.

### [Issue 8] F-M6 - Severity: Major
*   **Affected Scope:** tests #35-#44, #59-#60
*   **Discrepancy Description:** Many spec behaviours have no test.
*   ***AI Suggestion:*** PROPOSE FIX
*   ***Justification:*** Valid. The list is long, so unlisted items are marked manual.
*   ***Proposed Edit:***
    *   Location: tests in the plan; Verification Plan.
    *   Change: add `test_main.py`, `test_config.py`, `test_devices.py`, `test_turnlog.py`, `test_gpu.py`; extend `test_hub.py` (1 MB frame, audio with no open turn, `bad_message`, message before `hello`, wake from a `wake=false` device), `test_hermes.py` (session rotation after 5 minutes, connect-timeout mapping), `test_turn.py` (`stt_fail` fallback language, `tts_max_chars` cut with and without a sentence boundary); add small vitest files for the version guard, token parsing, the 15 s cap and `fault.ts`. `fake_hermes.py` records headers and bodies, and its "no bytes" switch is used by a streaming test only when streaming exists (drop it from S1). Manual exit tests, listed in `docs/testing/exit-tests.md`: shader look, wake lock, `wakelock.ts`, VAD limits, microphone permission.

### [Issue 9] F-M7 - Severity: Major
*   **Affected Scope:** #14, #18, #23, #73; spec Startup, step 6
*   **Discrepancy Description:** Tap while models load, `tts_max_chars` truncation and the "Hermes down" fault text have no owning file.
*   ***AI Suggestion:*** PROPOSE FIX
*   ***Justification:*** Valid.
*   ***Proposed Edit:***
    *   Location: protocol table `error` codes; #14; #18; #73.
    *   Change: add error code `not_ready` (sent when `tap` arrives while `ready` is false); the page shows the grey blob. Truncation lives in #14 as `truncate_for_speech(text, max_chars)`: cut at the last sentence end before the limit; if none, cut at the last space before the limit; log the cut. The "Hermes down" fault text is removed from #73 and from the fault list; Hermes down is shown only in the diagnostics view through `hermes_reachable`.

### [Issue 10] F-M8 - Severity: Major
*   **Affected Scope:** #12, #26, #47, #50, #56, #67; spec chime and `quiet_hours`
*   **Discrepancy Description:** The chime and `quiet_hours` have no asset, client code or test.
*   ***AI Suggestion:*** PROPOSE FIX
*   ***Justification:*** Valid. The chime stays in S4 (Stage 7 decision), so it needs the pieces.
*   ***Proposed Edit:***
    *   Location: new entry `web/public/chime.wav` (S4) and `web/src/audio/chime.ts` (S4) with a test; #26; #12; #67.
    *   Change: `chime.wav` is a 0.4 s, 880 Hz sine with a short decay, generated once by a script in the repo (`scripts/make_sounds.py`, also used for `beep.wav`: 0.3 s, 440 Hz). `GET /device-config` returns `sound`, `wake` and `quiet_hours`; the page checks the time against `quiet_hours` in `chime.ts` (browser local time). `configmap.yaml` carries `QUIET_HOURS` from S2 onward and `config.py` reads it from S1. `chime.test.ts` covers quiet-hours logic and once-per-alert.

### [Issue 11] F-M9 - Severity: Major
*   **Affected Scope:** #19, #34, #36; spec Hermes bullets
*   **Discrepancy Description:** The Hermes request is under-specified (system message home, `model`, auth header, session ID, timeout mechanism, cancel handle, `lang` unused, both history modes built).
*   ***AI Suggestion:*** PROPOSE FIX
*   ***Justification:*** Valid.
*   ***Proposed Edit:***
    *   Location: #19, #34, #36.
    *   Change: the system message is a constant `SYSTEM_MESSAGE` in `hermes.py`, text in the plan. `model` comes from `HERMES_MODEL`. Auth is `Authorization: Bearer <HERMES_KEY>`. The session ID is `blob-<unix time of rotation>`. `ask(user_text)` drops `lang`. Total timeout is `asyncio.timeout(HERMES_TOTAL_S)` around the call and `httpx` `connect` timeout `HERMES_CONNECT_S`; a connect timeout maps to `hermes_fail`, the total timeout to `timeout`. `ask` runs as an `asyncio.Task` that `turn.py` can cancel; a cancelled task maps to `cancel`, not `hermes_fail`. Only the history mode chosen by the S0 test is built; the other is a few lines behind `HERMES_HISTORY_MODE`. `fake_hermes.py` records request headers and bodies.

### [Issue 12] F-M10 - Severity: Major
*   **Affected Scope:** #22, #23
*   **Discrepancy Description:** Hub routing and input validation are unspecified.
*   ***AI Suggestion:*** PROPOSE FIX
*   ***Justification:*** Valid.
*   ***Proposed Edit:***
    *   Location: #23 and `test_hub.py`.
    *   Change: add a table to #23 (input condition, response, effect on the lock): message before `hello` → close 4400; unknown type or bad JSON → `error{bad_message}`; `utterance` with no open turn, wrong turn id, bad `format` or `rate` → `error{bad_message}`, lock unchanged; frame over 1 MB → `error{bad_message}`, turn ends with `cancel`; `wake` from a device whose `wake` flag is false → `error{bad_message}`; WebSocket close → lock released, pipeline cancelled. Routing: `snapshot` and `state` go to all clients; `tts` and `turn_done` go to the client that started the turn (and `snapshot` to all). `turn_done` is sent once: `turn.py` guards it with a `done` flag against the cancel, watchdog and Hermes-error race. `turn.py` reads `wake` flags through a small function from `devices.py`.

### [Issue 13] F-M11 - Severity: Major
*   **Affected Scope:** #16, #22
*   **Discrepancy Description:** The GPU lock can release while the GPU thread is still running if the awaiting coroutine is cancelled.
*   ***AI Suggestion:*** PROPOSE FIX
*   ***Justification:*** Valid.
*   ***Proposed Edit:***
    *   Location: #16 and `test_gpu.py`.
    *   Change: `run_gpu` runs the thread work inside `asyncio.shield` and releases the lock only when the thread returns. `test_gpu.py` cancels the awaiting coroutine mid-call and checks that a second call waits for the first thread to finish.

### [Issue 14] F-M12 - Severity: Major
*   **Affected Scope:** #22, #48, #76, #80; spec step 8, Hands-free
*   **Discrepancy Description:** Follow-up and listen limits have no owner, and the end reason conflicts (client `cancel` gives `cancel`, not `empty`).
*   ***AI Suggestion:*** PROPOSE FIX
*   ***Justification:*** Valid. The server gets no audio until `utterance`, so a server timer would cut off a user who is still talking.
*   ***Proposed Edit:***
    *   Location: spec step 8, Hands-free bullets, #22, #48, #76, #80.
    *   Change: the page owns the 6, 8 and 15 s limits through the voice-activity detector. On no speech it sends an empty `utterance` (`dur_ms: 0`), which the server ends as `empty`. The server keeps only the 30 s listening and 120 s processing watchdogs. Remove the 6 s limit and the "follow-up with no speech ends as `empty`" case from #22 and #80's server tests. `config.ts` reads `followup_listen_s` and `listen_no_speech_s` from `GET /device-config`. `followup_max` is a counter per turn chain held in `turn.py`, reset when a turn that does not end with `?` finishes or after 10 s of idle. A tap-started turn on a `wake=false` device is allowed (taps always work).

### [Issue 15] F-M13 - Severity: Major
*   **Affected Scope:** #22, #37; failure table
*   **Discrepancy Description:** The listening watchdog outcome is undefined; the test expects `timeout` and a `timeout_kind` the spec does not list.
*   ***AI Suggestion:*** PROPOSE FIX
*   ***Justification:*** Valid.
*   ***Proposed Edit:***
    *   Location: failure table; step 5; #37.
    *   Change: add a failure row "listening watchdog (no `utterance` for 30 s) | `timeout` | nothing is spoken, back to idle". `timeout_kind` values: `hermes`, `turn`, `listen`. No fallback line plays for `listen`.

### [Issue 16] F-M14 - Severity: Major
*   **Affected Scope:** #13, #28, #42, #43, #84, #85, #86
*   **Discrepancy Description:** The alerts API contract is incomplete and uses two names for one action.
*   ***AI Suggestion:*** PROPOSE FIX
*   ***Justification:*** Valid.
*   ***Proposed Edit:***
    *   Location: alerts section of the spec; #13, #28, #42, #84, #85, #86.
    *   Change: add a contract table (to the spec, mirrored in `docs/alerts.md`): `POST` returns 201 for a new key and 200 for an update, body `{key, state, fire_at}`; both `fire_at` and `in_s` → 422; negative `in_s` or `fire_at` in the past → the alert becomes `active` immediately; no `fire_at` → `active` immediately; bad `urgency` → 422; `text` over 300 characters → 422; `key` limited to `[A-Za-z0-9._-]{1,64}`; a changed `fire_at` on a `pending` or `active` key updates the row; the cap of 20 counts `active` only; `DELETE` returns 204; `GET /alerts` returns an array of the same objects. `snapshot.alerts[]` items are `{key, source, urgency, text, lang, late, activated_at}`. `alert_read` on an unknown key or during a turn → `error{bad_message}`; if synthesis fails the client keeps the alert and plays the beep. Use `alert_read` and `alert_ack` everywhere ("clear" only for the user-visible result). Test cases for each rule in `test_alerts_api.py`.

### [Issue 17] F-M15 - Severity: Major
*   **Affected Scope:** #22, #29, #37, #44, #86; coverage list
*   **Discrepancy Description:** The timer rule is conditional in #29 and unconditional elsewhere, and its reply, key and parsing scope are undefined; the Hermes-side alerts artifact has no home.
*   ***AI Suggestion:*** PROPOSE FIX
*   ***Justification:*** Valid.
*   ***Proposed Edit:***
    *   Location: #22, #29, #37, #44, #86, Verification.
    *   Change: word #22, #37 and #44 as "only if the S0 test says Hermes cannot create timers" and tag them "S4, conditional"; the coverage list names `timer_rule.py` only when built. When the rule matches: Hermes is not called; the reply is a pre-rendered "Vale, temporizador de N minutos" (es) or "Okay, N minute timer" (en) via `tts()`; reason `ok`. Parsing scope: digits plus the words "un", "una", "dos" to "diez", "media hora"; units seconds, minutes, hours in es, ca and en; otherwise falls through to Hermes. The key is `timer-<unix time>`. `docs/alerts.md` contains the Hermes tool or skill text (a curl-style instruction block) as a copy-paste artifact.

### [Issue 18] F-M16 - Severity: Major
*   **Affected Scope:** #76, #77, #78, #45
*   **Discrepancy Description:** S3 is too vague to code (no chunk sizes, thresholds, debounce, port or package choice, asset locations, wake-gating tests).
*   ***AI Suggestion:*** PROPOSE FIX
*   ***Justification:*** Valid. Most of these values depend on the tablet test, so the honest fix is to say so and fix only what can be fixed now.
*   ***Proposed Edit:***
    *   Location: S3 entries #76-#78 and the Hands-free section.
    *   Change: mark S3 "parameters set after the tablet test". Add a new pure module `web/src/wake/wake-gate.ts` with `wake-gate.test.ts` (wake allowed only in `idle`, muted during playback plus 0.5 s, follow-up open and close, VAD limits). #77 lists parameters to set in `docs/spikes/tablet-test.md`: audio chunk size, score threshold, debounce and cooldown. #78 lists the exact files once chosen (`*.onnx` and wake model). Add a Vite copy rule for the ONNX Runtime and VAD wasm assets to #45. Replace "if the detector allows it" with "otherwise the replay is skipped".

### [Issue 19] F-M17 - Severity: Major
*   **Affected Scope:** #61-#68; spec Tablet and deployment
*   **Discrepancy Description:** The deploy manifests leave impactful choices open (ingress controller, ports, PVC size, namespace, mount paths, devices file mount, CUDA tag, UID, internal DNS).
*   ***AI Suggestion:*** ESCALATE
*   ***Justification:*** The ingress controller, namespace, storage class, GPU resource name, CUDA version and DNS name are facts about your cluster that no reviewer could read. I can fix the structural gaps now (ports, mounts, paths, UID) and leave your cluster facts as fields you fill in.
*   ***Proposed Edit:***
    *   Location: #61-#68.
    *   Change: the container listens on 8000; the Service port is 80 to 8000; models and the database mount at `/data` (PVC; size set by you); `/data/models` is the model cache; `config/devices.json` comes from a ConfigMap key `devices.json` mounted at `/config/devices.json` (`DEVICES_PATH`); the container runs as UID 10001 with a read-only root; Python and `uv` come from a multi-stage copy. Your answers fill: ingress class and WebSocket timeout annotation (#65), namespace, storage class and PVC size (#62), GPU resource name and CUDA tag (#61, #63), host name and DNS (#66, #68). I apply the structural part on approval and leave the others as marked `TODO(author)` fields.

### [Issue 20] F-M18 - Severity: Major
*   **Affected Scope:** #2, #3, #45, #69, #75
*   **Discrepancy Description:** The S0 stub cannot be built and has no Delete entry.
*   ***AI Suggestion:*** PROPOSE FIX
*   ***Justification:*** Valid.
*   ***Proposed Edit:***
    *   Location: #2, #3; new entry in S1.
    *   Change: the stub is a self-contained folder `spikes/tablet-stub/` outside `web/` with its own `package.json`, one `build` script (Vite) and a served HTTPS command using the certificate from `mkcert`. The wake engine under test is openWakeWord first ("hey jarvis" model), microWakeWord second. "Drops" is defined as a gap of more than 2 s with no audio frames from the worklet. The service-worker check from the spec moves into #2. A Delete entry (S1) removes `spikes/tablet-stub/` after the S0 record is written.

### [Issue 21] F-M19 - Severity: Major
*   **Affected Scope:** #61; Assumption 5
*   **Discrepancy Description:** The "both libraries load in one image" check is in S1 but the Dockerfile is in S2.
*   ***AI Suggestion:*** PROPOSE FIX
*   ***Justification:*** Valid.
*   ***Proposed Edit:***
    *   Location: Assumption 5; #61.
    *   Change: move the check to S2 ("S2 confirms that both libraries load in one image"). S1 keeps "tries Kokoro on the CPU first" because it runs on the desktop.

### [Issue 22] F-M20 - Severity: Major
*   **Affected Scope:** #20, #21, #33, #74
*   **Discrepancy Description:** `client_event` does not fit the `turns` table, and the frame-time tiers are unspecified.
*   ***AI Suggestion:*** PROPOSE FIX
*   ***Justification:*** Valid.
*   ***Proposed Edit:***
    *   Location: protocol table `client_event` row; Data section; #20, #21, #54.
    *   Change: `client_event` goes to standard output as a JSON line (`kind: client_event`) and is not persisted. #20 defines `turns` columns: `turn_id` (integer, autoincrement), `ts` (UTC epoch), `lang`, `user_text`, `reply_text`, `reason`, `timeout_kind`, `timings` (JSON); `PRAGMA user_version` 1 in S1 and 2 when S4 adds `alerts`. `test_db.py` opens an S1 file with S4 code and checks that an older image still opens a newer file. The renderer uses one fixed scale (0.75) and the 30 fps idle cap; the "quality tiers by measured frame time" are dropped. The page sends frame time to the diagnostics view only.

### [Issue 23] F-M21 - Severity: Major
*   **Affected Scope:** #25, #26, #41
*   **Discrepancy Description:** `/device-config` auth is missing from the plan.
*   ***AI Suggestion:*** PROPOSE FIX
*   ***Justification:*** Valid.
*   ***Proposed Edit:***
    *   Location: #25, #26, #41.
    *   Change: #25 adds a dependency for the device token on HTTP routes; #26 applies it to `GET /device-config`; #41 tests a missing and a wrong token on that route.

### [Issue 24] F-M22 - Severity: Major
*   **Affected Scope:** #5, #7, #10, #40, #45, #58, #69, #78
*   **Discrepancy Description:** Support files are missing, the `clips` ignore path is wrong (a pattern with a slash in the middle is anchored to the root), and globs name knowable files.
*   ***AI Suggestion:*** PROPOSE FIX
*   ***Justification:*** Valid. Checked against gitignore rules: `tests/clips/` matches only `tests/clips/` at the repository root; the folder is `backend/tests/clips/`.
*   ***Proposed Edit:***
    *   Location: #5, #7, #10, #40, #45, #58, #69, #78; new entries.
    *   Change: `.gitignore` uses `**/tests/clips/` and `**/clips/`. New entries: `web/eslint.config.js` (S1), `backend/tests/conftest.py` (S1; pytest-asyncio mode `auto`, `gpu` marker), `backend/.python-version` (3.11), `web/vite-env.d.ts` (GLSL `?raw` imports, S1), `backend/tests/fixtures/` listing `short_es.wav`, `short_en.wav`, `short_ca.wav`, `silence.wav` (S1), a vitest `jsdom` environment line in `vite.config.ts` (#45), shared protocol types: TypeScript types in `web/src/protocol.ts` written by hand to match `schemas.py`, with a test that compares the message names to a JSON list generated from the Pydantic models. `web/public/icons/` and `web/public/models/` become named files (`icon-192.png`, `icon-512.png`; the wake model files named after the tablet test). `beep.wav` and `chime.wav` come from `scripts/make_sounds.py` (see F-M8). One shared `AudioContext` for capture and playback is stated in #52 and #53. Worklet bundling is set up in #45 in S1.

### [Issue 25] F-M23 - Severity: Major
*   **Affected Scope:** #10, #12, #24, #45, #48
*   **Discrepancy Description:** Config and tooling staging contradictions (static directory in S1 vs S2, `run()` undefined, dev proxy list, device name source, "daily task" wording).
*   ***AI Suggestion:*** PROPOSE FIX
*   ***Justification:*** Valid.
*   ***Proposed Edit:***
    *   Location: #10, #12, #24, #45, #48.
    *   Change: `STATIC_DIR` is in #12 from S1. `run()` starts uvicorn with `HOST` and `PORT`. The Vite proxy lists `/ws`, `/device-config`, `/healthz`, `/readyz` and `/alerts` from S1. In S1 the device name comes from a static default in `config.ts`; S2's `token.ts` sets it. #24 says "at startup and every 24 h" for the retention task. "(S2)" in #24 is moved to its own sentence for the no-cache header.

### [Issue 26] F-M24 - Severity: Major
*   **Affected Scope:** Verification Plan; #7, #10
*   **Discrepancy Description:** The verification section is uncalibrated (coverage tool missing, one bullet with about 10 pass criteria, hedged conditions, vague values).
*   ***AI Suggestion:*** PROPOSE FIX
*   ***Justification:*** Valid.
*   ***Proposed Edit:***
    *   Location: Verification Plan; #7; #10.
    *   Change: add `pytest-cov` to #10 and `--cov-fail-under=80` on the listed modules in #7's `pytest` command. Move the S1 exit test into a numbered list in `docs/testing/exit-tests.md` (#8) and have the Verification Plan link to it. One pass condition for history: "a follow-up question within 5 minutes is answered with context; after 5 minutes idle it is not" (the S0 test settles the mechanism first). "Within the timeout" becomes "within the 75 s Hermes timeout plus the fallback audio". "Several days" becomes "3 days" in S3. The urgent pulse is "twice the rate of info" (a constant in `tables.ts`).

### [Issue 27] F-M25 - Severity: Major
*   **Affected Scope:** #14, #35; Alternative Q
*   **Discrepancy Description:** `first_sentence_split` is built in S1 but unused until streaming.
*   ***AI Suggestion:*** PROPOSE FIX
*   ***Justification:*** Valid. It contradicts the deferral.
*   ***Proposed Edit:***
    *   Location: #14, #35.
    *   Change: drop `first_sentence_split` and its tests from S1. It is built when sentence streaming starts (Future Improvements).

### [Issue 28] F-M26 - Severity: Major
*   **Affected Scope:** #28, #82; G6, SC5
*   **Discrepancy Description:** A once-per-second poll plus a broadcast can exceed 1 s from `fire_at`, and the 1 s has no measurement method.
*   ***AI Suggestion:*** PROPOSE FIX
*   ***Justification:*** Valid.
*   ***Proposed Edit:***
    *   Location: scheduler paragraph; #28; #8 (S4 exit test).
    *   Change: the scheduler computes the earliest `pending` `fire_at` and sleeps until then, with a 250 ms cap on the sleep so a new timer is seen quickly. The S4 exit test measures the delay with `curl` timestamps against a screen recording at 60 fps.

### [Issue 29] F-M27 - Severity: Major
*   **Affected Scope:** #8, #74, #80, #83, #84, #85
*   **Discrepancy Description:** Duplicate entries contradict base entries; dangling references ("the S1 test from the Technical Plan", "as approved", "protocol table in the schemas").
*   ***AI Suggestion:*** PROPOSE FIX
*   ***Justification:*** Valid. Most is fixed by the merge in Issue 3.
*   ***Proposed Edit:***
    *   Location: #8, #56, #85.
    *   Change: #8 refers to the numbered S1 exit test list in `docs/testing/exit-tests.md`. "Urgency colours as approved" becomes "green and red, constants in `tables.ts`". The `alert_read` and `alert_ack` schemas are named in #13.

---

## Nits

### [Issue 30] F-N1 - Severity: Nit
*   **Affected Scope:** #20, #21, #50, #51, #52, #54-#57, #72
*   **Discrepancy Description:** Small spec and schema gaps (`seq`, `final`, turn id format, page version source, mirror view, colour values, uniform names, shader licences, long-press duration, resampling method).
*   ***AI Suggestion:*** DECLINE (partly applied elsewhere)
*   ***Justification:*** These are values to record when they are chosen during the build. The turn id format (integer) and the page version source (injected at build from `__init__.py`) are added as one line each in #20 and #72 because other fixes need them. A mirror that never played audio shows `speaking` from `snapshot.conv` and clears it on the next snapshot.
*   ***Proposed Edit:*** none beyond the two one-line additions above.

### [Issue 31] F-N2 - Severity: Nit
*   **Affected Scope:** #17
*   **Discrepancy Description:** STT warm-up with one second of silence while `vad_filter` is on may skip the model call.
*   ***AI Suggestion:*** PROPOSE FIX
*   ***Justification:*** Cheap and harmless.
*   ***Proposed Edit:***
    *   Location: #17.
    *   Change: `warmup()` transcribes `fixtures/short_es.wav` with `vad_filter=False`.

### [Issue 32] F-N3 - Severity: Nit
*   **Affected Scope:** #1, #2
*   **Discrepancy Description:** S0 has record templates only, with no procedure and no outcome branches.
*   ***AI Suggestion:*** PROPOSE FIX
*   ***Justification:*** Valid and short.
*   ***Proposed Edit:***
    *   Location: #1, #2.
    *   Change: #1 gains short steps: `curl` a plain request, then with a system message, then with `X-Hermes-Session-Id` twice, then a request that calls a tool, then a `curl` from the Hermes host to a test `/alerts` endpoint. Branches: "system message ignored" → put the instruction in the user message; "reply not plain text" → strip it in `clean_for_speech` and note it; "header does not keep a session" → set `HERMES_HISTORY_MODE=replay`. #2 adds a kill rule line referring to the Hands-free section.

### [Issue 33] F-N4 - Severity: Nit
*   **Affected Scope:** build order (line 550); #4
*   **Discrepancy Description:** The S1 build order omits `textclean`, `voices`, `gpu`, `db` and `turnlog`, and puts `main` before `db`. The README mentions the timing line before its fields are fixed.
*   ***AI Suggestion:*** PROPOSE FIX
*   ***Justification:*** Valid.
*   ***Proposed Edit:***
    *   Location: build order.
    *   Change: S1 order: repository files, `config`, `schemas`, `textclean`, `voices`, `gpu`, `db`, `turnlog`, `main` (with `/healthz`, `/readyz` and a logging `/ws`), `stt` and `stt_cli`, `hermes` and tests, `tts` and `tts_cli`, `turn` and `hub`, the page, error paths, exit test. The README timing-line paragraph is written after F-B1's fields are fixed.

### [Issue 34] F-N5 - Severity: Nit
*   **Affected Scope:** #7
*   **Discrepancy Description:** `uv sync` in CI likely pulls the faster-whisper and Kokoro dependency tree even though GPU tests are skipped.
*   ***AI Suggestion:*** DECLINE
*   ***Justification:*** A size concern, not a defect, and unverified. CI can use `uv sync --extra dev` later if it becomes slow.
*   ***Proposed Edit:*** none.

### [Issue 35] F-N6 - Severity: Nit
*   **Affected Scope:** lines 543, 549, 572, 609, 644, 836, 970, 982, 1011-1012
*   **Discrepancy Description:** Vague wording and inconsistent terms ("simple animated canvas", "the metal look", "visibly changes", "kill rule", "voice filter", "button mode", "clear", "exact package confirmed in the TTS step").
*   ***AI Suggestion:*** PROPOSE FIX for the terms; DECLINE for rewording every phrase
*   ***Justification:*** One term per thing is worth fixing; polishing every sentence is not.
*   ***Proposed Edit:***
    *   Location: the terms named.
    *   Change: "kill rule" and "kill-spikes" become "S0 spike" and "S0 rule"; "voice filter" becomes "voice-activity filter (`vad_filter`)"; "button mode" becomes "tap or hardware-button mode"; "visibly changes in all five states" becomes "each of the five states shows its row of the state table"; "simple animated canvas" loses "simple".

### [Issue 36] F-N7 - Severity: Nit
*   **Affected Scope:** #15
*   **Discrepancy Description:** `clean_for_speech` rules and the `?` detection are unspecified.
*   ***AI Suggestion:*** DECLINE
*   ***Justification:*** Accept a first version and test it with real Hermes replies. The tests in #35 are written from replies seen during S0.
*   ***Proposed Edit:*** none.
