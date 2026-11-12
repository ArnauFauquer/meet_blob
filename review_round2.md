# Blob concepts brief: round 2 re-review

**Target:** `/home/arnau/workspace/meet_blob/concepts_brief.md` (read only; not edited)
**Date:** 2026-11-12
**Mode:** BRAINSTORM, round 2
**Scope:** decisions D15 to D50, NG9, Q13, Prior Art, staging.
**Context applied:** solo hobbyist, one household, one 8 GB VRAM GPU, one tablet plus a desktop browser. No enterprise controls are requested below. Where a finding mentions security or data loss, the fix is the smallest one that works.

**Evidence rule:** reviewers could not open URLs or run code. Every statement about an external product, a browser, an Android behaviour or a library API is from reviewer memory and is **unverified** unless the brief itself reports it. Nothing here was benchmarked.

## Reviewer status

| Reviewer | Status |
| --- | --- |
| `egm-design` | completed |
| `egm-codebase-details` | completed |
| `egm-zoom-out` | completed |
| `egm-comprehension` | completed |
| `egm-implementation-readiness` | completed |
| `egm-structural` | completed |
| `egm-inventive-catalyst` | completed |

All seven returned a report on the first attempt. No retries.

## Summary

The round 2 defaults are mostly sensible. The main problems are:

1. The gesture model and the sound target are not defined, and they break the alert flow (N1, N2).
2. The brief still describes the round 1 design in many places, so a reader in a month will build the old design (N3).
3. The WebSocket and audio format have no definition, although everything depends on them (N4).
4. The stated reason for option C (Hermes cannot do timers) rests on a Hermes capability nobody has tested (N5).
5. The Stage 0 TLS shortcut is wrong for the tablet (N6).
6. Stage 0 and Stage 1 are far larger than "1 to 2 days" and "a voice loop" (N9, N22). A slice 1 that fits a couple of weekends is given below.

Counts: 6 blockers, 16 majors, 4 nits.

---

## Findings

Severity meaning: **blocker** = cannot build the next stage correctly, or the plan fails as written. **major** = likely to cause rework, a visible bug or data loss. **nit** = wording or small cleanup.

### Blockers

#### N1. One tap has four or five meanings and none is defined together
- **Lens:** design, codebase-details, comprehension, implementation-readiness, structural, zoom-out, inventive-catalyst (all seven)
- **Decisions:** D16, D20, D47, D27, NG7
- **Problem:** D16 says a tap always starts listening. D20 says a tap reads and clears the alert. D47 puts diagnostics on a long press. Nothing says what a tap does while thinking or speaking. With no barge-in (NG7) there is no way to stop a long reply. When an alert is open, the user cannot start a turn by tap. A permanent alert (the D50 stopwatch) would block tap-to-talk for good. D20 also clears the alert on tap, so if audio is locked or TTS fails, the alert vanishes unread.
- **Simple fix:** add a gesture table keyed by state; first matching row wins.

  | State | Tap does |
  | --- | --- |
  | alert showing | read the alert aloud, then clear it after playback ends (not before) |
  | speaking | stop playback |
  | thinking | cancel (abort the Hermes request) |
  | listening | stop and send |
  | idle, no alert | start listening |

  To talk while an alert is open: tap once to clear it, tap again. Wake word (Stage 3) always starts a turn. Long press stays diagnostics. Tap-to-stop and tap-to-cancel replace stop phrases (see N22).

#### N2. "Active device" and "sound target" have no owner when no turn is running
- **Lens:** design, comprehension, implementation-readiness, structural, inventive-catalyst
- **Decisions:** D12, D27, D36, D20, D40
- **Problem:** D12 says sound plays only on the active device, defined as the mic-lock holder. D36 releases the lock at the end of every turn. Between turns nobody is active, so the D27 urgent chime and the D20 read-aloud have no target. After a tablet or PWA restart the browser's audio is locked until a tap. D20 then clears the alert on that unlocking tap. D40 hides the "audio locked" icon after 5 s although the fault remains.
- **Simple fix:**
  - Sound goes to every client that has `sound=true` (a per-device setting stored on the device: tablet on, desktop off). During a turn, audio goes to the client that started the turn. The mic lock concerns the mic only.
  - While audio is locked, keep the "audio locked" cue on permanently. A tap in that state only unlocks audio and clears nothing.
  - Use one `AudioContext`; call `resume()` on every tap.

#### N3. The brief has no single current truth; round 1 text still reads as current
- **Lens:** structural, comprehension, inventive-catalyst
- **Sections:** Overview ("Status today"), Stack, Language matrix, Behaviour states, Alternatives "Chosen" column, Decision log D1 to D14, Q-table, Staging, "Next three actions", Success criteria table, glossary
- **Problem (stale items found):**
  - "hola blob" is still the phrase in the Overview, Stack, Language matrix, Stage 0 item 2, Stage 2 and the Alternatives rows. D17 chose "hey blob"; D49 treats "hola blob" as the later second phrase.
  - Behaviour-states table still says `thinking` = shape cycle. D25 changed it. D13 still says "Decided (user approved)".
  - D9, D11, D13, D14 still say "Open" or "under question". D21, D36, D24, D28 resolve them. D3 says language is "limited to {ca,es,en}"; D35 says auto-detect then re-run.
  - "One container" in Overview, D1 and G7. D34 makes two containers in one pod.
  - Alternatives rows say "Open", "Not defined", "smooth-min", "Stream". Option C says "D15 to D43". Option A is still labelled "recommended".
  - Q1, Q2, Q3, Q5 to Q9, Q12 are resolved by D18 to D43 but carry no status. "Next three actions" and Stage 3 still say "decide Q1, Q2, Q6, Q7, Q9". The glossary still says "Attended: undefined".
  - Success criteria table says "TBD" although D41 sets values. The staging heading still says "user to confirm" although D43 accepts it. D43 says "staging above"; the staging is below.
  - Stage 1 says "whole-reply TTS first"; D7 and G4 say sentence streaming is decided.
  - Prior Art is written in first person and sits between findings and goals.
- **Simple fix:** do not rewrite the file. Add a short **Current design** section at the top (component list, current decisions, live open items: Q10, Q13, clip log from Q11). Add a `Status` / `Superseded by` column to the decision log and the Q-table (D9 to D21, D11 to D36, D13 to D24/D25, D14 to D28, D3 to D35, D5 to D17, D1 to D34). Do one search-and-replace for the wake phrase. Fix the `thinking` row once. Mark R1 to R32 and Prior Art as history.

#### N4. WebSocket messages, audio format and the playback queue are undefined
- **Lens:** implementation-readiness, structural, codebase-details, design
- **Decisions:** D10, D12, D18, D19, D36, D38, D47
- **Problem:** only `/alerts` has a schema. The WebSocket carries state, alerts, TTS audio, level, hello, version and turn timings, with no message list, no binary versus JSON rule, no sample format, no ordering or cancel rule, and no "what do I get on connect" rule. Without this the implementer chooses silently, and a reconnecting tablet can keep a stale alert.
- **Simple fix (a proposal; reviewers differed on binary versus base64, either works on a LAN):**
  - Client to server: `hello{version, token, device, sound}`, `tap`, `utterance` (one message with the whole recording; 15 s cap), `cancel{turn}`, `ping`.
  - Server to client: `snapshot{conv_state, alerts[]}` on every connect and every change; `state{conv, turn}`; `tts{turn, seq, audio, final}`; `turn_done{turn, reason, timings}`; `error{code}`.
  - Clients redraw from the latest snapshot only. This also fixes missed clears.
  - Playback: one `AudioContext`; schedule chunks with `nextT = max(now, nextT) + duration`; a new turn, cancel or tap stops all sources and resets `nextT`; drop chunks from stale turns.
  - Kokoro's native rate is probably 24 kHz mono (unverified). If raw PCM is used, align frames to 2 bytes.
  - Simplest for slice 1: one WAV per reply, decoded with `decodeAudioData`. Add chunking when sentence streaming is added.
  - Capture does not need streaming: send the whole utterance once recording ends.

#### N5. Timer creation depends on an untested Hermes ability, and it is the stated reason for option C
- **Lens:** design, comprehension, implementation-readiness, structural, zoom-out, inventive-catalyst
- **Decisions:** D22, D21, D44, D50, R17, R18
- **Problem:** the author chose C partly because "Hermes cannot do timers or stopwatches". D22 makes Blob own timers but relies on Hermes calling `POST /alerts` with a bearer token and reaching Blob over the network. Nothing shows Hermes can make an authenticated HTTP call, read the response, or reach the pod. An LLM also has no reliable clock, so an absolute `fire_at` it writes will often be wrong. If the tool call fails, Hermes may still say "timer set".
- **Simple fix:**
  - Add to Stage 0 item 1 (the Hermes curl test): "can Hermes call `POST /alerts` with the token, and does it report failures?".
  - Accept a relative `in_s` field; the server computes `fire_at` from its own clock.
  - Fallback if Hermes cannot: a Blob-side regex on the transcript for "temporizador / timer / minutos" that runs before Hermes (about 20 lines).
  - State this fallback inside D22.

#### N6. Stage 0 TLS shortcut is wrong for the tablet and for any remote desktop
- **Lens:** structural
- **Sections:** Stage 0 item 2, Stage 2, D15, D33, Constraints
- **Problem:** "Localhost is a secure context, so TLS can wait" is true only for a browser on the same machine as the server. The tablet is not localhost. `getUserMedia`, Wake Lock and PWA install need a secure context. The tablet spike cannot run as written.
- **Simple fix (pick one):**
  - Move a minimal TLS step into the tablet spike (`mkcert` or a self-signed cert installed on the tablet, or the real-domain cert from D33).
  - On Android only: `adb reverse tcp:PORT tcp:PORT` makes `localhost` on the tablet point at the desktop dev server (**unverified**). That is a secure context with no TLS, and `chrome://inspect` gives real devtools (so D47 is not needed early).
  - Stage 1 runs on the desktop's own localhost.

---

### Major

#### N7. Stopwatch: D22 vs D50 vs Q13 vs D24 vs D20 vs D21
- **Lens:** design, codebase-details, zoom-out, comprehension, implementation-readiness, structural, inventive-catalyst (all seven)
- **Problem:**
  - D22 says the stopwatch is a non-goal. D50 reverses it but D22's text is unchanged, so a reader cannot tell which wins.
  - D50 defines it as "a running alert with no `fire_at`". By D21 that is a normal immediate alert, so it cannot be told apart from an info alert.
  - Under D24 (urgent first, then oldest first) it sits at the top for ever and hides newer alerts. D20's tap would clear it. D26 has no shape for it. D21 has no start-time field.
  - Q13 admits there is no way to show elapsed time without text.
  - D50's reason ("Hermes cannot do it") is weak: D22 already lets Hermes create alerts, so Hermes can start one. The unproven part is the same as N5.
- **Simple fix:** mark D22's stopwatch line "superseded by D50" and move the stopwatch to "later" until timers work. When it returns, keep it out of the alert list: a separate `kind=stopwatch` with a `started_at`. Answer "cuanto lleva" by speech on request. Cheap trick (inventive lens, untested): inject one line into each Hermes system message ("Active: cronometro 12m30s; timer 3m left"); this also addresses R18. For a passive visual, rotate the procedural environment slowly (one turn per minute) so the reflection acts as a rough seconds hand. This is an idea, not a tested design.

#### N8. Mic lock lease (D36) is over-built, contradicts the staging, and is shorter than a turn
- **Lens:** design, zoom-out, implementation-readiness, structural, inventive-catalyst, comprehension
- **Decisions:** D11, D12, D36, NG3, Stage 3 vs Stage 4
- **Problem:**
  - D36 says "built in Stage 3". Stage 3 is Alerts. The stage list puts the multi-device lock in Stage 4. The Alternatives row says Stage 3.
  - A 30 s lease with no heartbeat is shorter than 8 s listen + STT + Hermes (up to a long tool run) + TTS.
  - The 20 Hz level stream is distributed-systems work for mirrors; the server has no mic audio until the utterance ends, so it cannot compute the level anyway.
  - Without any guard, two clients can start two turns in parallel from Stage 1 on.
- **Simple fix:** delete the lease. The server holds one `current_turn`. It rejects a second `turn_start` with `busy`, and releases it on turn end, WebSocket close, or a 90 s turn timeout. Wake word runs only on the device marked in config (the tablet); the desktop is tap-only, so there is no race. Mirrors animate from state messages plus a synthetic envelope. Keep the lease, heartbeat and arbitration for "later".

#### N9. Staging is larger than stated and does not match the decisions
- **Lens:** zoom-out, structural, comprehension, implementation-readiness, inventive-catalyst
- **Decisions:** D43, D45 to D49, Stage 0 to 4
- **Problem:**
  - Stage 0 lists six spikes in "1 to 2 days". Spike 5 is Stage 1 itself; spike 4 is Kubernetes work; spike 6 is a shader feature. For a solo hobbyist that is weeks.
  - D18 (VAD, silence rules) sits in Stage 2, yet tap-to-talk needs an end-of-speech rule in Stage 1.
  - D45, D46, D47 appear in no stage.
  - Stage 1 uses whole-reply TTS while D7, G4 and D45 assume streaming (see N11 on SC1).
  - There are no kill criteria. If the wake word fails on the tablet, the only named fallback is the native wrapper (D48), the most expensive option.
- **Simple fix:** two kill-spikes of a few hours (Hermes curl, including the N5 timer-call test; tablet stub page with `getUserMedia` and a stock wake word running 2+ hours). Everything else becomes normal slice work. Kill rule: if the wake word cannot run 2 hours on the tablet, ship tap/button mode and move on; do not start D48 unless the author wants it. Re-cut as in **Slice 1 and later slices** below.

#### N10. No error-path policy; no guaranteed return to idle
- **Lens:** implementation-readiness, codebase-details, structural
- **Decisions:** D18, D35, D45, R20
- **Problem:** nothing says what the server sends when STT returns empty, Hermes stalls, TTS raises, or the GPU runs out of memory. The client could stay in `thinking` for ever. D45 gives "about 2 s" for the filler but no total timeout for the fallback. All GPU work (turns, the tap-to-read alert TTS, the filler) can race on one GPU.
- **Simple fix:**
  - The server always ends a turn with `turn_done{reason}` (`ok | empty | stt_fail | hermes_fail | timeout | cancel`). The client returns to idle on it; the grey look lasts about 3 s, and only for reasons other than `ok`, `empty`, `cancel`.
  - Hermes: connect timeout 5 s, no-bytes timeout 30 s, total cap 120 s, all config values. On breach, abort the stream and speak the fallback.
  - One `asyncio.Lock` around all GPU calls; inference off the event loop.
  - Pre-render the fallback line and the filler per language at startup and keep the audio in memory, so they still work when a later TTS call fails.
  - Run one dummy transcription and one dummy synthesis at startup so the first real turn is not cold.
  - If TTS fails, the client plays a local beep file.

#### N11. D45 filler phrase is under-specified and conflicts with SC1
- **Lens:** codebase-details, zoom-out, comprehension, implementation-readiness, inventive-catalyst, design
- **Decisions:** D45, D31, D41, D24, D19
- **Problem:**
  - "In the reply language" is unknown before Hermes answers.
  - "While Hermes runs a tool" needs stream content that R17 says is unverified. Only a timer is implementable.
  - The brief cites about 3.5 s per plain turn for another Hermes integration (reported, unverified). A 2 s trigger would then fire on most turns.
  - The filler could count as "first audio" in SC1.
  - The filler and fallback must not enter the 6-message history (D31).
  - It is not stated which display state shows during the filler, whether it counts as "speaking" for the wake mute (D19), or whether a D27 chime can play over it.
- **Simple fix:** use the STT-detected language through the `ca -> es` voice lookup. Pre-render the clips (N10). Trigger on a timer only (about 4 s, config value), cancelled by the first token, and skip it if a TTS sentence is already ready. Keep the `thinking` display during it. Do not store filler, fallback, cancelled or errored turns in history. Define SC1 as the first audio of the real reply. Or defer the filler, keep only the fixed error line, and add the filler if measured delay is bad (zoom-out lens).

#### N12. Speaches reuse (D34) and language handling (D35, D3) rest on API features nobody has checked
- **Lens:** codebase-details, design, structural, zoom-out
- **Decisions:** D3, D34, D35, D18, D2
- **Problem (all **unverified** for speaches):**
  - An OpenAI-style transcription API takes one optional `language` and returns one detected language. It probably does not return per-language probabilities. D35's "re-run forcing the most probable of the three" needs that table. A re-run is a full second decode.
  - The usual failure is Catalan detected as Spanish. That is in the set, so D35 never fires.
  - D3 says the language is "limited to {ca,es,en}"; D35 says auto-detect. Contradiction.
  - Unknown: whether `int8_float16` can be set, whether `no_speech_prob` is returned, whether Kokoro runs on GPU, whether TTS gives raw PCM, whether idle models are unloaded after a timeout (a model load of several seconds on the first turn after idle breaks SC1).
  - Server-side `vad_filter` is redundant with browser VAD.
  - The brief says "one container" while D34 makes two.
  - D34's fallback (models inside the backend) makes the backend GPU-bound again; this is a different architecture, not a detail.
- **Simple fix:** make the seam explicit: `stt(audio, lang=None) -> {text, lang, no_speech_prob}` and `tts(text, lang) -> audio`. Add a Stage 0 line: "does speaches return those three STT fields, allow model unload off, and give raw audio?". If not, load faster-whisper and Kokoro in-process (slice 1 does this anyway). Delete D3's language clause. Replace D35 with: transcribe once with auto-detect, log the detected language, and add a sticky prior or re-run only if the logs show wrong detections (SC3). Drop server-side `vad_filter` once browser VAD exists.

#### N13. D41 success numbers do not match the hardware or the stack
- **Lens:** design, codebase-details, comprehension, zoom-out, inventive-catalyst, implementation-readiness
- **Decisions:** D41 (SC1 to SC6), D18, D45
- **Problem:**
  - SC1 "under 3 s from end of speech to first audio": the 1 s VAD tail may or may not be included; STT, Hermes first sentence and TTS come on top; the brief cites about 3.5 s for a plain Hermes turn elsewhere (reported, unverified). Stage 1 uses whole-reply TTS, which adds the full synthesis time.
  - SC2 "under 1 false wake per day" lost the earlier "with TV or music on" condition. The Stage 2 exit test is 24 h, which cannot show a rate below 1 per day.
  - SC4 "not hot" is subjective.
  - SC5 "all screens" assumes multi-device (N8).
  - SC6 "alerts back within 30 s": `Recreate` plus a cold large-v3 load from a PVC may take longer (unverified).
  - Open VRAM question: D39 says Hermes uses an external LLM provider, but "Still needed" and Q10 still ask whether the LLM shares the GPU. If it is external, large-v3 plus Kokoro should fit in 8 GB (roughly 4 to 5 GB including CUDA context; **unverified estimate**). If the LLM is local, 8 GB fails.
- **Simple fix:** define SC1 as "from the last voiced frame to the first audio of the real reply", report it, and treat 3 s as a goal after sentence streaming; set a loose target (about 6 s) for whole-reply mode. Record peak VRAM with `nvidia-smi` in slice 1. Add test conditions and sample sizes: SC1 over 20 turns, SC2 over 3 days with the TV on. Use a temperature or throttling check for SC4. Restrict SC6 to the alert API: start HTTP, DB and scheduler first, load models in a background task, `/healthz` returns alive at once and ready later; a tap while warming gives a grey blob. Settle in writing where Hermes's LLM runs and delete Q10's duplicate.

#### N14. Alert `lang` default `ca` cannot be spoken by Kokoro
- **Lens:** codebase-details, comprehension, implementation-readiness, zoom-out, inventive-catalyst
- **Decisions:** D21, D20, D4, D6, D42
- **Problem:** the default language for every calendar or Home Assistant alert is Catalan, and Kokoro has no Catalan voice. The default path is the worst case.
- **Simple fix:** one server-side dict `voice_for(lang)` with `ca -> Spanish voice`, `es -> Spanish`, `en -> English`, anything else treated as `es`. Use the same dict for alerts, the filler and Hermes replies. Replace the `ca` entry with Piper or Matxa later (one line). Keep the default `lang` as `ca` only if the user wants it; `es` is also acceptable. Catalan text through a Spanish voice will sound wrong until then; say so in D21.

#### N15. `/alerts` contract has holes (D21 to D23)
- **Lens:** implementation-readiness, codebase-details, comprehension, structural, design
- **Problem:**
  - Required fields and defaults are not stated. A timer's urgency is undefined; `info` is silent (D27), so a finished timer could expire unnoticed.
  - `fire_at` format and time zone are undefined. `ttl_s` has no start point.
  - Missed timers: a `Recreate` rollout or reboot leaves a gap, and nothing says whether a timer due during downtime fires on start or is dropped.
  - Limits: `text` length, number of active alerts, key format.
  - Ack versus re-POST: a Home Assistant automation that POSTs the same `key` every minute re-raises an alert the user already cleared by tap (D20).
  - Without `GET /alerts`, Hermes cannot cancel a timer.
  - Dedupe key is `id` in the D9 sketch, `source + id` in Alternatives and `key` in D21.
  - Pending timers must not appear in the D24 display list.
- **Simple fix:**
  - Required: `key`, `source`, `text`. Defaults: `urgency=info`, `lang=es`; `source=timer` defaults to `urgent`.
  - `fire_at` as epoch or RFC3339 with offset; reject naive times with 422; accept `in_s`. Store UTC epoch ints. `ttl_s` counts from activation.
  - A `state` of `pending | active | acked`. A tap sets `acked` and keeps the row; a POST to an acked key with unchanged `text` and `urgency` is ignored; a changed payload re-raises; delete on source `DELETE` or 24 h after ack.
  - Startup rule: overdue timers fire once, marked late, unless `ttl_s` has also passed.
  - Caps: `text` 300 characters, 20 active alerts. `DELETE` is idempotent. Add `GET /alerts`. Use `key` everywhere.
  - Scheduler: one asyncio task polling the table once a second. No scheduler library.

#### N16. Security: the voice path into Hermes tools is protected only by a prompt line
- **Lens:** design, codebase-details, comprehension, implementation-readiness
- **Decisions:** D32, D44, D21, D38
- **Problem:**
  - A TV or a guest can say the wake phrase. D32's only control is a system-message line asking Hermes to confirm changes, and the TV can say "yes". D44 routes Home Assistant control through Hermes, so locks or covers may be reachable.
  - Confirmation needs the user to answer, but nothing re-opens the mic after a question, so confirmation cannot work today.
  - The brief does not say how the browser gets its WebSocket token (browsers cannot set headers on a WebSocket; a query-string token lands in ingress logs).
  - `/alerts` is not guaranteed to stay off the ingress.
  - Hermes is "localhost only" (Constraints), and the brief does not say where Hermes runs relative to the pod or how Hermes reaches `/alerts`.
- **Simple fix:**
  - Hermes: if it supports a separate profile or toolset for Blob, exclude locks, garage doors and shell. If it does not, record in D32 that the risk is accepted for a home LAN.
  - Follow-up listening: after a reply that ends with a question, open the mic once for about 6 s with no wake word.
  - Sources call `/alerts` through the in-cluster Service; the ingress exposes only `/` and `/ws`. Use two tokens: `ALERT_TOKEN` (Home Assistant, Hermes) and `DEVICE_TOKEN` (browsers).
  - Browser token: send it in the `hello` message; close with code 4401 on a wrong token and do not retry. Install it once by opening `https://host/#t=TOKEN`; the page stores it in `localStorage` and strips the hash. The PWA `start_url` carries no secret.
  - Add "Hermes host, port and network path, and its route back to `/alerts`" to the Stage 0 facts.

#### N17. A PWA on Android Chrome is not a kiosk; several tablet failure modes are uncovered
- **Lens:** codebase-details, design, structural, comprehension, zoom-out
- **Decisions:** D15, D38, D40, D30, R1
- **Problem (all **unverified** Chrome/Android behaviours):**
  - `display: fullscreen` can be exited by a swipe, and nothing launches it after a reboot. After any restart audio is locked until someone taps.
  - Wake Lock is released when the page is hidden or on power saver, and must be re-acquired on `visibilitychange`.
  - Newer Chrome versions may use one-time microphone grants; whether "granted" survives a restart must be tested.
  - WebGL context loss is not handled.
  - D38 (reload on version mismatch) can loop if a service worker or cache serves the old bundle, and a reload while the pod is down shows Chrome's error page.
  - D40 hides the audio-locked cue after 5 s (see N2).
- **Simple fix:** accept "first tap after a reboot" as a known limit and say so. Re-acquire Wake Lock on `visibilitychange`. Handle `webglcontextlost` by re-creating the context. Ship the manifest without a service worker (whether Chrome needs one for fullscreen install is unverified; check it once on the tablet). Serve `index.html` with `Cache-Control: no-cache` and hashed asset names. Reload at most once per server version, stored in `localStorage`; on a second mismatch show the fault cue and stop. Reconnect with backoff of 1 to 30 s. If unattended boot matters later, a bare WebView shell or a kiosk browser app is cheaper than D48.

#### N18. D48 (native wrapper) contradicts NG6 and is not thin
- **Lens:** codebase-details, zoom-out, comprehension, inventive-catalyst
- **Decisions:** D48, NG6, NG9
- **Problem:** NG6 says a native app is a non-goal. D48 makes a native Android wrapper that "runs the same wake-word model" the fallback. That needs a second runtime (ONNX Runtime Mobile or TFLite), native audio capture, a foreground service for the mic and a bridge to the page. Whether the wrapper and the page can share the mic is unverified. It is a second implementation.
- **Simple fix:** remove D48 as a plan. Replace it with an ordered fallback list: (1) tap or hardware button only, (2) a plain WebView shell with no wake logic, (3) switch to option A (see the triggers below). Consider microWakeWord as a different engine to try before any native work (Voice Satellite reports using it in a browser; unverified on the author's tablet). If D48 stays, amend NG6.

#### N19. Data lifecycle: the 14-day expiry is not enforced; SQLite placement and backup unstated
- **Lens:** codebase-details, implementation-readiness, structural, comprehension, design
- **Decisions:** D23, D32, D33, D37, D39
- **Problem:**
  - D37 writes one JSON line per turn, D32 logs the text, D39 expires transcripts after 14 days. Container stdout has no expiry that Blob controls.
  - SQLite on a network-backed PVC (NFS) can lock or corrupt, especially in WAL mode (**unverified**).
  - Nothing states backup or loss tolerance. Hermes keeps its own memory outside the 14 days.
- **Simple fix:** stdout gets timings only. Turn text goes to a `turns` table in the same SQLite file (separate from the alerts table); a `DELETE` of rows older than 14 days runs at startup and every 24 h. Use block or local storage. On NFS use the default journal mode. One writer only. Write down "alerts can be re-created by their sources; turn logs are disposable; no backup", or add a nightly `VACUUM INTO` on another volume if wanted. Say in D39 that Hermes keeps its own memory.

#### N20. Display composition has gaps (D24, D13, D25, D27)
- **Lens:** design, comprehension, structural, implementation-readiness
- **Problem:**
  - Precedence between offline, a conversation turn and the top alert is not fully stated. D24 says the conversation wins during a turn but is silent about sound.
  - An alert that arrives during a turn must still be broadcast and held hidden until the turn ends.
  - The D27 two-minute chime has no rule for firing during a turn or at night. Q10 raised dimming but no decision followed.
  - Nothing says which side owns `conv_state`, the alert list and the view function.
  - The state table still mixes conversation and alert rows (R7).
- **Simple fix:** fixed precedence: offline, then conversation turn, then top alert, then idle. No sound from alerts during a turn; queue the chime and play it at turn end if the alert is still open. Add a config `quiet_hours` that mutes chimes. The server owns `conv_state` and the alert list and sends a snapshot. The client computes `view = conv.active ? conv : top_alert`. Split the state table into two frontend data tables: conversation state to colour/motion, and alert source/urgency to shape/colour/pulse. The backend never sends a shape.

#### N21. Conversation history (D31) is under-specified and may duplicate Hermes's own sessions
- **Lens:** design, comprehension, implementation-readiness, codebase-details, structural
- **Decisions:** D31, D32, D45, D46
- **Problem:** D31 and D32 describe two system messages (style/language and confirmation). Blob-side history may double-count if Hermes keeps a server session (hermes-voice sends a session ID, which suggests it does; unverified). Errored, cancelled, filler and fallback turns must stay out of history. Prior Art says "compare with D31" but the brief never does.
- **Simple fix:** one merged system message. Add to the Hermes spike: "does a session ID or history from the server work?". If it does, drop the Blob-side history (less code). Otherwise store only completed user/assistant pairs.

#### N22. Several round 2 and prior-art defaults are over-built for a first prototype
- **Lens:** zoom-out, design, codebase-details, structural, inventive-catalyst
- **Problem and simple alternative:**

  | Decision | Problem | Simpler alternative |
  | --- | --- | --- |
  | D18 | VAD, silence timer, no-speech timer, hard cap, `vad_filter` and a `no_speech_prob` filter in one item | Slice 1: tap to start, tap to stop, 15 s `setTimeout`, drop empty transcripts. Add `vad-web` with the wake word. |
  | D32/D33/D34 | k8s, PVC, `Recreate`, cert-manager, token, a speaches sidecar before one turn works | Slice 1: one Python process on the desktop. Containerise when the tablet joins. |
  | D36 | lease and 20 Hz stream | see N8 |
  | D40 + D47 | status icon row plus a diagnostics screen with "copy report" | Client sends events up the WebSocket into the existing turn log; read with `kubectl logs` or a plain `/debug` page; the tablet gets one dim line naming the current fault. |
  | D46 | stop phrases need per-language normalisation; the mic is closed while Blob thinks or speaks, so it cannot interrupt anything; 8 s listen timeout already covers false wakes | Drop it. Tap-to-cancel (N1) replaces it. If kept later: lowercase, strip accents and punctuation, add Catalan forms ("cancel.la", "deixa-ho"). |
  | D45 | see N11 | defer, keep the error line |
  | D35 | rerun branch for an unproven failure | see N12 |
  | D25 | droplets are the only reason to keep smooth-min, so two SDF operators from day one | Slice 1 `thinking`: amber with slow breathing. Droplets after the `mix()` morph works. |
  | D27 | audio asset and 2-minute re-chime | Pulse speed only until alerts exist; add the chime in the alerts slice. |
  | D26 | four alert shapes | Two shapes are enough for a first test. |
  | D49, D50 | second phrase and stopwatch | later (N7) |

- **Note:** these are cuts or deferrals, not rejections. All can return once the earlier slice works.

---

### Nit

#### N23. Browser audio stack should be sequenced
- **Lens:** codebase-details, structural
- **Decisions:** D17, D18, D19, D30
- **Problem:** openWakeWord and `vad-web` both load `onnxruntime-web`, next to the shader on a tablet. D19's "muted while speaking" does not say which side knows the state (the server adds network lag).
- **Simple fix:** one `getUserMedia` stream and one worklet feeding both consumers. Wake detector runs only while the local state is `idle`; VAD only while listening (preload it paused). Use the client's own playback state for the mute, with a hangover of about 0.5 s after playback ends. Set ONNX Runtime to one thread inside the worker (multi-thread needs COOP/COEP headers; **unverified**). 0.6 to 0.8 s of end-of-speech silence is more usual than 1 s (OrbitVox uses 0.8 s per the brief). If the user says wake phrase and command in one breath, a 1 s ring buffer helps; this belongs to the wake-word slice.

#### N24. Privacy statement does not cover tap-to-talk or pre-roll
- **Lens:** inventive-catalyst, comprehension
- **Decisions:** G2, R27, D16, D18
- **Problem:** "Audio leaves the device only after the wake word" is not true for tap-to-talk. D18's pre-roll would send audio recorded before the trigger.
- **Simple fix:** reword to "audio leaves only after an explicit trigger: tap, key or wake word". In tap mode, open the mic only during a turn and stop the tracks after it (no always-on mic, no screen-off mic problem). The server drops audio unless a turn is open. Start pre-roll at the end of the wake phrase.

#### N25. Naming and labels drift
- **Lens:** comprehension, structural
- **Problem:** "kiosk" is used while D15 chose a fullscreen PWA, which is not a locked kiosk. Alert dedupe key is `id`, `source + id` or `key` (see N15). D47 shows a "wake-word score" that does not exist in slice 1. NG6 vs D48 (N18). Option A still says "recommended"; Option C says "D15 to D43". The "Non-Goals (proposed)" heading is stale after D44.
- **Simple fix:** say "fullscreen PWA (kiosk-like)" and add PWA to the glossary; use `key`; fix the labels; move the wake-word score to the wake slice.

#### N26. Licence and reuse notes
- **Lens:** zoom-out
- **Problem:** Voice Satellite is AGPL-3.0 (per the brief). Copying its code into Blob would carry AGPL obligations. The `ricky0123/vad-web`, speaches, openWakeWord and Kokoro licences are unverified. The `R32` question (three.js vs plain WebGL2 for one quad) is still unanswered.
- **Simple fix:** read Voice Satellite for ideas; do not copy code. Check licences of the pieces you ship in the Stage 0 notes. WebGL2 without three.js is optional.

---

## Contradiction matrix (the pairs the author asked about)

| Pair | Verdict | Where fixed |
| --- | --- | --- |
| D22 vs D50 (stopwatch) | Real contradiction; D50 also breaks D24 and D20 | N7 |
| D16/D17 wake word vs staging | Wake phrase text still "hola blob" in Stage 0 and Stage 2; D16 makes tap the product through Stage 1, but Stage 0 still starts with the wake word; D18 needed in Stage 1 but listed in Stage 2 | N3, N9, N1 |
| D31 vs D45/D46 | Filler, fallback, cancelled and stop-phrase turns must stay out of history; stop phrases cannot interrupt anything | N11, N21, N22 |
| D34 vs D35 | Speaches API probably cannot do D35's "most probable of three" re-run; D3 also contradicts D35 | N12 |
| D36 vs single-device stages | Lock is built in Stage 3 or 4 (conflict); lease shorter than a turn; "active device" undefined at idle | N2, N8 |
| D25 vs D13/state table | Table and D13 not updated | N3, N20 |
| D41 vs hardware | SC1, SC2, SC6 do not fit the stack or the test method; VRAM depends on where Hermes's LLM runs | N13 |

## Slice 1 and later slices

Three reviewers gave a slice 1. They agree on the shape; these are the common parts. Everything is **unverified until built**; the effort estimate (a couple of weekends) is a reviewer guess.

### Slice 1: "tap, talk, hear Hermes, with timings"

**In:**
- Desktop browser on `localhost`, one Python process (FastAPI plus a static page). No Kubernetes, TLS, PWA, auth, wake word, VAD, mic lock, alerts, SQLite, shapes or morph.
- Models in the same process (faster-whisper and Kokoro), with inference off the event loop; model name from an env var. This removes speaches from slice 1 (N12).
- Page: fullscreen-quad shader showing a sphere only; colour comes from a small state table with five rows (idle, listening, thinking, speaking, error). `thinking` is amber breathing, not droplets.
- Click to start recording, click to stop, 15 s cap. Send the whole utterance as one message. (`MediaRecorder` webm/opus decoded by the server is the cheapest capture; whether faster-whisper's decoder accepts it is unverified. If not, record PCM with an AudioWorklet.)
- Backend: STT with auto-detect, `vad_filter` and an empty-text drop; Hermes `/v1/chat/completions` with `stream: false`, last 6 messages and one merged system message; strip markdown, emoji and URLs; Kokoro on the whole reply with `voice_for(lang)` mapping `ca -> es`; return one WAV.
- Tap rules from N1 (listen, stop, cancel); `turn_done{reason}` from N10; fixed fallback line on Hermes error; one JSON timing line per turn (last voiced frame, STT done, Hermes first byte or done, first audio out, detected language).
- Listening deformation from a client-side `AnalyserNode` on the mic; speaking pulse from an `AnalyserNode` on playback. No server involvement.

**Out (explicit):** filler phrase, stop phrases, diagnostics screen, status icons, Catalan TTS, sentence streaming, second device.

**Build order:**
1. Hermes curl test (about 1 h): sessions? system message honoured? stream contents? Can it POST to a test endpoint with a token (N5)?
2. Backend skeleton: `/healthz` (alive vs ready), env config, one `/ws` that logs messages.
3. STT command-line on a WAV file: text, language, time. Include an empty file and a silence file.
4. Hermes client: history, system message, timeouts, fallback.
5. TTS command-line: text to WAV. Confirm Kokoro voice and language codes (unverified).
6. Wire the pipeline in `/ws` and emit state and timing.
7. Page: connect, state circle, tap logic, recording, playback with the `nextT` queue.
8. Error paths: empty STT, Hermes down, Hermes slow, forced exception.

**Exit test (all on the desktop with the GPU):**
- 10 spoken turns (4 Spanish, 3 English, 3 Catalan, including short commands) each end with spoken audio and `turn_done reason=ok`.
- Tap on silence returns to idle with zero Hermes requests in the log.
- Wrong Hermes key or Hermes stopped: grey blob, the fixed fallback line is spoken, idle within the timeout.
- Tap during speaking stops audio; tap during thinking cancels and the next turn works.
- "What did I just ask?" within 5 minutes uses history; after 5 minutes idle it does not.
- The blob visibly changes in all five states.
- `nvidia-smi` peak VRAM is recorded and under 8 GB. Median last-voiced-frame-to-first-audio time is logged. 3 s is a measurement, not a pass mark.

**Side track (hours, not in slice 1):** the tablet stub page (N9). If it fails, the kill rule applies before more is built.

### Later slices (order)
- **Slice 2, tablet with taps:** minimal TLS or `adb reverse` (N6), container image, PWA manifest, Wake Lock, audio-locked cue, token handling (N16, N17). Exit: 8 h at about 30 fps, tablet not throttling, tap turns working.
- **Slice 3, hands-free:** `vad-web`, wake word on the tablet only (config flag), mute rules (N23). Exit: measured false accepts over several days, plus a replay of recorded TV/radio audio through the detector faster than real time (whether the web port runs faster than real time is unverified).
- **Slice 4, alerts and timers:** `/alerts` per N15, SQLite per N19, scheduler, two shapes, `mix()` morph, one Home Assistant call. Exit: alert visible after a pod restart; a voice timer works (or the Blob-side regex fallback does).
- **Later:** sentence streaming, filler phrase, droplets, chime and quiet hours, stopwatch, second wake phrase, Catalan TTS, multi-device lease, speaches.

## Option C: honest assessment and switch conditions

The author's decision stays. Honest read of the Prior Art:

- C is defensible for the stated reasons: a general assistant, not tied to Home Assistant, with its own look and its own logic.
- The "Hermes cannot do timers or stopwatches" reason supports a Blob-side timer; it does not justify the whole standalone voice stack. It is also unproven (N5): D22 still needs Hermes to call Blob.
- C is the largest build. It removes none of round 1's risks (tablet, wake word, alerts) and the Prior Art does not remove them either: Voice Satellite's in-browser wake word is its own project's claim, and unverified on the author's tablet.
- Cost of the voice half is real: it is already built elsewhere if Home Assistant is in use. The Prior Art does not confirm that the author runs Home Assistant.
- Not triggers: STT or TTS quality, GPU or VRAM limits and Hermes latency. Option A would carry the same problems.

**Switch to option A (display layer on Home Assistant) if any of these happens:**
1. **Tablet wake word fails:** the mic or the detector drops more than once in 8 h on Chrome, or the tablet is an iPad, and the author does not accept tap/button-only mode.
2. **Shader and wake word cannot share the tablet:** below about 30 fps or throttling at the lowest quality tier while the detector runs.
3. **Custom wake model misses SC2** after about two training attempts, or the author will not maintain the training recipe.
4. **Hermes cannot create a timer** through `POST /alerts` (Stage 0 test) and the Blob-side regex fallback proves too weak, so voice timers need real intent parsing.
5. **Scope creep into Home Assistant territory:** timers, calendar and announcement logic start to duplicate what Home Assistant owns, beyond the three or four sources in D26.
6. **Slice 1 plus slice 2 take much longer than planned** (rule of thumb: more than about 6 weekends in total; a judgment call, not a measured figure).
7. **Precondition to confirm in about an hour before switching:** Voice Satellite's overlay can be hidden and the satellite state is readable from another page. If not, A is not viable (unverified).

**Cheap way to keep A alive:** make the display a page whose only input is the WebSocket state and alert stream. The voice loop is then a second, replaceable client, and any other front end can feed the same page. Cost: one more message contract to version (see N4).

## Cheap de-risking ideas (all unverified)

- Use the desktop tab as the first complete client; tap-to-talk makes it one. `?clip=file.wav` could replace the mic with a recorded clip for repeatable tests; Chrome's `--use-file-for-fake-audio-capture` does something similar for automation.
- A cheap Bluetooth shutter or presentation clicker that sends a key could trigger listening across the room, and a key press may count as user activation for audio unlock. Needs a test on the tablet.
- In tap mode, open `getUserMedia` only during a turn. The mic indicator stays off when idle.
- Pre-render the filler and fallback audio at startup (N10).
- Flush the first sentence early (first `[.!?]` followed by whitespace or a newline) and send the rest as one chunk; about 10 lines, no splitter library. This gets most of the streaming benefit without a full splitter.
- Whisper can print stock phrases from silence (for example "Gracias."; the brief notes the general behaviour). A short `drop` list in a JSON file, built from the turn logs, is the cheap guard on top of VAD.

## Top objections

1. N1/N2: tap and sound target are undefined, so alerts can vanish unread or never sound.
2. N3: the brief still describes the round 1 design in many places.
3. N5: the reason for option C (Hermes cannot do timers) depends on an untested Hermes-to-Blob call.
4. N4/N10: no WebSocket, audio or error-path definition; a failed step can leave the blob stuck.
5. N6/N17: the tablet spike and PWA plan do not account for TLS, reboots, Wake Lock and audio unlock.
6. N9/N22: Stage 0 and Stage 1 are too large; build the slice 1 above first.
7. N7: the stopwatch contradicts D22, D24 and D20, and has no display.
8. N12/N13: speaches, language handling and the SC numbers rest on unchecked assumptions.
