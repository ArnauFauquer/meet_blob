# Goldfish Review Report

**Target:** `/home/arnau/workspace/meet_blob/docs/designs/blob_design.md` (`lines 541-1018`, section "## Detailed Implementation Plan" to end)

**Stage:** 9 (Implementation Readiness Test), round 1
**Verdict:** not ready. 2 Blockers, 25 Majors, 7 Nit groups.

Notes:
- "#n" is the item number in the plan's file list. Line numbers are those the reviewers gave.
- No reviewer could open URLs. Claims about Kokoro, faster-whisper, openWakeWord, vad-web, ONNX Runtime Web, ingress annotations and the tablet are **unverified**.
- Hermes facts (`POST /v1/chat/completions`, `X-Hermes-Session-Id`, `GET /health`) were checked only against `review_context/hermes-api-server.html`. That is third-party documentation, not a run against a real Hermes.
- Each finding lists the source reviewer ids. Where reviewers disagreed on severity, the highest was kept and the disagreement is noted.

## Reviewer Status

| Reviewer | Status |
| --- | --- |
| `egm-implementation-readiness` | completed |
| `egm-codebase-details` | completed |
| `egm-style` | completed |

## Prioritized Findings (Blockers -> Major -> Nits)

### F-B1. SC1/G9 "last voiced frame" timing has no protocol field and no owner - Severity: Blocker
* **Reviewer Lens:** `egm-implementation-readiness` (egm-implementation-readiness-1-1), `egm-codebase-details` (egm-codebase-details-1-1), `egm-style` (egm-style-1-1)
* **Affected Scope:** #13, #21, #33, #52, #8; spec lines 41, 245, 494; S1 exit test line 1011
* **Discrepancy Description**: SC1 and G9 measure from the last voiced frame to the first audio out. The spec defines this as a page timestamp minus the measured trailing silence. The `utterance` message carries only `turn`, `format` and `rate`, so the page cannot send the value. `capture.ts` (#52) measures no silence in S1 (the voice-activity detector arrives in S3) and no algorithm or threshold is given. Page and server clocks differ. "First audio out" could mean server send time or client playback start. `timings_report.py` (#33) reads a `timings` value whose keys are never defined. The S1 exit test cannot be passed or judged.
* **Rationale & Recommendation**: Add `utterance.tail_silence_ms` (and `dur_ms`). Take the server's `utterance` arrival time as the zero point. Define "first audio" as the server send time of the first `tts` frame. Define the trailing-silence algorithm in `capture.ts` (for example an RMS threshold over 20 ms windows). List the `timings` keys (`stt_ms`, `hermes_ms`, `tts_ms`, `first_audio_ms`). Update #13, #21, #33, #52. The alternative is to redefine SC1 as stop-tap to first audio.

### F-B2. The `error` state, its 3 s hold, the fallback audio exception and the `tts_fail` beep have no owner - Severity: Blocker
* **Reviewer Lens:** `egm-implementation-readiness` (egm-implementation-readiness-1-2), `egm-codebase-details` (egm-codebase-details-1-9, rated Major), `egm-style` (egm-style-1-2, rated Major)
* **Affected Scope:** #22, #50, #53, #51, #56, #59; spec lines 115, 150-154; S1 exit test line 1011
* **Discrepancy Description**: The spec has the backend leave `error` once the fallback audio has ended and at least 3 s have passed. The backend cannot know when client playback ended, and the protocol has no "playback ended" message. `state.ts` (#50) lists precedence "offline, turn, alert, idle" with no error overlay or 3 s timer. `taps.ts` (#51) and the tap table lack the "tap during fallback audio stops it" row. The local beep on `tts_fail` (#53) has no trigger. No test covers any of it. The S1 exit line "grey blob, spoken fallback and idle" cannot be implemented without choosing an owner.
* **Rationale & Recommendation**: Make `error` a client-only overlay. Set it in `state.ts` on `turn_done` with a failure reason. Clear it when local playback is empty and 3 s have passed. State that `snapshot.conv` returns to `idle` when the lock is released. Key the beep off `turn_done.reason == tts_fail` in #53. Add `state.test.ts`, `taps` and `playback.test.ts` rows.

### F-M1. Files are listed more than once, and slice tags do not match the edits - Severity: Major
* **Reviewer Lens:** `egm-implementation-readiness` (egm-implementation-readiness-1-3), `egm-codebase-details` (egm-codebase-details-1-2, egm-codebase-details-1-3), `egm-style` (egm-style-1-9 duplicate-entry part, egm-style-1-10)
* **Affected Scope:** lines 552-553, 559-987; #12, #13, #22/#80, #23/#85, #37, #45, #47, #51, #53, #54/#74, #55/#83, #56/#83, #57, #59, #8/#75/#81/#82, #9/#87, #32
* **Discrepancy Description**: The "each file once with a slice tag" rule fails. Duplicates: `turn.py` (#22, #80), `hub.py` (#23, #85), `blob.ts` (#54, #74), `tables.ts` (#56, #83), `blob.frag` (#55, #83), `taps.ts` (#51, #84), `exit-tests.md` (#8, #75, #81, #82), `runbook.md` (#9, #87). #80 and #83 bundle several files. #80 edits `schemas.py`, `hub.py`, `config.py` and `test_turn.py` for S3, but their own entries are tagged S1/S2/S4 only (#12 "S2, S4", #13 "S4", #23 "S2, S4", #37 "S4"). #57 adds the wake-word score in S3 but `diag.ts` is tagged S1. #22/#37 add the timer rule in S4 unconditionally while #29 makes it conditional. #59 (S1) tests the audio-locked row that exists only from S2. #51 files the audio-locked tap row under S4 while #53 adds audio-locked in S2. #13 says S1 `schemas.py` covers every message, but #85 says `alert_read` and `alert_ack` are "added" in S4. #32 `e2e_turn.py` is S1 only but S2 token checks need a `--token` argument. A write allowlist built from the tags would block S3 work.
* **Rationale & Recommendation**: One entry per file. Fold each duplicate into its base entry with "Modify in S2, S3, S4" tags and per-slice bullets. State which slice owns which protocol message. Split #83 and #80 per file. Add `--token` to #32.

### F-M2. Environment variable names, types and defaults are not defined - Severity: Major
* **Reviewer Lens:** `egm-implementation-readiness` (egm-implementation-readiness-1-4), `egm-style` (egm-style-1-8), `egm-codebase-details` (egm-codebase-details-1-17 threshold part, egm-codebase-details-1-19 per-slice part)
* **Affected Scope:** #6, #12, #15, #17, #19, #83 (line 982); spec line 320
* **Discrepancy Description**: The Configuration section is prose, and #6 and #12 say "every variable from the Configuration section". Missing: exact names; the no-speech threshold and how it aggregates over Whisper segments (#17); STT model and compute-type defaults; Kokoro device (cuda or cpu); host and port; `quiet_hours` format and timezone; database, devices file and static directory paths; the history-mode switch; the 5-minute session rotation and 6-pair cap; 14-day retention; `listen_watchdog_s`, `turn_watchdog_s`, `followup_*`; fallback line text per language (`es`, `en`); urgency colours ("both are config values", but they sit in `tables.ts`). `.env.example` (S1) is meant to hold every variable including S2-S4 ones, and `config.py` adds them per slice without a list.
* **Rationale & Recommendation**: Add one table (name, type, default, example, slice) to #12 or the Configuration section. Add a `test_config.py` row. Move the no-speech threshold decision into a testable function in `turn.py` or `stt.py`.

### F-M3. Dependency choices are left to the implementer (Kokoro package, WAV writer, system packages, CUDA image) - Severity: Major
* **Reviewer Lens:** `egm-implementation-readiness` (egm-implementation-readiness-1-5), `egm-codebase-details` (egm-codebase-details-1-17)
* **Affected Scope:** #10, #18, #61; spec line 328
* **Discrepancy Description**: #10 says the Kokoro package is "confirmed in the TTS step". The choice changes the GPU/CPU path, sample rate and WAV step. The `espeak-ng` system package may be needed for Spanish (unverified) and neither the Dockerfile nor the README mentions it. The standard library `wave` would do for WAV writing but is not named.
* **Rationale & Recommendation**: Pick the package. State the sample rate `tts()` returns, the WAV writer, and the system packages the Dockerfile installs.

### F-M4. `/healthz` cannot drive Kubernetes probes, `hermes_reachable` is undefined, and nothing tests it - Severity: Major
* **Reviewer Lens:** `egm-implementation-readiness` (egm-implementation-readiness-1-6), `egm-codebase-details` (egm-codebase-details-1-13), `egm-style` (egm-style-1-5)
* **Affected Scope:** #24 (line 679), #63 (line 878); spec line 308
* **Discrepancy Description**: An `httpGet` probe judges only the status code, but `/healthz` returns `alive`, `ready` and `hermes_reachable` fields. Model loading may outlast a default probe window and no `startupProbe` is mentioned. How `hermes_reachable` is computed (URL, interval, timeout) is not stated. The Hermes docs list `GET /health` (hermes-api-server.html line 249; not run). `main.py` is excluded from coverage and no test checks the states or startup order.
* **Rationale & Recommendation**: Pick one shape, for example `/healthz` returns 200 always (liveness) and `/readyz` returns 503 until models load. Add a `startupProbe` to #63. Name the Hermes probe route and interval. Add `test_main.py`.

### F-M5. No owner for the client turn controller - Severity: Major
* **Reviewer Lens:** `egm-implementation-readiness` (egm-implementation-readiness-1-7)
* **Affected Scope:** #47, #49, #51, #52; spec lines 161, 259
* **Discrepancy Description**: The spec sequence is tap, wait for the first `state` that carries the turn id, open the microphone, stop on the second tap or the 15 s cap, send `utterance` plus the binary frame. `taps.ts` is gestures, `capture.ts` is audio, `main.ts` only "wires". Undecided: whether the microphone opens before or after `state: listening`; behaviour on `error{busy}`, a double tap, or microphone denial (`fault.ts` is S2, so in S1 the turn sits until the 30 s watchdog); how the 15 s cap ties to the `utterance` send.
* **Rationale & Recommendation**: Add `web/src/turn-client.ts` with an explicit state table, `getUserMedia` failure sending `cancel`, and `turn-client.test.ts`.

### F-M6. Spec behaviours without a test - Severity: Major
* **Reviewer Lens:** `egm-implementation-readiness` (egm-implementation-readiness-1-8), `egm-codebase-details` (egm-codebase-details-1-14, egm-codebase-details-1-20), `egm-style` (egm-style-1-20 partial)
* **Affected Scope:** tests #35-#44, #59-#60; #36, #37
* **Discrepancy Description**: No test covers: `/healthz` states; `config.py` validation; `devices.py` and `GET /device-config` (unknown device false/false, missing or bad token, malformed `devices.json`); the static `index.html` served with `Cache-Control: no-cache`; "standard output carries timings only" (#21); `gpu.py` serialisation; `tts_max_chars` truncation and its log line; the 1 MB frame rejection; audio dropped when no turn is open; `bad_message`; the beep on `tts_fail`; `stt_fail` (and the fallback language when STT failed); the connect-timeout mapping; `X-Hermes-Session-Id` rotation after 5 minutes. On the page: the version reload guard, `token.ts` hash parsing and removal, the 15 s cap and 16 kHz resampling, `wakelock.ts`, `fault.ts`, VAD limits, the `device-config` fetch. The "no bytes" switch in `fake_hermes.py` (#34) is used by no test.
* **Rationale & Recommendation**: Add `test_main.py`, `test_config.py`, `test_devices.py`, `test_turnlog.py`, `test_gpu.py`; extend `test_hub.py`, `test_hermes.py`, `playback.test.ts`; add small vitest cases for the version guard, token parsing and cap/resample logic. Say explicitly which items stay manual exit tests.

### F-M7. Spec behaviours that no file owns (tap while models load, truncation, "Hermes down") - Severity: Major
* **Reviewer Lens:** `egm-implementation-readiness` (egm-implementation-readiness-1-9), `egm-codebase-details` (egm-codebase-details-1-12 part, egm-codebase-details-1-13 part), `egm-style` (egm-style-1-2 part)
* **Affected Scope:** #14, #18, #23, #73; spec lines 308, 328
* **Discrepancy Description**: (a) A tap while models load should show a grey blob (spec 308), but the only error codes are `busy` and `bad_message`, and the page has no readiness signal. (b) `tts_max_chars` truncation is in no file, and the case with no sentence end before the limit is undefined. (c) The "Hermes down" fault text (#73) has no data source: `snapshot` has no field and the page does not call `/healthz`.
* **Rationale & Recommendation**: Assign each to a file and a test row. Add a `not_ready` error code or a `snapshot` flag. Put truncation in #14 or #18 with the no-boundary rule. Drop "Hermes down" from #73 or name the message that carries it.

### F-M8. Alert chime and `quiet_hours` have no file, asset, client code or test - Severity: Major
* **Reviewer Lens:** `egm-implementation-readiness` (egm-implementation-readiness-1-9 part), `egm-codebase-details` (egm-codebase-details-1-8), `egm-style` (egm-style-1-3)
* **Affected Scope:** #12 (line 619), #26, #47, #50, #56, #67; spec lines 226, 320
* **Discrepancy Description**: The spec says one chime plays on each `sound=true` client when an alert activates, held to turn end, only if still open, muted by `quiet_hours`. No chime asset (for example `web/public/chime.wav`) is listed. `playback.ts` has no chime code. `quiet_hours` is not in `snapshot` or `GET /device-config` (which returns only `sound` and `wake`). `configmap.yaml` (S2) lists `quiet_hours` while `config.py` adds it in S4. No test.
* **Rationale & Recommendation**: Either add the asset, a page module, `quiet_hours` in `/device-config`, and a test, or move the chime to Future Improvements.

### F-M9. Hermes request is under-specified - Severity: Major
* **Reviewer Lens:** `egm-implementation-readiness` (egm-implementation-readiness-1-10), `egm-style` (egm-style-1-16), `egm-codebase-details` (egm-codebase-details-1-14 part, egm-codebase-details-1-17 part)
* **Affected Scope:** #19, #34, #36 (lines 654, 739); spec lines 164, 173, 191-193
* **Discrepancy Description**: The system message text has no home (constant, file or env). `ask(user_text, lang)` has an unused `lang`. The `model` value, auth header form and session ID format are not stated. Both history modes (session header, replay) are built although S0 runs first and picks one, and no variable chooses between them. `httpx` has no total timeout, so "connect 5 s, total 75 s" needs a mechanism (for example `asyncio.timeout(75)`). A connect timeout maps to neither `hermes_fail` nor `timeout` in the spec. On `cancel`, a closed connection must map to `cancel`, not `hermes_fail`, and `ask` needs a cancel handle (spec 173). `fake_hermes.py` must record headers and bodies or "message list contents" cannot be tested.
* **Rationale & Recommendation**: Put the prompt, mode, timeout mechanism and cancel-versus-error rule in #19. Build only the branch S0 selects. Drop `lang` if unused. Make `ask` a cancellable task.

### F-M10. Hub routing and input validation are unspecified - Severity: Major
* **Reviewer Lens:** `egm-implementation-readiness` (egm-implementation-readiness-1-11), `egm-codebase-details` (egm-codebase-details-1-12)
* **Affected Scope:** #22, #23; spec lines 156, 161, 237, 243, 262, 273, 316
* **Discrepancy Description**: #23 says only that it "sends `state`, `tts` and `turn_done`". Undefined: which messages go to all clients and which only to the initiator (audio goes to the initiator only); a frame over 1 MB; `utterance` with no open turn or a wrong turn id or bad `format`/`rate`; a message before `hello`; unknown message types; `wake` from a device with `wake=false` (and the `turn.py`-to-`devices.py` interface); a WebSocket close freeing the turn lock; whether `turn_done` is sent exactly once under the cancel/watchdog/Hermes-error race.
* **Rationale & Recommendation**: Add a table to #23: input condition, response (error code or close), effect on the lock. Test it in `test_hub.py`.

### F-M11. GPU lock can release while the GPU thread is still running - Severity: Major
* **Reviewer Lens:** `egm-implementation-readiness` (egm-implementation-readiness-1-12)
* **Affected Scope:** #16, #22
* **Discrepancy Description**: `run_gpu` runs `fn` in a thread. If the awaiting coroutine is cancelled (watchdog, WebSocket close), the lock can release while the thread still runs, which breaks the one-model-call-at-a-time rule.
* **Rationale & Recommendation**: Hold the lock until the thread returns (shield the await). Add the case to `test_gpu.py`.

### F-M12. Follow-up and listen limits: no owner, and the end reason conflicts - Severity: Major
* **Reviewer Lens:** `egm-implementation-readiness` (egm-implementation-readiness-1-13), `egm-codebase-details` (egm-codebase-details-1-10), `egm-style` (egm-style-1-4)
* **Affected Scope:** #22, #48, #76, #80 (lines 669, 945, 965); spec lines 161, 167, 296, 298
* **Discrepancy Description**: The spec says no speech in 6 s ends a follow-up turn as `empty`. #76 says the page "cancels" at 8 s with no speech or 15 s total, and a follow-up uses 6 s. A client `cancel` yields reason `cancel`, not `empty`. #22 lists the 6 s limit under `turn.py` and #80 tests "follow-up with no speech ending as `empty`", but the server gets no audio until `utterance`, so a server timer from `wake{followup}` would cut off a user who is still talking. The tap path sends audio at the 15 s cap and does not cancel. `config.ts` (#48) has only the 15 s cap, so the page cannot read `followup_listen_s` or the 8 s limit. A tap-started turn on a `wake=false` device is unhandled. Where the `followup_max` counter lives and when it resets are not stated.
* **Rationale & Recommendation**: Decide: the client enforces 6/8/15 s via VAD and sends `utterance` at the cap or `cancel` (or an empty `utterance`) on no speech, and the server keeps only the 30 s and 120 s watchdogs. Name the end reason. Name the config field the page reads. Remove the 6 s limit from #22/#80 if the client owns it. Add tests.

### F-M13. Listening watchdog outcome is undefined - Severity: Major
* **Reviewer Lens:** `egm-codebase-details` (egm-codebase-details-1-11), `egm-style` (egm-style-1-6)
* **Affected Scope:** #22, #37 (line 744); spec lines 147, 156, 164, 177-184
* **Discrepancy Description**: #37 expects the 30 s listening watchdog to end with `timeout` and "the right `timeout_kind`". The failure table lists `timeout` only for Hermes total and the processing watchdog, and `timeout_kind` is `hermes | turn`. Whether the fallback line plays after a turn that never received an utterance is undefined. The test is not testable as written.
* **Rationale & Recommendation**: Add a failure-table row or a `listen` value for `timeout_kind`. State whether the fallback line plays.

### F-M14. Alerts API contract is incomplete and uses two names for one action - Severity: Major
* **Reviewer Lens:** `egm-implementation-readiness` (egm-implementation-readiness-1-14), `egm-codebase-details` (egm-codebase-details-1-16), `egm-style` (egm-style-1-9 part)
* **Affected Scope:** #13, #28, #42, #43, #84, #85, #86; spec lines 197-222
* **Discrepancy Description**: Response bodies and status codes for `POST`, `DELETE` and `GET /alerts` are not defined. Undefined cases: `fire_at` and `in_s` both given; negative `in_s`; bad `urgency`; `text` over 300 characters (HTTP status; no `test_alerts_api.py` case); `key` length or characters (it is in the `DELETE` path); an upsert on a `pending` or `active` key with a changed `fire_at`; a POST with no `fire_at` (immediately `active`?); a `fire_at` in the past; whether the cap of 20 counts `pending`. The wire shape of `snapshot.alerts[]` is not defined (#13 names a row model). `alert_read` on an unknown key or during a turn has no error code, and the spec says the alert is not cleared when synthesis fails, so the client could wait forever. #84 says "clear", #85 says `alert_ack`, and #85 says the messages are "added to the protocol table in the schemas" although the spec table has them.
* **Rationale & Recommendation**: Add a contract table to #28 and #13, mirrored in `docs/alerts.md`. Use `alert_read`/`alert_ack` throughout. Define the failure reply for `alert_read`.

### F-M15. Timer rule and the Hermes-side alerts artifact are undefined and inconsistently conditional - Severity: Major
* **Reviewer Lens:** `egm-implementation-readiness` (egm-implementation-readiness-1-15), `egm-codebase-details` (egm-codebase-details-1-15), `egm-style` (egm-style-1-10 part)
* **Affected Scope:** #22, #29, #37, #44, #86, line 1010; spec lines 103, 220
* **Discrepancy Description**: #29 builds `timer_rule.py` only if the S0 test fails, but #22 and #37 say S4 adds it, and the 80% coverage list names it unconditionally. If the rule matches, Hermes is not called, yet the spoken confirmation text, language and `turn_done` reason are undefined (CUJ 4 assumes Hermes speaks). Undecided: digits only or number words ("diez minutos")? Hours? Key generation, when the spec needs two timers for the same timer twice in one day. The Hermes-to-`/alerts` path (CUJ 4) needs a Hermes tool or skill, and the plan lists only "a note" in `docs/alerts.md`; where the artifact lives and what it contains are not said.
* **Rationale & Recommendation**: Record the S0 branch in `docs/spikes/hermes-test.md` and word #22, #37, #44 as conditional. Define reply text, reason, key (include a unique part) and parsing scope. Say where the Hermes tool artifact lives.

### F-M16. S3 hands-free is too vague to code - Severity: Major
* **Reviewer Lens:** `egm-implementation-readiness` (egm-implementation-readiness-1-16), `egm-codebase-details` (egm-codebase-details-1-25, rated Nit)
* **Affected Scope:** #76, #77, #78, #45
* **Discrepancy Description**: #77 says "an openWakeWord pipeline in a Web Worker using ONNX Runtime Web". A browser port of mel, embedding and classifier stages is real code, and the plan gives no chunk size, buffer length, score threshold, debounce or cooldown, and does not say whether it is ported or an existing package is used (unverified whether one exists). #78 lists a directory, not files. The wasm assets for ONNX Runtime Web and vad-web have no location or Vite copy rule. No test covers wake gating (idle only, muted during playback plus 0.5 s), follow-up open/close, or VAD limits. "If the detector allows it" (line 970) names no fallback.
* **Rationale & Recommendation**: Add the parameters and exact files, plus a pure `wake-gate.ts` with a vitest file. Or mark S3 "to be specified after the tablet test" in the plan.

### F-M17. Deploy manifests leave impactful choices open - Severity: Major
* **Reviewer Lens:** `egm-implementation-readiness` (egm-implementation-readiness-1-17), `egm-style` (egm-style-1-20 part)
* **Affected Scope:** #61-#68; spec lines 304-306
* **Discrepancy Description**: The ingress controller is not named, so "raised WebSocket timeouts" (#65, no value) has no annotation. No container, Service or ingress port; no PVC size; no namespace. The model cache path and PVC mount path are not given. The devices file mount (ConfigMap key and path) is not given; `config/devices.json` is not mounted in `deployment.yaml` (#63) and `configmap.yaml` (#67) says "the device file" without a mount. The CUDA base image tag, how Python and `uv` get onto it, and the non-root UID are not stated. Internal DNS (spec 304) is owned by neither #66 nor #68.
* **Rationale & Recommendation**: Choose or give a named default for each. Add the devices file mount.

### F-M18. S0 stub cannot be built and has no Delete entry - Severity: Major
* **Reviewer Lens:** `egm-codebase-details` (egm-codebase-details-1-4), `egm-style` (egm-style-1-14)
* **Affected Scope:** #2, #3 (line 569), #45, #69, #75; spec lines 303-304
* **Discrepancy Description**: The stub is TypeScript with a worker, ONNX Runtime Web and a model file, but `web/package.json` and `vite.config.ts` arrive in S1 while S0 comes first. Nothing says how the stub is built or served over HTTPS. It is "deleted after S0" but there is no Delete entry or step. The engine is not named ("hey jarvis" implies openWakeWord, microWakeWord fallback H3 not mentioned). "Drops" in "detections and drops" is undefined. The "does Chrome need a service worker" check (spec 303) is owned by no entry.
* **Rationale & Recommendation**: Make the stub a self-contained folder (own `package.json`, or a plain JS page) with a one-line build, add a Delete entry tagged S1, define "drops", and put the service-worker check in #2.

### F-M19. "Both libraries load in one image" check is in S1 but the Dockerfile is in S2 - Severity: Major
* **Reviewer Lens:** `egm-codebase-details` (egm-codebase-details-1-5)
* **Affected Scope:** #61; spec line 328 (Assumption 5)
* **Discrepancy Description**: The spec says S1 confirms both libraries load in one image, but S1 only runs `uv sync` on the desktop. No S1 step builds an image.
* **Rationale & Recommendation**: Move the check to S2 or add a minimal S1 Dockerfile step.

### F-M20. `client_event` does not fit the `turns` table and the frame-time tiers are unspecified - Severity: Major
* **Reviewer Lens:** `egm-codebase-details` (egm-codebase-details-1-18), `egm-style` (egm-style-1-13), `egm-implementation-readiness` (egm-implementation-readiness-1-21 part)
* **Affected Scope:** #20, #21, #33, #74 (lines 664, 724, 934); spec lines 248, 312
* **Discrepancy Description**: The spec writes `client_event` to the `turns` table, whose columns are turn id, time, lang, user text, reply text, reason and timings. #74 sends frame time once a minute (no turn), about 1,440 rows a day, and `timings_report.py` counts reasons from that table. #20 has only `insert_turn`. #74 adds "quality tiers by measured frame time" with no thresholds, against the fixed 0.75 scale and 30 fps cap in #54 and spec 233. The `turns` columns and `user_version` number are not defined, and there is no migration test (S1 file opened by S4 code and the reverse, per the rollback rule at line 502).
* **Rationale & Recommendation**: Use a separate `events` table, or log frame time to stdout and skip persistence. Pick fixed scale or tiers. Define the schema and add the migration test.

### F-M21. `/device-config` auth is missing from the plan - Severity: Major
* **Reviewer Lens:** `egm-style` (egm-style-1-15)
* **Affected Scope:** #25, #26, #41 (lines 684, 689); spec line 267
* **Discrepancy Description**: The spec requires `DEVICE_TOKEN` in an `Authorization` header on `/device-config`. #25 covers only the hub and `/alerts` routes.
* **Rationale & Recommendation**: Add the dependency to #26 and a test case to #41.

### F-M22. Support files are missing from the file list and the `clips` ignore path is wrong - Severity: Major
* **Reviewer Lens:** `egm-implementation-readiness` (egm-implementation-readiness-1-18), `egm-codebase-details` (egm-codebase-details-1-6, egm-codebase-details-1-7, egm-codebase-details-1-27 part), `egm-style` (egm-style-1-19)
* **Affected Scope:** #5, #7, #10, #40, #45, #58, #69, #78
* **Discrepancy Description**: Not listed: `web/eslint.config.*`; a pytest config or `conftest.py` (`pytest-asyncio` mode, `gpu` marker); a vitest DOM environment (jsdom or happy-dom) for `AudioContext` and `WebSocket` mocks; a GLSL import declaration (`vite-env.d.ts` or `?raw`) so typecheck passes on `blob.frag` and `blob.vert`; audio fixtures for `test_speech_gpu.py` (#40) and `stt_cli`; a Python version pin; shared protocol types between Pydantic and TypeScript. `.gitignore` (#5) excludes `tests/clips/`, but a pattern with a slash is anchored to the root, so `backend/tests/clips/` is not matched and personal voice recordings could be committed (verify against git rules). `web/public/icons/` and `web/public/models/` are directory globs for knowable files; the standard allows a glob only for generated output. `beep.wav` (#58) and icons (#69) have no generation recipe. Worklet bundling is mentioned for S3 but S1 already needs it for `capture-processor.ts`. One `AudioContext` for capture and playback is not stated.
* **Rationale & Recommendation**: List the files, fix the ignore path, name the model and icon files, give the beep frequency and duration.

### F-M23. Config and tooling staging contradictions - Severity: Major
* **Reviewer Lens:** `egm-codebase-details` (egm-codebase-details-1-19)
* **Affected Scope:** #10, #12, #24, #45, #48
* **Discrepancy Description**: #24 serves the built page in S1 but #12 adds the static directory in S2. Entry point `blob.main:run` is declared without describing `run()`, host or port. The Vite dev proxy lists only `/ws`, but S2 needs `/device-config` and `/healthz`. #48 says the device name is "set from the install URL" but that is `token.ts` (S2). #24 says "a daily task" while spec 313 says at startup and every 24 h, and "(S2)" after the static page route is ambiguous.
* **Rationale & Recommendation**: Align slice tags, proxy list and descriptions.

### F-M24. Verification section is uncalibrated - Severity: Major
* **Reviewer Lens:** `egm-style` (egm-style-1-12), `egm-implementation-readiness` (egm-implementation-readiness-1-18 part), `egm-codebase-details` (egm-codebase-details-1-17 part)
* **Affected Scope:** lines 1010-1012; #7, #10
* **Discrepancy Description**: The 80% coverage floor has no tool: `pytest-cov` is not in #10 and no `--cov-fail-under` in #7 CI. Line 1011 packs about 10 pass criteria into one bullet and repeats G1/#8. It hedges the pass condition ("history is used within 5 minutes... or Hermes holds the session") although S0 settles that before S1. "Within the timeout" does not say which timeout. Elsewhere "as approved" (line 982, #83) has no approver or location; "several days" (lines 970, 1012) disagrees with SC2's 3 days; "to start" and "about twice as fast" give no value or key.
* **Rationale & Recommendation**: Add `pytest-cov` and the fail-under setting or drop the number. Use a numbered list kept in `docs/testing/exit-tests.md` and link to it. State one pass condition. Replace vague phrases with values.

### F-M25. `first_sentence_split` is built although streaming is deferred - Severity: Major (implementation-readiness rated Nit)
* **Reviewer Lens:** `egm-style` (egm-style-1-11), `egm-implementation-readiness` (egm-implementation-readiness-1-20 part)
* **Affected Scope:** #14, #35 (lines 629, 734); Alternative Q (line 526)
* **Discrepancy Description**: #14 says it is "written and tested in S1, unused until then", which contradicts the deferral of sentence streaming (NG11, Future Improvements).
* **Rationale & Recommendation**: Drop it and its tests from S1. Build it when streaming starts.

### F-M26. Scheduler poll can miss the 1 s target and #82 has no measurement method - Severity: Major (implementation-readiness rated Nit)
* **Reviewer Lens:** `egm-style` (egm-style-1-7), `egm-implementation-readiness` (egm-implementation-readiness-1-19)
* **Affected Scope:** #28, #82 (lines 699, 774, 977); G6, SC5; spec lines 38, 218
* **Discrepancy Description**: A once-per-second poll plus a broadcast can exceed 1 s from `fire_at`. `test_scheduler.py` with an injected clock does not catch this. #82 does not name how the 1 s is measured.
* **Rationale & Recommendation**: Poll every 250 ms or sleep until the next `fire_at`, or restate the criterion as "within 2 s". Name the method (a `curl` timestamp against a screen recording would do).

### F-M27. Wording and terms in duplicate entries contradict the base entries - Severity: Major
* **Reviewer Lens:** `egm-style` (egm-style-1-9 part), `egm-codebase-details` (egm-codebase-details-1-16 part, egm-codebase-details-1-24)
* **Affected Scope:** #8, #74, #80, #83, #84, #85
* **Discrepancy Description**: Item 8 refers to "the S1 test from the Technical Plan", which is not in the Technical Plan (it is in G1 and the Verification Plan). #83's "Urgency colours as approved" is a dangling reference. #85 "protocol table in the schemas" is vague. #80 duplicates the wake entry from #22.
* **Rationale & Recommendation**: Fixed when the duplicates are folded into base entries (F-M1). Replace the dangling references with actual cross-references.

## Nits

### F-N1. Small spec and schema gaps
* **Reviewer Lens:** `egm-implementation-readiness` (egm-implementation-readiness-1-21), `egm-style` (egm-style-1-20)
* **Affected Scope:** #20, #21, #50, #51, #52, #54-#57, #72
* **Discrepancy Description**: `tts` `seq` and `final` values in S1 and the `turn` id format (integer or UUID) are not stated. The page version source for the reload guard (#72) is not stated (inject from `__init__.py` at build). `computeView` for a mirror client that never played audio gets `snapshot.conv = speaking`, while #50 says speaking is kept until local playback ends. Colour hex values, easing, breathing rates (#56) and GLSL uniform names (#54, #55) are unspecified. Licences of adapted shader repos are unchecked (unverified). `.github/workflows/ci.yml` assumes GitHub (`.git/config` shows a GitHub origin, so plausible). Long-press duration (#51, #57) and resampling method (#52) are not stated.
* **Rationale & Recommendation**: Record values when chosen. Fine for iteration but write them down once.

### F-N2. STT warm-up may do nothing
* **Reviewer Lens:** `egm-codebase-details` (egm-codebase-details-1-21)
* **Affected Scope:** #17
* **Discrepancy Description**: Warm-up with one second of silence while `vad_filter` is on may skip the model call entirely (unverified from memory).
* **Rationale & Recommendation**: Warm up with `vad_filter=False` or a short speech clip.

### F-N3. S0 has no procedure and no outcome branches
* **Reviewer Lens:** `egm-codebase-details` (egm-codebase-details-1-22)
* **Affected Scope:** #1, #2
* **Discrepancy Description**: Items 1 and 2 are record templates only. No curl steps, deploy route, or branches for "system message ignored" or "reply not plain text". The kill rule exists only for the tablet.
* **Rationale & Recommendation**: Add short steps and branches.

### F-N4. Build order omits files and has a sequencing slip
* **Reviewer Lens:** `egm-codebase-details` (egm-codebase-details-1-23)
* **Affected Scope:** line 550; #4
* **Discrepancy Description**: The S1 order omits `textclean`, `voices`, `gpu`, `db` and `turnlog`, and puts `main` (which opens the database) before `db`. The README (#4) mentions "how to read the timing line" before timing fields are fixed (see F-B1).
* **Rationale & Recommendation**: Complete and reorder the list.

### F-N5. Dependency tree cost in CI
* **Reviewer Lens:** `egm-codebase-details` (egm-codebase-details-1-26)
* **Affected Scope:** #7
* **Discrepancy Description**: `uv sync` in CI likely pulls the faster-whisper and Kokoro tree (torch) though GPU tests are skipped (unverified). Size concern, not a defect.
* **Rationale & Recommendation**: Consider an optional dependency group.

### F-N6. Vague wording and inconsistent terms
* **Reviewer Lens:** `egm-style` (egm-style-1-17, egm-style-1-18)
* **Affected Scope:** lines 543, 549, 572, 609, 644, 836, 970, 982, 1011-1012
* **Discrepancy Description**: "simple animated canvas" (drop "simple"); "the metal look" (give the observable); "visibly changes in all five states" (tie to the colour table); "kill rule"/"kill-spikes" against the spec's "S0 spikes"; "Voice filter" against `vad_filter`/"voice-activity filter"; "Button mode" is not defined in the plan; "Clear" against `alert_ack`; "exact package confirmed in the TTS step" (name the candidate).
* **Rationale & Recommendation**: Use one term per thing and observable wording.

### F-N7. Unused-code and text-rule gaps
* **Reviewer Lens:** `egm-implementation-readiness` (egm-implementation-readiness-1-20 part)
* **Affected Scope:** #15
* **Discrepancy Description**: `clean_for_speech` rules are unspecified (code fences, link text versus URL, list markers, emoji ranges). The `?` detection for `followup` ignores trailing quotes or whitespace.
* **Rationale & Recommendation**: State the rules, or accept a first version and test it.

## Traceability: reviewer id to report finding

| Reviewer id | Report finding |
| --- | --- |
| egm-implementation-readiness-1-1 | F-B1 |
| egm-implementation-readiness-1-2 | F-B2 |
| egm-implementation-readiness-1-3 | F-M1 |
| egm-implementation-readiness-1-4 | F-M2 |
| egm-implementation-readiness-1-5 | F-M3 |
| egm-implementation-readiness-1-6 | F-M4 |
| egm-implementation-readiness-1-7 | F-M5 |
| egm-implementation-readiness-1-8 | F-M6 |
| egm-implementation-readiness-1-9 | F-M7, F-M8 |
| egm-implementation-readiness-1-10 | F-M9 |
| egm-implementation-readiness-1-11 | F-M10 |
| egm-implementation-readiness-1-12 | F-M11 |
| egm-implementation-readiness-1-13 | F-M12 |
| egm-implementation-readiness-1-14 | F-M14 |
| egm-implementation-readiness-1-15 | F-M15 |
| egm-implementation-readiness-1-16 | F-M16 |
| egm-implementation-readiness-1-17 | F-M17 |
| egm-implementation-readiness-1-18 | F-M22, F-M24 |
| egm-implementation-readiness-1-19 | F-M26 |
| egm-implementation-readiness-1-20 | F-M25, F-N7 |
| egm-implementation-readiness-1-21 | F-M20, F-N1 |
| egm-codebase-details-1-1 | F-B1 |
| egm-codebase-details-1-2, 1-3 | F-M1 |
| egm-codebase-details-1-4 | F-M18 |
| egm-codebase-details-1-5 | F-M19 |
| egm-codebase-details-1-6, 1-7 | F-M22 |
| egm-codebase-details-1-8 | F-M8 |
| egm-codebase-details-1-9 | F-B2 |
| egm-codebase-details-1-10 | F-M12 |
| egm-codebase-details-1-11 | F-M13 |
| egm-codebase-details-1-12 | F-M6, F-M7, F-M10 |
| egm-codebase-details-1-13 | F-M4, F-M7 |
| egm-codebase-details-1-14 | F-M6, F-M9 |
| egm-codebase-details-1-15 | F-M15 |
| egm-codebase-details-1-16 | F-M14, F-M27 |
| egm-codebase-details-1-17 | F-M2, F-M3, F-M9, F-M24 |
| egm-codebase-details-1-18 | F-M20 |
| egm-codebase-details-1-19 | F-M2, F-M23 |
| egm-codebase-details-1-20 | F-M6 |
| egm-codebase-details-1-21 | F-N2 |
| egm-codebase-details-1-22 | F-N3 |
| egm-codebase-details-1-23 | F-N4 |
| egm-codebase-details-1-24 | F-M27 |
| egm-codebase-details-1-25 | F-M16 |
| egm-codebase-details-1-26 | F-N5 |
| egm-codebase-details-1-27 | F-M22 |
| egm-style-1-1 | F-B1 |
| egm-style-1-2 | F-B2, F-M7 |
| egm-style-1-3 | F-M8 |
| egm-style-1-4 | F-M12 |
| egm-style-1-5 | F-M4 |
| egm-style-1-6 | F-M13 |
| egm-style-1-7 | F-M26 |
| egm-style-1-8 | F-M2 |
| egm-style-1-9 | F-M1, F-M14, F-M20, F-M27 |
| egm-style-1-10 | F-M1, F-M15 |
| egm-style-1-11 | F-M25 |
| egm-style-1-12 | F-M24 |
| egm-style-1-13 | F-M20 |
| egm-style-1-14 | F-M18 |
| egm-style-1-15 | F-M21 |
| egm-style-1-16 | F-M9 |
| egm-style-1-17, 1-18 | F-N6 |
| egm-style-1-19 | F-M22 |
| egm-style-1-20 | F-M6, F-M17, F-M23, F-N1 |

## Not checked / unverified

- No reviewer opened URLs. `review_round2.md` and most `review_context/` files were not read; only Hermes, Voice Satellite and wake-word pages were grepped.
- Unverified: Kokoro `espeak-ng` need; faster-whisper warm-up behaviour with `vad_filter`; browser openWakeWord packaging and any JS port; ingress annotation names; Chrome PWA install rules; tablet behaviour; gitignore matching of `tests/clips/` under `backend/`; Hermes behaviour beyond its documentation.
- Hermes docs also say that without the session header Hermes derives a session from the system prompt plus the first user message (hermes-api-server.html line 120). The S0 test should note this.
- Checked and consistent (per `egm-codebase-details`): WebSocket message names and fields, `turn_done` reasons, state enum, `hello`/`hello_ok` version flow and the 4401 close code; timeouts (5, 75, 30, 120, 15, 6 s), `tts_max_chars`, 14-day purge, `PRAGMA user_version`, `Recreate`/`replicas: 1`; Hermes `POST /v1/chat/completions`, `X-Hermes-Session-Id`, `stream: false`.
