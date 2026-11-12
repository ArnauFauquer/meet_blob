# Goldfish Review Report

**Target:** `/home/arnau/workspace/meet_blob/docs/designs/blob_design.md` (lines 1-461, everything before `## Detailed Implementation Plan`; lines 462-939 not audited)

**Stage:** 7 (Critic Review), round 1

## Reviewer Status

| Reviewer | Status |
| --- | --- |
| `egm-design` | completed |
| `egm-structural` | completed |
| `egm-style` | completed |

Coverage notes:
- `egm-structural` did not read `blob.md` or `review_round2.md`, and only grepped `voice-satellite.html`. Its findings are structure and cross-reference checks. It did not test claims against the history.
- No reviewer could open URLs. Browser, Android, Kokoro, CUDA and Hermes disconnect behaviour are unverified.
- Each reviewer ran once (no instance A/B). No retries were needed.

## Summary

Blockers: 0. Majors: 19. Nits: 14 (some nits are merged groups of reviewer findings).

Verdict: needs revision. The design has the standard's required parts except a Risks & Mitigations section. The main problems are timeout and failure-path contradictions, a few behaviours that break the stated goals (readiness probe, repeated timers, reply language), and claims written as fact that the history marks as unverified.

Severity calibration by the synthesizer: `structural-1-8` was reported Major and is set to Nit here (misplaced heading, no behaviour effect). `style-1-4` was reported Major and is set to Nit (stale open question). All other severities are as reported, or the highest of the merged reviewers.

Finding id map: every reviewer id appears in exactly one finding below.

## Prioritized Findings (Blockers -> Major -> Nits)

No Blockers.

---

## Major

### M1. No Risks & Mitigations section - Severity: Major
* **Finding ids:** design-1-1, structural-1-1
* **Reviewer Lens:** `egm-design`, `egm-structural`
* **Affected Scope:** whole scope; scattered risk content at lines 288-296 (Assumptions), 419-434 (NFR), 55-67 (Open Questions)
* **Discrepancy Description:** The feature-spec standard requires failure modes, limits and mitigations. The design scatters them across NFR bullets, Open Questions, Assumptions and inline "unverified" notes. Several risks have no home: GPU out-of-memory or CUDA init failure, side effects of a cancelled Hermes call, Hermes outage taking the pod down, SQLite corruption after power loss, STT hallucination on silence, `/alerts` token on the LAN, voice-reachable Hermes tools, Recreate downtime.
* **Rationale & Recommendation:** Add a short `## Risks & Mitigations` table (risk, effect, mitigation or "accepted", source line or slice that tests it). 8-10 rows is enough for a hobbyist. Link existing items to it instead of copying them.

### M2. Turn timeout (90 s) is shorter than the Hermes total timeout (120 s) - Severity: Major
* **Finding ids:** design-1-2, structural-1-4, style-1-2, style-1-21 (Nit, merged)
* **Reviewer Lens:** `egm-design`, `egm-structural`, `egm-style`
* **Affected Scope:** lines 111, 143, 150, 158, 286
* **Discrepancy Description:** The turn lock is released at 90 s, so the 120 s Hermes timeout can never fire. A new turn can start while the old pipeline still holds the GPU lock or the Hermes connection and may send stale audio. The 90 s also counts the listening phase and STT and TTS time. Line 111 says "after the timeout" without naming which one, and without the 3 s grey.
* **Rationale & Recommendation:** Pick one ordering and state it once. Either make the turn timeout larger than STT + Hermes total + TTS (for example 150 s), or make the 90 s timeout cancel the pipeline and lower the Hermes total to about 60-75 s. Name the `turn_done` reason that each timeout emits. Align the state table row, pipeline step 5, line 111 and the config list.

### M3. Non-streaming Hermes call with a "no bytes 30 s" timer - Severity: Major
* **Finding ids:** design-1-3
* **Reviewer Lens:** `egm-design`
* **Affected Scope:** lines 158, 286
* **Discrepancy Description:** The call is `stream: false`. A non-streaming response sends nothing until the agent run ends, so any tool-using reply over 30 s fails as `timeout` or `hermes_fail`. The 120 s total then never applies. The saved Hermes API page (`hermes-api-server.html`, around line 136) says the 10 s SSE keepalive applies to streams only.
* **Rationale & Recommendation:** For `stream:false`, drop the no-bytes timer and use connect plus total only. Or use `stream:true` and discard text until done, so the keepalive makes the timer meaningful. State the choice.

### M4. Cancel semantics are underspecified - Severity: Major
* **Finding ids:** design-1-4
* **Reviewer Lens:** `egm-design`
* **Affected Scope:** lines 148-153, 156-160, 252
* **Discrepancy Description:** A tap in `thinking` "aborts the Hermes request", but `thinking` starts when the utterance arrives, so STT is included. A model call in a worker thread under the GPU lock cannot be aborted, so the pipeline would continue to Hermes and TTS. Whether a dropped HTTP connection stops a Hermes tool run is unverified. A "cancelled" turn could still switch off the lights. The saved page documents `/v1/runs` with cancellation and `finish_reason: "cancelled"` but not client-disconnect behaviour.
* **Rationale & Recommendation:** Check a cancel flag between stages (after STT, after Hermes, before TTS) and discard results. Add a Hermes spike item: "does a client disconnect stop the run?". If not, add `/v1/runs` plus an explicit cancel to Alternatives.

### M5. `/healthz` readiness includes a Hermes check - Severity: Major
* **Finding ids:** design-1-5
* **Reviewer Lens:** `egm-design`
* **Affected Scope:** lines 38, 111, 274, 434
* **Discrepancy Description:** If the Kubernetes readiness probe uses `/healthz`, a Hermes outage marks the pod NotReady. The ingress then drops it and the page, `/ws` and `POST /alerts` all go dark. This contradicts G8 and CUJ 6 (grey blob plus spoken fallback) and G6 (timers work with no LLM).
* **Rationale & Recommendation:** Readiness means models loaded and DB open only. Report Hermes reachability as a separate field that does not gate readiness.

### M6. Repeated timer with the same key is silently ignored - Severity: Major
* **Finding ids:** design-1-6
* **Reviewer Lens:** `egm-design`
* **Affected Scope:** lines 194, 198
* **Discrepancy Description:** A POST to an `acked` key with unchanged `text` and `urgency` is ignored, and `fire_at` is not in the comparison. A second voice timer with the same text and key within 24 h is never created.
* **Rationale & Recommendation:** Include `fire_at` in the changed-payload test, or treat a new `fire_at` as a new activation, or require server-generated keys for `source=timer`. Add a CUJ step "set the same timer twice in a day".

### M7. Failure matrix and error taxonomy have gaps - Severity: Major
* **Finding ids:** design-1-7
* **Reviewer Lens:** `egm-design`
* **Affected Scope:** lines 38, 145-146, 156, 158-159, 167, 233
* **Discrepancy Description:** `stt_fail` exists but step 3 does not say what happens on an STT exception. G8 promises a spoken line only for Hermes failure. TTS failure is in G8 but there is no `tts_fail` reason, and the local beep (line 167) has no stated trigger. GPU OOM is not covered. `error` is entered "when the turn ends", yet `idle` is also entered on `turn_done`. CUJ 6 says grey for 3 s then the fallback is spoken, but step 5 speaks first then ends the turn. The Taps table has no `error` row, and it is unclear whether the lock is held for the 3 s.
* **Rationale & Recommendation:** Add a failure matrix: failure, `turn_done` reason, spoken line or beep, display, lock release. Say whether `error` is a display overlay on `idle` or a state that blocks taps.

### M8. Voice is chosen from the input language, not the reply language - Severity: Major
* **Finding ids:** design-1-8
* **Reviewer Lens:** `egm-design`
* **Affected Scope:** lines 159, 163, 172
* **Discrepancy Description:** `voice_for(lang)` uses the STT-detected input language. The system message says only "Spanish or English" and does not tell Hermes to reply in the user's language. A Spanish speaker asking for an English translation, or a reply in English to a Catalan question, sends English text to a Spanish Kokoro voice (garbled output).
* **Rationale & Recommendation:** Tell Hermes to answer in the user's language (ca falls to es). Or run a cheap text language check on the reply with the STT language as fallback. Add one exit-test turn for this case.

### M9. Alternative D rejection reason contradicts the chosen option - Severity: Major
* **Finding ids:** design-1-9
* **Reviewer Lens:** `egm-design`
* **Affected Scope:** lines 321-325
* **Discrepancy Description:** XTTS-v2 is rejected because it "has no Catalan", but Kokoro is chosen and also has no Catalan (NG2, G2). The real differentiator (VRAM, latency, licence, quality) is not stated.
* **Rationale & Recommendation:** State the deciding trade-off, flagged unverified if not measured.

### M10. Wake-word alternatives are incomplete; engine status is inconsistent - Severity: Major
* **Finding ids:** design-1-10, style-1-15 (Nit, merged)
* **Reviewer Lens:** `egm-design`, `egm-style`
* **Affected Scope:** lines 261, 345-349
* **Discrepancy Description:** Alternative H compares only server-side detection and Porcupine. Slice 3 commits to openWakeWord on ONNX Runtime Web with one thread. The saved Voice Satellite page uses microWakeWord as default ("pure-JS CPU, works on every device") and lists openWakeWord as WebGPU-only, which matters for an older tablet. Line 261 states openWakeWord as the detector while line 349 says the engine "is still chosen in slice 3".
* **Rationale & Recommendation:** Add microWakeWord as an alternative with its trade-off (custom "hey blob" training is a separate recipe, unverified). Name the engine order for the tablet test. Write "openWakeWord is the first candidate" at line 261. Split Porcupine from server-side detection in H.

### M11. `turn_start` is not a protocol message; tap-during-turn text conflicts with the Taps table - Severity: Major
* **Finding ids:** structural-1-3, style-1-1
* **Reviewer Lens:** `egm-structural`, `egm-style`
* **Affected Scope:** lines 143, 150, 219-234, 248-254 (and 665 outside scope)
* **Discrepancy Description:** Line 150 says the backend answers `busy` "to a second `turn_start`". The protocol table has only `tap` and `wake`. Line 150 also says a second `tap` during a turn "does not start another turn", while the Taps table (248-254) makes taps in `speaking`, `thinking` and `listening` cancel or send.
* **Rationale & Recommendation:** Write: a `tap` or `wake` in `idle` while another device holds the turn lock gets `busy`. Remove `turn_start` here and at line 665.

### M12. WebSocket protocol table is inconsistent - Severity: Major
* **Finding ids:** structural-1-2, style-1-16 (Nit), design-1-14 (Nit), structural-1-13 (Nit)
* **Reviewer Lens:** `egm-structural`, `egm-style`, `egm-design`
* **Affected Scope:** lines 119, 219-236, 242, 248-254, 272
* **Discrepancy Description:**
  - `hello` carries `sound` (221) but line 242 and `config/devices.json` say `sound` comes from `GET /device-config`. One is wrong.
  - Client-to-server rows (`wake`, `alert_read`, `alert_ack`) sit between server rows.
  - `ping` has no server reply row.
  - `snapshot` uses `conv_state`, `state` uses `conv`.
  - `error` lists `4401`, which is a WebSocket close code.
  - "Binary right after the JSON header" breaks if the scheduler broadcasts a `snapshot` in between.
  - Endpoint list at line 119 omits `GET /device-config`. The Taps table has no "audio locked" row although 242 defines that behaviour.
* **Rationale & Recommendation:** Regroup rows by direction with slice tags. Fix `hello` or line 242. Use one field name. Remove 4401 from `error`. Either lock per connection for header+binary pairs or let the client tolerate interleaved JSON. Add the endpoint to line 119 and the missing tap row.

### M13. Alternatives "Reason for Rejection" field holds non-rejections; entries are uneven - Severity: Major
* **Finding ids:** structural-1-5, style-1-20 (Nit), design-1-18 (Nit, Alt G part), structural-1-7 (Nit)
* **Reviewer Lens:** `egm-structural`, `egm-style`, `egm-design`
* **Affected Scope:** lines 299-415; notably 313, 319, 329-331, 342-343, 348-349, 402-403, 409, 415
* **Discrepancy Description:** Alt G says "Not rejected". Alts Q, R, S are "Deferred". Alt E is "Not chosen... Deferred". Line 300 says deferred items are not rejections, but the field name does not reflect it. Many reasons are "Rejected by author" plus a restatement. Alt A has an extra "What it is" field. Alts B-D, H-L, P, R have no description. "Reviewer memory" (329, 330, 342, 348, 402) is process talk with no checkable source. Alt G fine-tune facts: saved pages show `zuazo/whisper-large-v3-ca` (WER 5.97 on Common Voice 13) and `projecte-aina/whisper-large-v3-ca-3catparla` (Apache-2.0); neither shows a CTranslate2 build, so faster-whisper conversion stays unverified.
* **Rationale & Recommendation:** Rename the field "Decision and rationale" (Chosen, Rejected or Deferred). Use one field set for all entries. Give each rejection a concrete trade-off. Replace "reviewer memory" with "unverified" plus a link when one exists.

### M14. Open Questions and Assumptions duplicate each other; one question is stale - Severity: Major
* **Finding ids:** structural-1-11 (Nit), style-1-5, style-1-4 (set to Nit, see below)
* **Reviewer Lens:** `egm-structural`, `egm-style`
* **Affected Scope:** lines 15, 55-67, 288-296
* **Discrepancy Description:** The two lists cover the same unknowns (Hermes, tablet, GPU, Kokoro, wake word, PCM) in different formats with no link. They have already drifted: the capture-format question (63) asks about webm/opus although line 155 and Alt P chose PCM. Assumption 6 "so this is expected to hold" is hedging with no reader decision. "Hermes test" and "Tablet test" are named but defined only in the implementation plan.
* **Rationale & Recommendation:** Keep one list with an owner (spike or slice) per item. Drop the stale capture question and the hedge in Assumption 6. Point to the S0 spikes.

### M15. Privacy goal says audio leaves only after a tap, key or wake word; follow-up listening breaks this - Severity: Major
* **Finding ids:** style-1-3
* **Reviewer Lens:** `egm-style`
* **Affected Scope:** lines 34, 89-93, 161, 264, 282
* **Discrepancy Description:** G4 and the privacy bullet say audio leaves the device only after a tap, a key or the wake word. After a reply ending in `?`, the microphone opens for 6 s with none of these triggers.
* **Rationale & Recommendation:** Add "or the 6 s follow-up window after a reply ending in `?`" to lines 34 and 282.

### M16. Prior-art and Hermes capability claims stated as fact - Severity: Major
* **Finding ids:** style-1-9, style-1-10, style-1-11
* **Reviewer Lens:** `egm-style`
* **Affected Scope:** lines 19-25, 305
* **Discrepancy Description:**
  - Line 19 "No existing project does all of this" is a search result. Write "No project found in the 2026-11-12 search did all of this".
  - Line 21: Voice Satellite "skins cannot be replaced" is a second-hand developer reply in `blob.md`.
  - Line 22: wake word and voice mode "only in CLI, TUI and desktop app". `hermes-voice-mode.md` (lines 4, 9) shows voice mode also covers Telegram and Discord. Only the wake word is limited (verified at line 13).
  - Line 23: community projects have "no alerts and no Hermes link", but `blob.md` marks them "Not checked".
  - Line 25: "Hermes does not handle timers" is untested (Assumption 2, round-2 N5). It also lists a stopwatch that NG10 excludes.
  - Line 305: Voice Satellite "has a native Android app" conflicts with `blob.md`, which attributes the app to Kiosk Satellite. Unverified; the saved page mentions both.
* **Rationale & Recommendation:** Calibrate each claim, split the two Hermes claims, attribute the app to Kiosk Satellite, and drop the stopwatch.

### M17. Plan statements overclaim relative to the Assumptions - Severity: Major
* **Finding ids:** style-1-6, style-1-12, style-1-13 (Nit)
* **Reviewer Lens:** `egm-style`
* **Affected Scope:** lines 163, 165, 328, 336, 343, 408, 450
* **Discrepancy Description:** Line 163 says replacing the `ca` entry "adds Catalan speech with no other change", but Alt F says Matxa is "a second engine next to Kokoro" and line 450 puts Piper behind `voice_for("ca")`. Line 165 says a sidecar "can replace both later" while Alt R marks the sidecar API unverified. Line 343 says large-v3 "fits the 8 GB budget" while Assumption 4 (293) says fit is unmeasured until slice 1, and omits turbo. Line 328 "Lower voice quality than Kokoro" is unmeasured.
* **Rationale & Recommendation:** Use "is intended to allow" and name the extra work (second engine, sample-rate handling). Write "Large-v3 is the default, fit is verified in slice 1". Write "Not compared with Kokoro. The author prefers Kokoro."

### M18. Spec contradicts Future Improvements - Severity: Major
* **Finding ids:** style-1-7
* **Reviewer Lens:** `egm-style`
* **Affected Scope:** lines 206, 256, 286, 455
* **Discrepancy Description:** Lines 206 and 286 specify chimes and `quiet_hours` as current. Future Improvements (455) defers "Chime and quiet hours". Line 256 specifies a diagnostics page on long press that has no spec and no Future entry.
* **Rationale & Recommendation:** Specify each item or defer it, not both. Add the diagnostics page to one side.

### M19. G6 timer latency criterion is wrong for timers - Severity: Major
* **Finding ids:** style-1-8
* **Reviewer Lens:** `egm-style`
* **Affected Scope:** line 36
* **Discrepancy Description:** "A timer or alert appears within 1 s of the request". A timer stays `pending` until `fire_at` and is not shown before then.
* **Rationale & Recommendation:** "An alert appears within 1 s of the POST. A timer appears within 1 s of `fire_at`."

---

## Nit

### N1. Known Hermes API facts not yet in Open Questions - Severity: Nit
* **Finding ids:** design-1-11
* **Reviewer Lens:** `egm-design`
* **Affected Scope:** lines 57-58, 64, 173-174, 290
* **Discrepancy Description:** Saved docs show `X-Hermes-Session-Id` and `X-Hermes-Session-Key` headers (`hermes-api-server.html` lines 35, 120, 277, 429). Without the header the session derives from the system prompt plus the first user message (line 120), so replayed history could create a new Hermes session per window slide. A system message layers on top of Hermes's own prompt (line 435). Hermes binds to `127.0.0.1:8642` by default (line 25), so the pod needs `API_SERVER_HOST` and a network path. A per-profile toolset is unverified.
* **Rationale & Recommendation:** Update the Open Questions with these facts. Use a stable session ID and consider a dedicated Blob profile. This could cause doubled history, so treat it as a likely early fix.

### N2. Missing alert limits and frame cap - Severity: Nit
* **Finding ids:** design-1-12
* **Reviewer Lens:** `egm-design`
* **Affected Scope:** lines 194, 198, 206
* **Discrepancy Description:** Not stated: what the 21st active alert gets (429 or drop oldest); that `pending` and `acked` rows are excluded from `snapshot` and from the top-alert pick; a cap on the binary utterance frame (15 s is about 480 KB). "Marked late" (198) has no field in the table.
* **Rationale & Recommendation:** Add one sentence for each.

### N3. Audio sample-rate handling unspecified - Severity: Nit
* **Finding ids:** design-1-13
* **Reviewer Lens:** `egm-design`
* **Affected Scope:** lines 155, 238, 295
* **Discrepancy Description:** Capture is "16 kHz mono PCM from one AudioWorklet" but getUserMedia usually gives 48 kHz, and Kokoro output is likely 24 kHz (unverified) on "one AudioContext".
* **Rationale & Recommendation:** State where resampling happens. `AudioContext({sampleRate:16000})` for capture is one option to test. Playback needs the context rate or a separate context.

### N4. No cap on reply length before TTS - Severity: Nit
* **Finding ids:** design-1-15
* **Reviewer Lens:** `egm-design`
* **Affected Scope:** lines 159, 172
* **Discrepancy Description:** A long Hermes reply causes one long synthesis under the GPU lock and a large WAV, which hits G9 and blocks other GPU work.
* **Rationale & Recommendation:** Truncate to N sentences or characters and log the truncation.

### N5. No 24/7 display plan - Severity: Nit
* **Finding ids:** design-1-16
* **Reviewer Lens:** `egm-design`
* **Affected Scope:** lines 213, 429
* **Discrepancy Description:** The blob is a living-room "moving painting" but SC4 tests only 8 h. `blob.md` R12 and Q10 raised night dimming and charge behaviour; the design dropped it.
* **Rationale & Recommendation:** Add one open question or config line (night schedule, brightness).

### N6. Possible CUDA stack conflict; Kokoro on CPU not considered - Severity: Nit
* **Finding ids:** design-1-17
* **Reviewer Lens:** `egm-design`
* **Affected Scope:** lines 271, 293-294
* **Discrepancy Description:** Unverified. faster-whisper (CTranslate2) and Kokoro (PyTorch) in one CUDA image can conflict on cuDNN or CUDA versions. Only CTranslate2 is pinned. Kokoro (82M parameters) may run acceptably on CPU, which would also remove GPU-lock contention.
* **Rationale & Recommendation:** Add a slice 1 note: confirm both stacks load in one image and try Kokoro on CPU first.

### N7. Alternative B lacks a link for the maintainer claim - Severity: Nit
* **Finding ids:** structural-1-6
* **Reviewer Lens:** `egm-structural`
* **Affected Scope:** line 312
* **Discrepancy Description:** "Its author does not take pull requests" has no link. The saved README confirms "Pull requests are currently not being accepted" (also cited by `design-1-18`).
* **Rationale & Recommendation:** Link `https://github.com/jxlarrea/voice-satellite-card-integration#readme`.

### N8. Misplaced and inconsistent headings and rules - Severity: Nit
* **Finding ids:** structural-1-8 (reported Major), structural-1-9, structural-1-12
* **Reviewer Lens:** `egm-structural`
* **Affected Scope:** lines 176-274, 417, 446-460
* **Discrepancy Description:** `### Future Improvements` is an H3 under `## Additional Resources`. The horizontal rule at 417 is arbitrary (rules appear only at 7, 417, 460). Slice subsections run S4, S3, S2 with cross-cutting sections between them.
* **Rationale & Recommendation:** Promote Future Improvements to its own `##`. Use a rule at every H2 or only after the metadata. Group cross-cutting parts first, then slice sections in order, or add a slice-to-section index in the Overview.

### N9. NFR IDs undefined and non-contiguous; goal restatements - Severity: Nit
* **Finding ids:** structural-1-10, style-1-22
* **Reviewer Lens:** `egm-structural`, `egm-style`
* **Affected Scope:** lines 39, 428-434
* **Discrepancy Description:** IDs SC1, SC4, SC5, SC6 appear; "SC" is never defined and SC2 and SC3 are missing. SC1, SC5 and "8 GB" restate G9, G6 and G3 with no cross-reference. "Loose target" gives no pass mark.
* **Rationale & Recommendation:** Rename to NFR1... or define SC. Reference G-IDs. Write "reported, no pass mark, about 6 s expected".

### N10. Stale open question about capture format - Severity: Nit
* **Finding ids:** style-1-4 (reported Major)
* **Reviewer Lens:** `egm-style`
* **Affected Scope:** lines 63, 155, 396
* **Discrepancy Description:** The question whether faster-whisper accepts webm/opus is moot after the PCM decision.
* **Rationale & Recommendation:** Drop it (also covered under M14).

### N11. Unresolved example values and vague spec wording - Severity: Nit
* **Finding ids:** style-1-18, style-1-19, style-1-23, style-1-24, style-1-25
* **Reviewer Lens:** `egm-style`
* **Affected Scope:** lines 53, 59, 156, 173, 194, 198, 211, 236, 256, 271, 286
* **Discrepancy Description:**
  - Line 211: "triangle ... for example", "green or blue", "red or magenta". A spec should pick one or say it is config.
  - NG10 "first four slices" means this whole design. NG2 "first slices" is vague. NG11 mixes non-goals and deferrals.
  - Line 256 "Tap once to clear it": the tap reads the alert aloud first.
  - Line 271 "one GPU can serve one pod" overclaims. Line 236 "cannot keep a stale alert" is absolute.
  - "Server-side voice filter" versus VAD/`vad_filter` is two terms for one thing. "Filler lines" (173) refer to a feature deferred in NG11. Line 194 gives limits but not the at-limit behaviour. Line 286 omits `followup_max` and mixes env vars with a config file.
* **Rationale & Recommendation:** Pick one value or mark as config. Use "this design". Reword to the exact behaviour. Use one term per thing.

### N12. Prior-art facts need source attribution - Severity: Nit
* **Finding ids:** style-1-14
* **Reviewer Lens:** `egm-style`
* **Affected Scope:** lines 341, 402
* **Discrepancy Description:** "6 to 12% word error" does not match the saved pages (5.97 for the zuazo model; 0.92 to 12.25 across test sets for projecte-aina). "About 3.5 s" has no source; it appears in `hermes-voice.html` as another project's figure.
* **Rationale & Recommendation:** Name the model and test set. Attribute the 3.5 s figure.

### N13. Repeated definitions and the "turn log" term - Severity: Nit
* **Finding ids:** style-1-17, style-1-26, structural-1-15
* **Reviewer Lens:** `egm-style`, `egm-structural`
* **Affected Scope:** lines 51, 75, 89-93, 121, 161, 226, 229, 264, 272-273, 280, 422-423, 427-428
* **Discrepancy Description:** "Turn log" names the stdout JSON line (75, 280) and the `turns` table (226). Facts are stated two or more times: Hermes cannot push, the ingress and token paragraph, G3 and G9 versus NFR, and the follow-up flow (including the long step 8 and follow-up bullet).
* **Rationale & Recommendation:** Use "timing line" for stdout and "`turns` table" for stored text. State each fact once and link to it.

### N14. Links and wording polish - Severity: Nit
* **Finding ids:** structural-1-14, style-1-27
* **Reviewer Lens:** `egm-structural`, `egm-style`
* **Affected Scope:** lines 11, 13, 19-23, 27, 31, 264, 307, 379, 384, 413, 424, 437-444, 448
* **Discrepancy Description:** Prior art at 19-23 has no inline links; Kiosk Satellite has no link anywhere; resources are packed three per line (440, 443, 444). Internal docs are code spans, and line 307 cites `docs/designs/blob.md` with no section. Informal or vague wording: "an Alexa", "the glue", "does the thinking", "moving painting", "small", G2 "Understand" (unmeasurable), "for nothing", "looks flat", "distributed-systems work", "shouts all day", "or similar", "real splitter".
* **Rationale & Recommendation:** Add inline links, one resource per bullet with descriptive text, markdown links for internal docs with a section name. Replace the loose phrases (for example G2: "Transcribe, with accuracy measured and no target"; line 424: name the devices).

---

## Not verified (carried from reviewers)

- Hermes wake word "English only" (line 318): the saved page confirms an English model download, not "only".
- XTTS-v2 "no Catalan" (324), and Piper and Porcupine licence and Catalan claims (329, 330, 342, 348): sourced to the author or to reviewer memory.
- Browser, Android, Kokoro, CUDA behaviour, Hermes disconnect-versus-cancel, Kokoro output rate, CTranslate2 builds of the Catalan fine-tunes.
- External URLs were not opened by any reviewer.
