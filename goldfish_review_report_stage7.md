# Goldfish Annotated Review Report

**Status:** resolved (auto accept applied 2026-11-12)
**Target:** `/home/arnau/workspace/meet_blob/docs/designs/blob_design.md` (lines 1-461, everything before `## Detailed Implementation Plan`)
**Source of findings:** `critic_report.md`, Stage 7, round 1 (reviewers `egm-design`, `egm-structural`, `egm-style`, all completed).

Counts: 19 Major, 14 Nit. Suggestions: 31 PROPOSE FIX, 0 CONTEST, 0 ESCALATE, 3 partly DECLINE (noted inside M13, N13 and N14). Line numbers are from the reviewers and shift as edits are applied. Edits are applied from the bottom of the file upward, so earlier line numbers stay valid.

Two fixes below change a design default, not only wording. Look at these first: **M2** (timeout ordering), **M3** (no "no bytes" timer for a non-streaming call), **N1** (Hermes session header becomes the default instead of Blob-side history), **M18** (chime and quiet hours stay in slice 4).

---

## Major

### [Issue 1] [`egm-design`, `egm-structural`] M1 - Severity: Major
*   **Affected Scope:** whole document; scattered risk content at lines 288-296, 419-434, 55-67
*   **Discrepancy Description:** No Risks & Mitigations section, although the feature-spec standard asks for failure modes and mitigations.
*   **Rationale:** Risks sit in NFR bullets, Open Questions and Assumptions. Several have no home.
*   ***AI Suggestion:*** PROPOSE FIX
*   ***Justification:*** Valid. A short table is cheap and gives one place to link from.
*   ***Proposed Edit:***
    *   Location: new `## Risks & Mitigations` between `## Technical Plan (Architecture)` and `## Alternatives Considered`.
    *   Change: a table (risk, effect, mitigation or "accepted", where it is tested) with these rows: GPU out of memory or CUDA init failure (turn ends `stt_fail`/`tts_fail`, fallback spoken, tested in S1); Hermes outage (grey blob, fixed spoken line, pod stays ready; S1); cancelled turn still runs a Hermes tool (cancel flag between stages, Hermes disconnect test; S0); STT text from silence (empty-text drop and `no_speech_prob`; S1); `/alerts` token on the LAN (accepted for a home LAN, one token); voice-reachable Hermes tools (system-message line, separate Hermes profile if it exists; accepted); SQLite corruption after power loss (alerts re-created by sources, `turns` disposable; accepted); `Recreate` downtime (accepted); wake word does not run on the tablet (tap mode, then WebView, then switch; S0); first tap after reboot needed to unlock audio (accepted).

### [Issue 2] [`egm-design`, `egm-structural`, `egm-style`] M2 - Severity: Major
*   **Affected Scope:** lines 111, 143, 150, 158, 286
*   **Discrepancy Description:** The 90 s turn timeout is shorter than the 120 s Hermes total, so the Hermes timeout never fires. The 90 s also counts listening, STT and TTS. Line 111 says "after the timeout" without naming which.
*   **Rationale:** Two overlapping timers with no ordering.
*   ***AI Suggestion:*** PROPOSE FIX
*   ***Justification:*** Valid. This changes a default: Hermes total moves from 120 s to 75 s, and the turn watchdog is split in two so each is shorter than what it guards.
*   ***Proposed Edit:***
    *   Location: state-machine paragraph (line 150), pipeline step 5 (158), CUJ 6 (111), Configuration (286), file 22 text, file 36 text.
    *   Change: "A listening turn ends after 30 s (the client stops at 15 s) or when the WebSocket closes. After `utterance` arrives, a processing watchdog of 120 s measured from arrival covers speech-to-text, Hermes and synthesis. Hermes timeouts: connect 5 s, total 75 s. Both a Hermes total timeout and the processing watchdog end the turn with reason `timeout`; the timing line records which one (`timeout_kind: hermes | turn`)." CUJ 6: "After the Hermes timeout (75 s by default)...". Configuration list: add `listen_watchdog_s` 30, `turn_watchdog_s` 120, `hermes_total_s` 75.

### [Issue 3] [`egm-design`] M3 - Severity: Major
*   **Affected Scope:** lines 158, 286
*   **Discrepancy Description:** `stream: false` with a "no bytes 30 s" timer fails any slow tool-using reply, because a non-streaming response sends nothing until the run ends.
*   **Rationale:** The saved Hermes page says the 10 s SSE keepalive applies to streams only.
*   ***AI Suggestion:*** PROPOSE FIX
*   ***Justification:*** Valid. Drop the no-bytes timer for the non-streaming call. Keep it as a setting that applies only when streaming is turned on later.
*   ***Proposed Edit:***
    *   Location: step 5 (158) and Configuration (286).
    *   Change: "Timeouts (config values): connect 5 s and total 75 s. A no-bytes timer (`hermes_no_bytes_s`, 30 s) applies only if streaming is enabled later, because only a stream sends keepalives."

### [Issue 4] [`egm-design`] M4 - Severity: Major
*   **Affected Scope:** lines 148-153, 156-160, 252
*   **Discrepancy Description:** A tap in `thinking` "aborts the Hermes request", but `thinking` includes STT, and a model call in a worker thread cannot be aborted. Whether a dropped connection stops a Hermes tool run is unverified, so a cancelled turn could still act.
*   **Rationale:** Cancel promises more than the pipeline can do.
*   ***AI Suggestion:*** PROPOSE FIX
*   ***Justification:*** Valid.
*   ***Proposed Edit:***
    *   Location: step 5, Taps table row `thinking`, Hermes open question, Alternatives.
    *   Change: "Cancel sets a flag on the turn. The pipeline checks it after speech-to-text, after Hermes and before synthesis, and discards the result. A model call already running finishes and its output is dropped. Closing the HTTP connection to Hermes is attempted; whether Hermes stops its run when the client disconnects is unverified and is a question for the Hermes test." Add to Open Questions: "Does a client disconnect stop a Hermes run? If not, Hermes's `/v1/runs` endpoint, which documents cancellation, is the alternative." Taps row `thinking`: "sets the cancel flag and drops the result".

### [Issue 5] [`egm-design`] M5 - Severity: Major
*   **Affected Scope:** lines 38, 111, 274, 434
*   **Discrepancy Description:** `/healthz` readiness includes a Hermes check, so a Hermes outage would remove the pod from the ingress and take timers and the page down.
*   **Rationale:** Contradicts G8, CUJ 6 and G6.
*   ***AI Suggestion:*** PROPOSE FIX
*   ***Justification:*** Valid.
*   ***Proposed Edit:***
    *   Location: `/healthz` mentions (lines 38, 274, 434) and file 24 text.
    *   Change: "`/healthz` reports `alive` at once, `ready` when the database is open and both models are loaded, and `hermes_reachable` as a separate field that never affects readiness. The Kubernetes readiness probe uses `ready` only."

### [Issue 6] [`egm-design`] M6 - Severity: Major
*   **Affected Scope:** lines 194, 198
*   **Discrepancy Description:** A repeated POST to an `acked` key with unchanged `text` and `urgency` is ignored and `fire_at` is not compared, so a second identical voice timer within 24 h is never created.
*   **Rationale:** A real use case silently fails.
*   ***AI Suggestion:*** PROPOSE FIX
*   ***Justification:*** Valid.
*   ***Proposed Edit:***
    *   Location: alerts endpoint paragraph (194) and CUJ 4.
    *   Change: "The unchanged-payload test compares `text`, `urgency` and the computed `fire_at`. A request that gives `in_s` always computes a new `fire_at`, so it counts as changed and re-raises the alert. Sources that repeat a status check every minute send no `fire_at` and are ignored while acked." CUJ 4 gains the step: "Setting the same timer twice in one day creates two timers."

### [Issue 7] [`egm-design`] M7 - Severity: Major
*   **Affected Scope:** lines 38, 145-146, 156, 158-159, 167, 233
*   **Discrepancy Description:** The failure paths have gaps: no STT-exception behaviour, no `tts_fail` reason, no stated trigger for the local beep, no GPU out-of-memory case, unclear whether `error` is a state or an overlay, and CUJ 6 orders the grey and the spoken line differently from step 5.
*   **Rationale:** G8 promises a return to idle after any failure.
*   ***AI Suggestion:*** PROPOSE FIX
*   ***Justification:*** Valid.
*   ***Proposed Edit:***
    *   Location: after the pipeline steps; state table row `error`; CUJ 6; `turn_done` reasons (line 233); Taps table.
    *   Change: add a failure table: **STT exception or GPU out of memory**: reason `stt_fail`, fallback line spoken (pre-rendered), lock released. **Hermes error or timeout**: `hermes_fail` or `timeout`, fallback line spoken. **TTS exception**: new reason `tts_fail`, the client plays the local beep, nothing spoken. **Empty speech**: `empty`, no sound, back to idle. **Cancel**: `cancel`, playback stopped. For every row the lock is released when `turn_done` is sent. Define `error` as a display overlay, not a blocking state: after `turn_done` with a reason other than `ok`, `empty` or `cancel`, the client shows the grey view until the fallback audio ends and at least 3 s have passed; taps during it behave as in `idle`, except that a tap during playback stops it. CUJ 6: "The fallback line is spoken, the blob is grey during it and for at least 3 s, then returns to idle." Add `tts_fail` to the reasons list.

### [Issue 8] [`egm-design`] M8 - Severity: Major
*   **Affected Scope:** lines 159, 163, 172
*   **Discrepancy Description:** The voice is chosen from the language Whisper detected in the question, but the reply language is not controlled. English text can reach a Spanish voice, which garbles it.
*   **Rationale:** `voice_for` keys on the wrong language in some cases.
*   ***AI Suggestion:*** PROPOSE FIX
*   ***Justification:*** Valid. Two fixes were offered: instruct Hermes and add a text check on the reply. The first is one line and removes most cases, so the plan takes it; the text check goes to Future Improvements and is built only if the exit test shows mismatches.
*   ***Proposed Edit:***
    *   Location: Hermes client bullet on the system message (line 173); Future Improvements; S1 exit test.
    *   Change: system message: "reply in the language of the user's last message; Catalan counts as Spanish". Known limit: "If Hermes replies in another language than the question (for example when asked for an English translation), the reply is spoken with the voice of the question's language and may sound wrong." Future Improvements: "Reply-language check: detect the language of the reply text and choose the voice from it." S1 exit test (file 8 text) gains one turn: "Ask in Spanish for an English phrase; record whether the voice mismatches."

### [Issue 9] [`egm-design`] M9 - Severity: Major
*   **Affected Scope:** lines 321-325
*   **Discrepancy Description:** Alternative D rejects XTTS-v2 for having no Catalan, but the chosen Kokoro has none either.
*   **Rationale:** The real reason is not stated.
*   ***AI Suggestion:*** PROPOSE FIX
*   ***Justification:*** Valid.
*   ***Proposed Edit:***
    *   Location: Alternative D.
    *   Change: "Cons: Has no Catalan (Kokoro has none either, so this is not the deciding reason). XTTS-v2 is a larger model than Kokoro-82M, and the author's 8 GB budget and latency target favour the smaller model (not measured; unverified). Reason for Rejection: Rejected by author: Kokoro is smaller and its quality is acceptable to the author; XTTS-v2 offers no Catalan advantage."

### [Issue 10] [`egm-design`, `egm-style`] M10 - Severity: Major
*   **Affected Scope:** lines 261, 345-349
*   **Discrepancy Description:** The wake-word alternatives omit microWakeWord, which the saved Voice Satellite page uses as its default because it runs on the CPU of any device. Line 261 states openWakeWord as the detector while line 349 says the engine is chosen in slice 3.
*   **Rationale:** Alternatives incomplete and inconsistent.
*   ***AI Suggestion:*** PROPOSE FIX
*   ***Justification:*** Valid.
*   ***Proposed Edit:***
    *   Location: line 261; Alternative H.
    *   Change: line 261: "openWakeWord is the first candidate. The engine is confirmed by the tablet test." Split Alternative H into H1 (server-side detection: audio leaves before the trigger) and H2 (Porcupine: access key, licence, Catalan unverified). New Alternative H3: microWakeWord. Pros: runs on the CPU of any device; Voice Satellite uses it by default. Cons: a "hey blob" model needs its own training recipe (unverified). Decision: tried second in the tablet test if openWakeWord does not run.

### [Issue 11] [`egm-structural`, `egm-style`] M11 - Severity: Major
*   **Affected Scope:** lines 143, 150, 219-234, 248-254 (and 665 outside the range)
*   **Discrepancy Description:** Line 150 refers to a `turn_start` message that does not exist, and says a second `tap` during a turn "does not start another turn", which conflicts with the Taps table.
*   **Rationale:** Wire message and internal method are confused.
*   ***AI Suggestion:*** PROPOSE FIX
*   ***Justification:*** Valid. File 37's `turn_start` (line 665) is outside the audited range and is fixed in the same edit.
*   ***Proposed Edit:***
    *   Location: line 150 and the test list line in file 37.
    *   Change: "A `tap` or `wake` in `idle` while another connection holds the turn lock gets `error{code: busy}`." Replace "second `turn_start`" with "second `tap` or `wake`" in both places.

### [Issue 12] [`egm-structural`, `egm-style`, `egm-design`] M12 - Severity: Major
*   **Affected Scope:** lines 119, 219-236, 242, 248-254, 272
*   **Discrepancy Description:** Protocol table: `hello` carries `sound` but `sound` comes from `/device-config`; rows out of order; `ping` has no reply; `snapshot` says `conv_state` and `state` says `conv`; `error` lists the close code 4401; binary right after the header can be split by a broadcast; `GET /device-config` missing from the endpoint list; no "audio locked" tap row. Also from the Stage 6 report: a browser needs its device name before it can ask `/device-config`, there is no reply to `hello` for a version mismatch, and whether `/device-config` needs a token is unstated.
*   **Rationale:** One table, several inconsistencies.
*   ***AI Suggestion:*** PROPOSE FIX
*   ***Justification:*** Valid. Adding the device name source and the `hello` reply closes the Stage 6 gaps in the same edit.
*   ***Proposed Edit:***
    *   Location: protocol table and the paragraphs around it; line 119; Taps table.
    *   Change: regroup the table: client to server (`hello`, `tap`, `wake`, `utterance`, `cancel`, `alert_read`, `alert_ack`, `ping`, `client_event`), then server to client (`hello_ok`, `snapshot`, `state`, `tts`, `turn_done`, `error`, `pong`), each with its slice. `hello` carries `version`, `token`, `device` only; `sound` and `wake` come from `GET /device-config`. New `hello_ok{version, ok}`: the page compares versions; on mismatch it follows the reload rule. The device name comes from the install URL (`#t=TOKEN&device=tablet`) and is stored in `localStorage`; `/device-config` needs `DEVICE_TOKEN` in an `Authorization` header. Use `conv` in both `snapshot` and `state`. `error` codes: `busy`, `bad_message`; the 4401 close code is explained in the text only. The backend does not send other JSON messages to a connection between a `tts` header and its binary frame (the hub writes the pair under a per-connection lock). Line 119 gains `GET /device-config`. Taps table gains a first row: "audio locked | unlocks audio and does nothing else".

### [Issue 13] [`egm-structural`, `egm-style`, `egm-design`] M13 - Severity: Major
*   **Affected Scope:** lines 299-415
*   **Discrepancy Description:** The "Reason for Rejection" field holds deferrals and "not rejected" items; entries are uneven; "reviewer memory" appears as a source in five places.
*   **Rationale:** The field name and the content do not match; process wording leaks into the design.
*   ***AI Suggestion:*** PROPOSE FIX (rename and source wording); the uniform "What it is" line for every alternative is DECLINED as low value.
*   ***Justification:*** The rename and the wording fix are cheap. Adding a description to every entry would lengthen a section that is already long.
*   ***Proposed Edit:***
    *   Location: every `**Reason for Rejection**` line in Alternatives; lines 329, 330, 342, 348, 402.
    *   Change: rename to `**Decision and rationale**` and start each with Rejected, Deferred or Chosen. Replace "reviewer memory" with "unverified" (link the saved page where one exists). Alternative G's decision text begins "Chosen as the default (large-v3); turbo is a benchmark candidate."

### [Issue 14] [`egm-structural`, `egm-style`] M14 - Severity: Major
*   **Affected Scope:** lines 15, 55-67, 288-296
*   **Discrepancy Description:** Open Questions and Assumptions overlap and have drifted. The capture-format question (webm/opus) is stale after the PCM decision. Assumption 6 hedges ("is expected to hold"). "Hermes test" and "Tablet test" are used before they are defined.
*   **Rationale:** Two lists for the same unknowns.
*   ***AI Suggestion:*** PROPOSE FIX
*   ***Justification:*** Valid. Keep both lists, since they answer different questions (unknowns vs what the plan depends on), but remove the drift. This also fixes N10.
*   ***Proposed Edit:***
    *   Location: Open Questions (line 63), Assumption 6, Overview (line 15).
    *   Change: delete the capture-format bullet. Assumption 6 becomes "Raw PCM samples go into the speech model without a decoder." Overview line 15: "two short tests, the Hermes test and the tablet test (spikes S0 in the implementation plan)". Open Questions get an intro line: "Each item is answered by the spike or slice named in brackets", and each bullet ends with one of `[S0 Hermes test]`, `[S0 tablet test]`, `[S1]`, `[S3]`.

### [Issue 15] [`egm-style`] M15 - Severity: Major
*   **Affected Scope:** lines 34, 89-93, 161, 264, 282
*   **Discrepancy Description:** G4 and the privacy bullet say audio leaves only after a tap, a key or the wake word, but follow-up listening opens the microphone with none of these. "A key" is also undefined.
*   **Rationale:** The goal is contradicted by the design.
*   ***AI Suggestion:*** PROPOSE FIX
*   ***Justification:*** Valid.
*   ***Proposed Edit:***
    *   Location: G4 (line 34) and the privacy bullet (line 282).
    *   Change: "Audio leaves a device only after an explicit trigger (a tap, a hardware button that sends a tap, or the wake word) or during the 6 s follow-up window after a reply that ends with a question. In tap mode the microphone is open only during a turn."

### [Issue 16] [`egm-style`] M16 - Severity: Major
*   **Affected Scope:** lines 19-25, 305
*   **Discrepancy Description:** Prior-art claims are stated as fact. "No existing project does all of this" is a search result. Voice Satellite skins "cannot be replaced" is second-hand. Hermes voice mode is not browser-only (it also covers Telegram and Discord; only the wake word is limited to CLI, TUI and desktop). "No alerts and no Hermes link" for community projects was not checked. "Hermes does not handle timers" is untested and the sentence lists a stopwatch that NG10 excludes. Alternative A attributes the Android app to the wrong project.
*   **Rationale:** Claims should match their sources.
*   ***AI Suggestion:*** PROPOSE FIX
*   ***Justification:*** Valid.
*   ***Proposed Edit:***
    *   Location: The Problem (lines 19-25); Alternative A (line 305).
    *   Change: "No project found in the 2026-11-12 search did all of this." Voice Satellite: "the developer said in a community thread that skins accept only the exposed settings and CSS overrides." Hermes: "Hermes's voice mode also works in Telegram and Discord; its wake word runs only in the CLI, the terminal UI and the desktop app." Community orb projects: "the ones found were single-user desktop apps; alert and Hermes support were not checked." Timers: "Hermes may not be a good place for timers: it has no reliable clock, and the author wants no LLM in that path. This is untested (Assumption 2)." Remove "stopwatch" from that sentence. Alternative A: "Kiosk Satellite (a separate Android app by the same author) runs the wake word natively."

### [Issue 17] [`egm-style`] M17 - Severity: Major
*   **Affected Scope:** lines 163, 165, 328, 336, 343, 408, 450
*   **Discrepancy Description:** The plan overclaims against its own assumptions: replacing the `ca` voice "adds Catalan speech with no other change"; a sidecar "can replace both later"; large-v3 "fits the 8 GB budget"; Piper has "lower voice quality than Kokoro".
*   **Rationale:** Unverified items written as certain.
*   ***AI Suggestion:*** PROPOSE FIX
*   ***Justification:*** Valid.
*   ***Proposed Edit:***
    *   Location: the lines named above.
    *   Change: line 163: "Replacing the `ca` entry is intended to add Catalan speech; Matxa is a second engine and needs its own loading and sample-rate handling." Line 165: "A sidecar is intended to replace both; its API is unverified." Line 343: "Large-v3 is the default; fit in 8 GB is verified in slice 1." Line 328: "Not compared with Kokoro. The author prefers Kokoro."

### [Issue 18] [`egm-style`] M18 - Severity: Major
*   **Affected Scope:** lines 206, 256, 286, 455
*   **Discrepancy Description:** Chimes and `quiet_hours` are specified in the display rules and configuration but listed under Future Improvements. The long-press diagnostics page is specified in one line with no description.
*   **Rationale:** The same item is both in scope and deferred.
*   ***AI Suggestion:*** PROPOSE FIX
*   ***Justification:*** Valid. The brief (D70) puts the chime in the alerts slice, so it stays in scope for S4 and leaves Future Improvements. The 2-minute repeat for urgent alerts stays deferred.
*   ***Proposed Edit:***
    *   Location: Future Improvements (line 455); display rules; Taps section.
    *   Change: Future Improvements item becomes "Repeat the urgent-alert chime every 2 minutes." Display rules: "One chime file plays on every client with `sound=true` when an alert becomes active, once per alert; `quiet_hours` mutes it." Taps section adds: "The diagnostics view (long press) lists the page version, socket and microphone status, the last turn's timings, and a button that copies a text report."

### [Issue 19] [`egm-style`] M19 - Severity: Major
*   **Affected Scope:** line 36
*   **Discrepancy Description:** G6 says a timer appears within 1 s of the request, but a timer stays `pending` until `fire_at`.
*   **Rationale:** Wrong criterion for timers.
*   ***AI Suggestion:*** PROPOSE FIX
*   ***Justification:*** Valid.
*   ***Proposed Edit:***
    *   Location: G6.
    *   Change: "An alert appears within 1 s of the POST. A timer appears within 1 s of its `fire_at`. Both survive a restart of the service."

---

## Nit

### [Issue 20] [`egm-design`] N1 - Severity: Nit
*   **Affected Scope:** lines 57-58, 64, 173-174, 290
*   **Discrepancy Description:** The saved Hermes page documents `X-Hermes-Session-Id` and `X-Hermes-Session-Key` headers; without the header the session derives from the system prompt plus the first user message, so replaying history can create a new session each time the window slides. A system message layers on top of Hermes's own prompt. Hermes binds to `127.0.0.1:8642` by default.
*   **Rationale:** This is the Stage 5 top finding too (both Stage 5 reviewers recommended the header).
*   ***AI Suggestion:*** PROPOSE FIX
*   ***Justification:*** Valid and worth fixing even though it is a Nit. It changes a default: with the header, Blob does not keep its own history. The Hermes test confirms it.
*   ***Proposed Edit:***
    *   Location: Hermes client and history bullets (lines 173-174); Open Questions; Assumption 1.
    *   Change: "Default: Blob sends a stable `X-Hermes-Session-Id` (one per household, rotated after 5 minutes without a turn) and only the new user message. Hermes keeps the history. If the Hermes test shows that the header does not work, Blob keeps the last 6 completed user and assistant pairs and replays them. Hermes layers Blob's system message on top of its own prompt. Hermes binds to `127.0.0.1:8642` by default, so the pod needs `API_SERVER_HOST` and a network path." Open Questions gain "Is a separate Hermes profile or toolset for Blob possible?".

### [Issue 21] [`egm-design`] N2 - Severity: Nit
*   **Affected Scope:** lines 194, 198, 206
*   **Discrepancy Description:** Missing: what the 21st alert gets, that `pending` and `acked` rows are excluded from the top-alert pick, a cap on the utterance frame, and a field for "marked late".
*   **Rationale:** Small gaps in the alerts contract.
*   ***AI Suggestion:*** PROPOSE FIX
*   ***Justification:*** Valid and cheap.
*   ***Proposed Edit:***
    *   Location: alerts table and endpoints text.
    *   Change: add `late` (boolean) to the table; "the 21st active alert gets HTTP 429"; "`snapshot` lists `active` alerts only"; "the server rejects an `utterance` frame over 1 MB (15 s of 16 kHz 16-bit audio is about 480 KB)". A `ttl_s` on a `pending` row starts when the row becomes `active`; a `pending` row is deleted only by `DELETE`.

### [Issue 22] [`egm-design`] N3 - Severity: Nit
*   **Affected Scope:** lines 155, 238, 295
*   **Discrepancy Description:** Where audio is resampled is not stated: capture is usually 48 kHz, Kokoro output is likely 24 kHz.
*   **Rationale:** An implementer would guess.
*   ***AI Suggestion:*** PROPOSE FIX
*   ***Justification:*** Valid.
*   ***Proposed Edit:***
    *   Location: pipeline step 2 and playback paragraph.
    *   Change: "The worklet resamples the microphone input to 16 kHz. `decodeAudioData` resamples the reply to the context's rate, so playback needs no extra code."

### [Issue 23] [`egm-design`] N4 - Severity: Nit
*   **Affected Scope:** lines 159, 172
*   **Discrepancy Description:** No limit on reply length before TTS.
*   **Rationale:** A long reply holds the GPU lock and delays everything.
*   ***AI Suggestion:*** PROPOSE FIX
*   ***Justification:*** Valid and cheap.
*   ***Proposed Edit:***
    *   Location: pipeline step 6 and Configuration.
    *   Change: "Text over `tts_max_chars` (default 1200) is cut at the last sentence end before the limit, and the cut is logged." Add `tts_max_chars` to Configuration.

### [Issue 24] [`egm-design`] N5 - Severity: Nit
*   **Affected Scope:** lines 213, 429
*   **Discrepancy Description:** No plan for a screen that is on 24 hours.
*   **Rationale:** The brief raised night dimming.
*   ***AI Suggestion:*** PROPOSE FIX
*   ***Justification:*** One open question is enough for now.
*   ***Proposed Edit:***
    *   Location: Open Questions.
    *   Change: "Night mode: should the blob dim on a schedule (brightness, frame rate) to limit heat and screen wear? `[S2]`"

### [Issue 25] [`egm-design`] N6 - Severity: Nit
*   **Affected Scope:** lines 271, 293-294
*   **Discrepancy Description:** faster-whisper (CTranslate2) and Kokoro (PyTorch) in one CUDA image may conflict; Kokoro might run well on CPU.
*   **Rationale:** Unverified but cheap to check.
*   ***AI Suggestion:*** PROPOSE FIX
*   ***Justification:*** Valid.
*   ***Proposed Edit:***
    *   Location: Assumption 5.
    *   Change: append "Slice 1 also confirms that both libraries load in one image and tries Kokoro on the CPU first, which would remove GPU-lock contention."

### [Issue 26] [`egm-structural`] N7 - Severity: Nit
*   **Affected Scope:** line 312
*   **Discrepancy Description:** The claim that Voice Satellite's author does not take pull requests has no link.
*   **Rationale:** The saved README confirms it.
*   ***AI Suggestion:*** PROPOSE FIX
*   ***Justification:*** Valid.
*   ***Proposed Edit:***
    *   Location: Alternative B.
    *   Change: link the claim to `https://github.com/jxlarrea/voice-satellite-card-integration`.

### [Issue 27] [`egm-structural`] N8 - Severity: Nit
*   **Affected Scope:** lines 176-274, 417, 446-460
*   **Discrepancy Description:** `### Future Improvements` sits under `## Additional Resources`; horizontal rules are placed arbitrarily; slice subsections run S4, S3, S2 with cross-cutting parts between them.
*   **Rationale:** Structure.
*   ***AI Suggestion:*** PROPOSE FIX (heading and rules); the reordering of slice sections is DECLINED.
*   ***Justification:*** Moving the heading is cheap. Reordering the Technical Plan would be a large edit for little gain. A slice-to-section index would help instead.
*   ***Proposed Edit:***
    *   Location: `### Future Improvements`; the rule at line 417; Overview.
    *   Change: promote to `## Future Improvements`; put a rule before every H2 from Alternatives onward; add to the Overview: "Slice index: S1 turn pipeline, state machine, taps, display; S2 tablet and deployment; S3 hands-free and follow-up; S4 alerts, timers, shapes."

### [Issue 28] [`egm-structural`, `egm-style`] N9 - Severity: Nit
*   **Affected Scope:** lines 39, 428-434
*   **Discrepancy Description:** "SC1", "SC4", "SC5", "SC6" are used but never defined, and SC2 and SC3 are missing. The criteria restate G-goals.
*   **Rationale:** Undefined IDs (also Stage 6 finding 2).
*   ***AI Suggestion:*** PROPOSE FIX
*   ***Justification:*** Valid.
*   ***Proposed Edit:***
    *   Location: NFR performance bullets; file 1 text mentioning D57 (outside the range; see Issue 14 note).
    *   Change: define "Success criteria SC1 to SC6" in one list: SC1 reply latency (reported, G9, about 6 s expected, no pass mark); SC2 wake-word false accepts under 1 per day over 3 days with the TV on and fewer than 2 misses in 10; SC3 language and accuracy measured on the author's clips, no target; SC4 about 30 fps for 8 h; SC5 alert visible within 1 s (G6); SC6 service alive at once after restart (see Rollout). Each cross-references its G-goal. The file 1 reference "D57's two branches" becomes "the two branches in Alternatives I and the Alerts section (Hermes tool or transcript rule)".

### [Issue 29] [`egm-style`] N10 - Severity: Nit
*   **Affected Scope:** lines 63, 155, 396
*   **Discrepancy Description:** Stale capture-format question.
*   **Rationale:** Moot after the PCM decision.
*   ***AI Suggestion:*** PROPOSE FIX
*   ***Justification:*** Same edit as Issue 14.
*   ***Proposed Edit:***
    *   Location: Open Questions line 63.
    *   Change: delete.

### [Issue 30] [`egm-style`] N11 - Severity: Nit
*   **Affected Scope:** lines 53, 59, 156, 173, 194, 198, 211, 236, 256, 271, 286
*   **Discrepancy Description:** Example values and vague wording in a spec: "triangle ... for example", "green or blue", "red or magenta"; NG10 "first four slices" means the whole design; "Tap once to clear it" omits that the tap reads the alert aloud first; absolute phrasings ("one GPU can serve one pod", "cannot keep a stale alert"); "server-side voice filter" vs "VAD"; "filler lines" refers to a deferred feature; `followup_max` missing from the config list.
*   **Rationale:** A spec should pick or say it is config.
*   ***AI Suggestion:*** PROPOSE FIX
*   ***Justification:*** Valid and cheap.
*   ***Proposed Edit:***
    *   Location: the lines above.
    *   Change: slice 4 shapes: triangle for `timer`, square for all other sources. Colours: `info` is green, `urgent` is red (both config values). NG10: "A stopwatch in this design." NG2: "Catalan speech output in this design." Taps: "tap once to read and clear it". "One GPU is used by one pod at a time under `Recreate`." "Because the client redraws from the latest snapshot, a reconnecting tablet does not keep a stale alert." Replace "server-side voice filter" with "the faster-whisper voice-activity filter (`vad_filter`)". Remove "filler lines" from the history sentence. Add `followup_max`, `followup_listen_s` and `tts_max_chars` to the Configuration list.

### [Issue 31] [`egm-style`] N12 - Severity: Nit
*   **Affected Scope:** lines 341, 402
*   **Discrepancy Description:** "6 to 12% word error" does not match the saved pages (5.97 for the zuazo model; 0.92 to 12.25 across test sets for projecte-aina). "About 3.5 s" has no source.
*   **Rationale:** Figures need attribution.
*   ***AI Suggestion:*** PROPOSE FIX
*   ***Justification:*** Valid.
*   ***Proposed Edit:***
    *   Location: Alternative G; Alternative Q.
    *   Change: "`zuazo/whisper-large-v3-ca` reports 5.97% word error on Common Voice 13; `projecte-aina/whisper-large-v3-ca-3catparla` reports 0.92 to 12.25% across its test sets (the model pages). Neither page shows a CTranslate2 build." "hermes-voice reports about 3.5 s per plain turn in its own README."

### [Issue 32] [`egm-style`, `egm-structural`] N13 - Severity: Nit
*   **Affected Scope:** lines 51, 75, 89-93, 121, 161, 226, 229, 264, 272-273, 280, 422-423, 427-428
*   **Discrepancy Description:** "Turn log" names two things (stdout line and `turns` table); several facts are stated two or more times.
*   **Rationale:** One term per thing.
*   ***AI Suggestion:*** PROPOSE FIX (terms); restating facts once is DECLINED.
*   ***Justification:*** Renaming is mechanical. Removing the repetition would be a broad edit with little benefit.
*   ***Proposed Edit:***
    *   Location: lines above.
    *   Change: "timing line" for the stdout JSON line; "`turns` table" for the stored text. Replace "turn log" accordingly in CUJ 1, Data and Verification text.

### [Issue 33] [`egm-structural`, `egm-style`] N14 - Severity: Nit
*   **Affected Scope:** lines 11, 13, 19-23, 27, 31, 264, 307, 379, 384, 413, 424, 437-444, 448
*   **Discrepancy Description:** No inline links for prior art; Kiosk Satellite has none; resources packed three per line; internal docs are code spans without a section; loose wording ("an Alexa", "the glue", "moving painting", G2 "Understand", "shouts all day", and others).
*   **Rationale:** Polish.
*   ***AI Suggestion:*** PROPOSE FIX (G2 wording and inline links for prior art and Kiosk Satellite); the rest of the wording polish is DECLINED.
*   ***Justification:*** G2 "Understand" is unmeasurable and the links help a reader. The other phrases are tone, not defects.
*   ***Proposed Edit:***
    *   Location: The Problem (lines 19-23); G2; Additional Resources.
    *   Change: link Voice Satellite, Kiosk Satellite (`https://newreleases.io/project/github/jxlarrea/kiosk-satellite/release/2026.9.87`) and hermes-voice in the bullets. G2: "Transcribe Spanish, Catalan and English speech with faster-whisper large-v3 on one GPU; accuracy is measured on the author's clips, with no target. Speak replies..." One resource per bullet in Additional Resources.

---

## Not applied by this report (outside Stage 7's range)

*   Stage 5 and Stage 6 findings in `zoom_out_report.md` and `comprehension_report.md` that do not appear above (for example the size of the plan, `first_sentence_split`, "last voiced frame" definition, the `acked` display rule, `late` flag) are not edited here, except where noted. Say if you want the main ones folded into this round.
