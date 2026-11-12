# Goldfish Review Report

**Target:** `/home/arnau/workspace/meet_blob/docs/designs/blob_design.md` (full file, lines 1-939)

**Stage:** 5, Initial Zoom Out Review. Standard applied to `egm-zoom-out`: `zoom-out-standard`.

## Reviewer Status

| Reviewer | Status |
| --- | --- |
| `egm-zoom-out` | completed |
| `egm-inventive-catalyst` | completed |

Neither reviewer could open URLs. Claims about Chrome, Android, Kokoro, faster-whisper, openWakeWord, VRAM and frame rates are unverified unless a saved page supports them. Line numbers come from the reviewers and were not re-checked. File numbers ("file 14") refer to the numbered file list in the design's implementation plan.

Severity count in the main section: 0 Blocker, 9 Major, 8 Nit.

## Prioritized Findings (Blockers -> Major -> Nits)

No Blockers.

### Plan is too big for "simplest path, refine later"; S1 exceeds the accepted slice 1 - Severity: Major
* **Reviewer Lens:** `egm-zoom-out` (also raised by `egm-inventive-catalyst`)
* **Affected Scope:** Implementation plan, lines 462-923 (files 4-60), coverage gate at line 931
* **Discrepancy Description**: The predecessor brief (`blob.md` lines 91-98) defines slice 1 as a desktop page plus one Python process, with "No Kubernetes, TLS, PWA, auth, wake word, VAD, alerts, SQLite, shapes or morph". D70 also cuts diagnostics. The plan's S1 adds:
  * SQLite, a `turns` table, `PRAGMA user_version` and a 14-day purge task (files 20, 21).
  * A diagnostics page with a copy-report button (file 57).
  * `first_sentence_split`, written and tested "unused until then" (file 14, line 550).
  * Pydantic models for every message (file 13).
  * GitHub Actions CI with mypy, ruff-format and eslint (file 7).
  * An 80% coverage gate over 9 modules (line 931). `pytest-cov` is not in the dependency list at line 530.
  * A fake Hermes with five switches, e2e and report scripts, and about 10 backend modules.
  Several modules are a few lines each (`gpu.py`, `voices.py`, `turnlog.py` and `db.py`).
* **Rationale & Recommendation**: The plan reads as a spec for a team and risks never being built. Cut S1 to `config`, `stt`, `tts`, `hermes`, `turn` and `main` (WebSocket handlers can sit in `main`) plus the page. Log one JSONL line per turn to a local file so `timings_report.py` can read it. Move SQLite, the purge task and the `turns` table to S4, where `alerts` needs them. Drop the diagnostics page, CI and the coverage gate; run `ruff` and `pytest` locally. Keep `pytest` for the turn state machine and alert rules, where bugs will hide. See the tension on `first_sentence_split` in the next finding.

### Tension to resolve: `first_sentence_split` and `seq/final` are built in S1 but streaming is deferred - Severity: Major
* **Reviewer Lens:** `egm-inventive-catalyst` (F2) and `egm-zoom-out` (M1, N3). The two lenses recommend opposite fixes.
* **Affected Scope:** Lines 238, 448, 550, 849; files 14, 53; Alternative Q
* **Discrepancy Description**: S1 already carries the streaming machinery: `seq/final` in the protocol, the `nextT` chunk scheduler (file 53) and `first_sentence_split`. The benefit (the 6 s vs 3 s gap on the main UX metric) is deferred. The cost is paid, the gain is not.
* **Rationale & Recommendation**: Pick one side deliberately. Zoom-out: delete the unused machinery from S1 (keep `turn`, drop `seq` and `final`) and add it when streaming starts; adding protocol fields later is not a dead end. Catalyst: use it now, behind a config flag, and send the first sentence to Kokoro as soon as it completes, then the rest as one chunk, and measure both modes with `timings_report.py`. Catalyst's caveats: STT and TTS contend on the single GPU lock, Spanish `¿¡` must be tested in the sentence-end heuristic, and a cancelled turn can leave a half-spoken reply. Recommended default for a hobbyist: delete it unless SC1 latency is missed after the first measurement, then bring it in.

### S2-S4 specified file by file before the spikes that decide them - Severity: Major
* **Reviewer Lens:** `egm-zoom-out` (also `egm-inventive-catalyst` F8)
* **Affected Scope:** Overview lines 25-29; plan lines 602-626 and 784-923 (about 45 files)
* **Discrepancy Description**: The Overview admits S2-S4 "depend on two short tests that have not been run", yet the plan lists concrete files for them: `auth.py`, `devices.py`, Kubernetes manifests, `wake/worker.ts`, `docs/wake-word-training.md`, and `timer_rule.py` with its own tests. A tablet-test failure kills S3. A passing Hermes timer test means `timer_rule.py` is never built. This is also an altitude drop: file-level detail for work that may never happen.
* **Rationale & Recommendation**: Keep S0 and S1 at file level. Reduce S2-S4 to a short paragraph each: goal, components, exit test, and the spike result that gates it. Expand a slice into files when it starts. The author already said refinement comes later, so less ahead-of-time cross-slice consistency is the intended trade.

### Hermes history should follow the documented session header, not a Blob-side history object - Severity: Major
* **Reviewer Lens:** `egm-zoom-out` (M3) and `egm-inventive-catalyst` (F5), merged
* **Affected Scope:** Lines 173, 290, 575, 658-660; file 19; line 483
* **Discrepancy Description**: `hermes-api-server.html` (lines 81-83, 120) documents an `X-Hermes-Session-Id` header on `/v1/chat/completions`. History then comes from the session. Without the header, Hermes derives the session from the system prompt plus the first user message. The design hides this behind "if the Hermes test shows that a session ID works" and still plans a Blob-side history (6 pairs, 5-minute expiry, injected clock, its own tests). With a sliding 6-pair window the first user message changes as the window rolls, so Hermes may create a new server-side session per rolled window while Blob keeps its own copy. This is the double-history risk the design already names. This behaviour was not tested on the author's install (unverified).
* **Rationale & Recommendation**: Make session-header mode the default: one session id per conversation, rotated after 5 minutes idle to give the "forget" behaviour. Delete the history class and its `test_hermes.py` cases; keep Blob-side history only as the fallback if the S0 test shows the header fails. State that cancelled and failed turns may still be recorded on the Hermes side, so "never enters history" cannot be guaranteed. Also add to the route question at line 483: the saved page says the default bind is `127.0.0.1:8642`, so how does the pod reach it? The page does not say how to change the bind address.

### Voice timers: the design contradicts its own rejection of Hermes-routed alerts - Severity: Major
* **Reviewer Lens:** `egm-zoom-out` (M4) and `egm-inventive-catalyst` (F3), merged
* **Affected Scope:** G6, lines 25, 99, 198-200, 354-355, 625; Alternative I; CUJ 4; file 29
* **Discrepancy Description**: Alternative I rejects routing alerts through Hermes because "alerts must work without an LLM in the path" and "a language model has no reliable clock". CUJ 4 then makes Hermes, an LLM, the primary path to create a voice timer; only firing is LLM-free. The fallback regex ("about 20 lines": temporizador / timer / temporitzador plus a number) is understated. Whisper may write "diez minutos", "deu minuts" or "ten minutes" as words, and number words in three languages is more than 20 lines (estimate, untested). The fallback is built only if the Hermes test fails, but a Hermes that says "timer set" after a failed tool call would pass that test.
* **Rationale & Recommendation**: Choose one primary path after the S0 test and do not build both. Two options:
  * Cheap: reword Alternative I and G6 to say that creating a timer by voice uses Hermes while firing and display do not. State that the regex fallback covers digits only, or budget it honestly.
  * Catalyst inversion: make a strict grammar (number plus unit in es/ca/en) the primary path, answered with a pre-rendered or short TTS "vale, 10 minutos" without calling Hermes, and send everything else to Hermes. This makes the exit test deterministic. Liabilities: brittle coverage ("media hora", "un quart"), collisions with questions ("¿cuánto falta para el temporizador?"), and separate cancel and list intents.
  Either way, the exit test must check that the timer exists in Blob, not that Hermes said so.

### Hermes timeouts contradict each other because `stream: false` sends no bytes - Severity: Major
* **Reviewer Lens:** `egm-inventive-catalyst` (F1)
* **Affected Scope:** Lines 150, 158; `turn.py` (file 22)
* **Discrepancy Description**: The design sets "no bytes 30 s, total 120 s" for Hermes together with `stream: false` and a 90 s turn watchdog that includes up to 15 s of listening plus STT. A non-streaming call sends nothing until the turn finishes, so the no-bytes timeout is really a 30 s total cap. Any tool-using Hermes turn longer than 30 s fails as `timeout`. The 120 s total is never reached and the 90 s watchdog sits below it.
* **Rationale & Recommendation**: Call with `stream: true` even in S1 and accumulate the text. The saved Hermes page says chat completions emit an `event: hermes.tool.progress` frame (it can be disabled in config), which acts as a heartbeat and gives the no-bytes timeout a meaning. This is page text, not tested on the author's install. Start the watchdog at `thinking`, not `listening`, and keep it above the Hermes total. Costs: SSE parsing, partial text on cancel, and strict clients choking on the named event. Fall back to `stream: false` if the S0 test shows odd chunks. If the author prefers to stay non-streaming, drop the no-bytes timeout and the contradiction goes away.

### Readiness probe on "models loaded" defeats the "HTTP first" startup - Severity: Major
* **Reviewer Lens:** `egm-inventive-catalyst` (F4)
* **Affected Scope:** Lines 63, 274, 434; file 63; SC6
* **Discrepancy Description**: The plan starts HTTP, DB and scheduler first so the alert API and page are up while models load. It then sets the Kubernetes readiness probe on "ready". An unready pod is removed from Service and ingress endpoints, so `/alerts`, the page and `/ws` are unreachable until the models load from the PVC. This contradicts SC6 ("alive at once"), the grey blob while warming, and sources posting alerts early.
* **Rationale & Recommendation**: Point both probes at the alive endpoint. Expose "ready" only in the `/healthz` body and in `snapshot` (for example a `models_ready` field) so the page shows grey. Accepted liability: a bad rollout looks healthy to Kubernetes until someone checks `models_ready`, which is fine for one pod and one user. The catalyst expects this and the timeout item above to fail on first deployment as written.

### Follow-up listening is a heuristic plus three knobs for one use case, and contradicts G4 - Severity: Major
* **Reviewer Lens:** `egm-zoom-out` (M5) and `egm-inventive-catalyst` (F10), merged
* **Affected Scope:** Lines 89-93, 161, 264, 880-886; G4; CUJ 3b
* **Discrepancy Description**: The reply ending in "?" opens the mic for 6 s. This adds a `wake{followup}` message, a `tts.followup` field, `followup_max`, `followup_listen_s`, a 6 s turn mode and extra tests. A rhetorical question ("¿Quieres algo más?") wastes the open mic, as line 264 admits. It also conflicts with G4, which says the mic opens "only after a tap, key or the wake word". It exists mainly to make "ask before acting" (D63) work.
* **Rationale & Recommendation**: Defer it, or hard-code one follow-up with no `followup_max` and no `followup_listen_s`, reusing `tap`/`wake` with a short no-speech limit and no new field. Remove it from CUJ 3b and the S3 file list until S3 works. If it stays, either edit G4 to list follow-up as a fourth trigger, or have Hermes end with a fixed marker (stripped by `clean_for_speech`) only when it expects an answer. Model compliance with the marker is unverified. A cheaper control for the "ask before acting" risk is the Hermes toolset restriction (lines 64, 424).

### Cancel is only an HTTP abort; nobody checks that Hermes stops - Severity: Major
* **Reviewer Lens:** `egm-inventive-catalyst` (F6)
* **Affected Scope:** Lines 159, 252-253
* **Discrepancy Description**: A tap in `thinking` "aborts the Hermes request". If Hermes already started a tool (lights, a lock), dropping the TCP connection may not stop it, and the state may differ from what Blob tells the user. The saved Hermes page documents `finish_reason: "cancelled"` for interrupted turns and a runs API with cancellation and status polling. Whether a client disconnect on chat completions triggers that interrupt is unverified.
* **Rationale & Recommendation**: Add one S0 question: "does closing the connection interrupt the agent?" If not, use `/v1/runs` and its cancel endpoint (shape not verified) for turns only, at the cost of a second endpoint and a different response shape. If the author keeps the plain abort, say in the design that side effects may continue.

### Held alerts conflict with the 1 s visibility goal - Severity: Major
* **Reviewer Lens:** `egm-inventive-catalyst` (F7)
* **Affected Scope:** G6, SC5, CUJ 5, lines 105, 206
* **Discrepancy Description**: An alert arriving mid-turn is held hidden until the turn ends, up to 90 s (the watchdog). SC5 says an alert is visible within 1 s, and an `urgent` Home Assistant alert is exactly what should break through.
* **Rationale & Recommendation**: Cheapest fix: reword SC5 to "except during a turn" and say so. Better: hold only `info`; for `urgent`, show a small rim, tint or brief pulse on the blob, keep the conversation state dominant, and keep sound suppressed during the turn. This needs one more precedence-table row and a tint input in the renderer independent of the shape.

### Capture decision contradicts itself; a cheaper S1 option is dismissed - Severity: Nit
* **Reviewer Lens:** `egm-zoom-out` (N1)
* **Affected Scope:** Lines 63, 295, 396-397, 742; Alternative P; Assumption 6
* **Discrepancy Description**: Open Questions asks whether faster-whisper accepts `MediaRecorder` webm/opus, while Alternative P and Assumption 6 say PCM is chosen. The reason given (wake word and VAD need raw samples "anyway") only applies from S3.
* **Rationale & Recommendation**: Run the decode check as part of the S0 Hermes spike (minutes). If webm decodes, S1 can use `MediaRecorder` and add the worklet in S3. If PCM stays, ask the browser for a 16 kHz `AudioContext` instead of resampling by hand (believed supported in Chrome, unverified). Remove the stale Open Question either way.

### S0 tablet stub sits on the critical path of a desktop-only slice - Severity: Nit
* **Reviewer Lens:** `egm-zoom-out` (N2)
* **Affected Scope:** Lines 470, 490-493
* **Discrepancy Description**: A browser openWakeWord pipeline in a worker (mel features, ONNX, stock model) is unlikely to take "hours" the first time (judgement, unverified). S1 does not depend on it; only S2, S3 and the option-A switch do.
* **Rationale & Recommendation**: Run the tablet stub in parallel with S1, or after it, so S1 is not blocked.

### Adaptive quality tiers are premature - Severity: Nit
* **Reviewer Lens:** `egm-zoom-out` (N4)
* **Affected Scope:** Line 213; lines 851-854 (file 74); `blob.md` line 122
* **Discrepancy Description**: Line 213 already fixes the cost controls (0.75 scale, bounding-sphere early exit, 30 fps idle cap, context-loss handling). File 74 adds named tiers chosen by measured frame time plus a once-a-minute frame-time report, with no measurement behind it.
* **Rationale & Recommendation**: Measure SC4 first and add tiers only if the fixed settings throttle. The option-A switch criterion in `blob.md` also mentions the "lowest quality tier", so both documents must change together.

### three.js is a choice, not a given - Severity: Nit
* **Reviewer Lens:** `egm-zoom-out` (N5)
* **Affected Scope:** Lines 45, 54; `blob.md` R32
* **Discrepancy Description**: The page is one fullscreen quad, and `blob.md` says plain WebGL2 or three.js "either is fine". The design picks three.js without a reason.
* **Rationale & Recommendation**: State the reason. A fair one: the saved Codrops reference is written in three.js, so reuse is cheaper.

### Docs sprawl - Severity: Nit
* **Reviewer Lens:** `egm-zoom-out` (N6)
* **Affected Scope:** Lines 480-523, 784-823, 878, 915
* **Discrepancy Description**: The plan lists `docs/runbook.md`, `docs/alerts.md`, `docs/testing/exit-tests.md`, `docs/wake-word-training.md`, `deploy/README.md` and two spike notes. The exit tests already appear in the Verification Plan and in `blob.md`.
* **Rationale & Recommendation**: For one person, fold the runbook, deploy notes and alerts guide into the README and keep one `docs/spikes.md`.

### Server-side wake word rung is missing from the fallback ladder - Severity: Nit
* **Reviewer Lens:** `egm-inventive-catalyst` (F9)
* **Affected Scope:** G4, Alternative H, line 265
* **Discrepancy Description**: Server-side wake word is rejected on privacy grounds, but the server is the author's own LAN machine and already holds STT. The ladder jumps from tap-only to a WebView and then to Home Assistant.
* **Rationale & Recommendation**: If the S0 test fails, document a rung before the WebView: stream PCM over `/ws` while the screen is on and run openWakeWord in Python on the server. This would change G4 for that fallback; costs are continuous upload, battery and Wi-Fi use, and a worse privacy story if the cluster is ever shared. The author decided this, so document it as a rung, not a reversal.

### Possible unused Hermes capability for reminders - Severity: Nit
* **Reviewer Lens:** `egm-inventive-catalyst` (F11)
* **Affected Scope:** Line 25; Hermes page lines 402-411
* **Discrepancy Description**: The problem statement says Hermes does not handle timers, but the saved API page lists a Jobs API and `hermes cron` with a "delivery target". Whether a one-shot job can call a webhook such as `/alerts` is unverified.
* **Rationale & Recommendation**: Add one S0 question: "can a Hermes cron job deliver to a URL?" If yes, reminders cost nothing in Blob. Liability: a second scheduler with its own time source.

### Small consistency and wording issues - Severity: Nit
* **Reviewer Lens:** `egm-zoom-out` (N3, N7) and `egm-inventive-catalyst` (F12)
* **Affected Scope:** Lines 150, 160, 229, 232, 238, 272, 279, 341, 423, 483, 809; files 37, 57
* **Discrepancy Description**:
  * Line 150 and file 37 say `turn_start` gets `busy`, but the protocol table has only `tap` and `wake`.
  * Line 483 cites "D57's two branches"; D57 is defined only in `blob.md`.
  * Line 279 says alerts "can be re-created by their sources", but a voice-created timer has no source. A lost DB loses voice timers; say so.
  * The `wake` row (line 229) sits among the server-to-client rows.
  * `tts{turn, seq, final}`, `client_event`, `ping` and the version-reload guard (`version.ts`) ship in S1 before they are used. The reload guard can wait for S2.
  * `ALERT_TOKEN` on a whole-host ingress prefix (lines 272, 423, 809) departs from round-2 advice to expose only `/` and `/ws`. The doc records it as the author's choice, so it is acceptable; note the one-line exact-path ingress alternative.
  * File 57 says S3 adds the wake-word score, but `blob.md` already cuts diagnostics (D70). Remove it from both.
  * The 6 to 12% Catalan WER (line 341) is roughly supported by the saved model cards (about 6% and about 9 to 12%), but the numbers are self-reported with `verified:false`, and one entry shows 0.96. Mark it as self-reported.
* **Rationale & Recommendation**: Fix the wording and drop the unused fields; each fix is a one-line edit.

## What passes (Zoom-Out)

* Context sufficiency passes: the objective, the reason and the Hermes seam are clear. The repo has no code yet, so there was nothing local to reuse; reuse was checked against the saved Hermes page and `blob.md`.
* Root-problem focus is good. The service owns state (timers, alerts, models) and Hermes stays the brain.
* `stt` and `tts` behind two functions is the right seam. `voice_for` as one dict is the right size. The single `current_turn` lock is simple enough.
* Deferring the filler phrase, stopwatch, lease, streaming, the speaches sidecar and the native wrapper matches the accepted cuts.
* The Kubernetes manifests reuse the existing cluster, cert-manager issuer and ingress.

# Inventive Catalyst Findings

**Reviewer:** `egm-inventive-catalyst` (completed). Verdict: the foundation is mostly balanced. The author already resolved the big contradictions (turn lock, `voice_for` seam, pre-rendered fallback, display precedence). 8 Major and 4 Nit findings; none is a Blocker. The catalyst read the target, `blob.md`, `review_round2.md` and the Hermes API page, and only spot-checked the other saved pages.

Findings are numbered as the catalyst reported them. Items already merged into the main section above are summarized here with a pointer; the full text is in the main section.

## Major

### F1. Hermes timeouts contradict each other because `stream: false` sends no bytes
Lines 150, 158; `turn.py` (file 22). A non-streaming call makes the "no bytes 30 s" timeout a 30 s total cap, so tool-using turns over 30 s fail as `timeout`, and the 90 s watchdog sits below the 120 s total.
* **Resolution (Blessing in Disguise plus Inversion):** call with `stream: true` even in S1, accumulate the text, and let `hermes.tool.progress` frames reset the no-bytes timer. They can later drive a "working" cue. Start the watchdog at `thinking` and keep it above the Hermes total.
* **Secondary liabilities:** SSE parsing, partial text on cancel, strict clients choking on the named event. Fall back to `stream: false` if the S0 test shows odd chunks.
* See main section: "Hermes timeouts contradict each other".

### F2. Streaming was deferred as "real code", but the machinery is already in S1
Lines 238, 448; files 14, 53; Alternative Q. `seq/final`, the `nextT` scheduler and `first_sentence_split` are built, but the benefit is deferred.
* **Resolution (Preliminary Action):** wire the first-sentence flush into S1 behind a config flag. Stream from Hermes, send the first sentence to Kokoro as soon as it completes, then the rest as one chunk. Measure both modes with `timings_report.py`.
* **Secondary liabilities:** ordered playback and stale-chunk drop; STT and TTS contend on the single GPU lock; Spanish `¿¡` in the sentence-end heuristic; a cancelled turn can leave a half-spoken reply.
* See main section: "Tension to resolve", where this conflicts with the zoom-out advice to delete the machinery.

### F3. Timer creation goes through the LLM, but the stated reason for Blob-owned timers is "no LLM in the path"
G6, line 25, Alternative I, lines 198-200, file 29.
* **Resolution (Inversion / Extraction):** make a strict deterministic grammar (number plus unit in es/ca/en) the primary path, answered with a pre-rendered or short TTS reply, and let everything else fall through to Hermes. Keep the Hermes tool path as an optional extra for fuzzy phrases. The roughly 20-line "fallback" becomes the main path and the exit test becomes deterministic.
* **Secondary liabilities:** brittle phrase coverage ("media hora", spoken number words, "un quart"); collisions with questions; cancel and list intents; two creation paths to maintain (keep the grammar tiny and test with clips).
* See main section: "Voice timers".

### F4. Readiness probe on "models loaded" defeats the "HTTP first" startup design
Lines 63, 274, 434; file 63.
* **Resolution:** point both probes at the alive endpoint; expose `models_ready` in the `/healthz` body and in `snapshot`.
* **Secondary liability:** a bad rollout looks healthy to Kubernetes until someone checks `models_ready`; acceptable for one pod and one user.
* See main section: "Readiness probe".

### F5. Blob-side history collides with how Hermes derives sessions
Lines 173, file 19.
* **Resolution (Self-Service):** prefer the documented `X-Hermes-Session-Id` header, one id per conversation, new id after 5 minutes idle. Delete the history object, expiry code and `test_hermes.py` cases. Sending only the new message is also a smaller request.
* **Secondary liabilities:** cancelled and failed turns may still be recorded on the Hermes side; Blob depends on Hermes session retention; keep Blob-side history only as the fallback branch; header behaviour on the author's version is unverified.
* See main section: "Hermes history".

### F6. "Cancel" is only an HTTP abort, with no check that Hermes stops
Lines 252-253, 159.
* **Resolution (Extraction):** add one S0 question: "does closing the connection interrupt the agent?" If not, use `/v1/runs` and its cancel endpoint (shape unverified) for turns only.
* **Secondary liabilities:** a different response shape, run-state cleanup, a possible second code path. If the plain abort stays, state that side effects may continue.
* See main section: "Cancel is only an HTTP abort".

### F7. Held alerts conflict with the 1 s visibility goal
G6, SC5, CUJ 5, lines 105, 206.
* **Resolution (Dynamics):** hold only `info`. For `urgent`, show a rim, tint or pulse on the blob, keep the conversation state dominant, keep sound suppressed. Alternatively define SC5 as "except during a turn".
* **Secondary liabilities:** one more visual rule and a precedence-table row (`view` stays a function); the renderer needs a tint input independent of the shape.
* See main section: "Held alerts".

### F8. Plan detail is far beyond "simplest path, refine later"
Files 1-87; CI, `mypy`, 80% coverage, `docs/runbook.md`, `wake-word-training.md`. The S2-S4 file-level plan (about 45 files) rests on two untested kill-spikes; GitHub Actions, `mypy`, coverage, K8s manifests and a runbook are enterprise-style controls for one household.
* **Resolution (Segmentation):** specify S0 and S1 at file level, keep S2-S4 as a short outline with assumptions, expand each when its predecessor is done. Run `ruff` and `pytest` locally; add CI and the coverage gate later if wanted.
* **Secondary liability:** less ahead-of-time cross-slice consistency, which is the intended trade.
* See main section: "Plan is too big" and "S2-S4 specified file by file".

## Nit

### F9. Server-side wake word is rejected on privacy grounds, though the server is the author's own LAN
G4, Alternative H, line 265. Resolution (Extraction): add a rung before the WebView in the fallback ladder. See main section: "Server-side wake word rung".

### F10. Follow-up listening is triggered by a trailing `?` and opens the mic without a user trigger
Lines 161, 264, G4. Resolution: have Hermes end with a fixed marker only when it expects an answer, stripped by `clean_for_speech`, or edit G4 to list follow-up as a fourth trigger. `followup_max` and the 6 s limit bound the damage either way. Marker compliance is unverified. See main section: "Follow-up listening".

### F11. Possible unused Hermes capability
Line 25; Hermes page lines 402-411 (Jobs API, `hermes cron`). Add an S0 question on whether a cron job can deliver to a URL. See main section: "Possible unused Hermes capability".

### F12. Small wording inconsistencies a fresh reader will trip on
`turn_start` with `busy` versus the protocol table, "D57" defined only in `blob.md`, "re-created by their sources" versus voice timers, and the `wake` row placement. See main section: "Small consistency and wording issues".

## Not flagged by the catalyst

`voice_for` and the `stt`/`tts` seams, the single GPU lock, `Recreate`, the token placement on the open ingress and Catalan input with Spanish output are reasonable accepted trade-offs. The author documented them and recorded the upgrade path.

## Skipped or unchecked

* The zoom-out reviewer did not read the shader, Matxa, hermes-voice or voice-mode pages in depth. The catalyst did not open the shader, Voice Satellite, `hermes-voice`, Whisper-ca or Matxa pages beyond a keyword count.
* The Kokoro voice codes, VRAM figure, tablet behaviour and faster-whisper handling of webm/opus are unverified.
* Biggest risks: zoom-out flags the size of the plan (it may not get built). The catalyst flags the timeout contradiction and the readiness probe (likely to fail on first deployment as written).
