# Concepts Brief: Blob

**Feature name:** Blob
**Author:** Arnau Fauquer (arnau.fauquer@gmail.com)
**Date:** 2026-11-12
**Mode:** BRAINSTORM (greenfield; the working directory was empty and is not a git repo, so no code was reviewed)

**Reviewer status:**

| Reviewer | Status |
| --- | --- |
| `egm-design` | completed |
| `egm-codebase-details` | completed |
| `egm-zoom-out` | completed |
| `egm-comprehension` | completed |
| `egm-implementation-readiness` | completed |
| `egm-structural` | completed |
| `egm-inventive-catalyst` | completed |

**Evidence rule used in this brief:** Reviewers could not open URLs or run code. Every statement about an external product (Hermes, openWakeWord, Porcupine, Kokoro, Piper, Matxa, speaches and others) comes from the user's researched facts or from reviewer memory. Reviewer-memory statements are marked "unverified". Nothing here has been benchmarked.

---

## Current Design (round 3: read this first)

This section is the current truth. Older sections (Overview, Stack, Language matrix, Behaviour states, R1 to R32, Prior Art, the Round 2 table D15 to D50, the Q-table and the old Staging) are history. Where they disagree with this section, this section wins. Source of the changes: the second Goldfish review in `review_round2.md` (findings N1 to N26), accepted by the author on 2026-11-12 with "apply it".

### What Blob is

A standalone assistant (option C, author's choice) with no dependency on Home Assistant. A dark, liquid-metal blob in a fullscreen PWA (tablet, kiosk-like) and a desktop browser tab. Voice in Spanish, Catalan or English. Replies spoken in Spanish or English. Hermes Agent is the brain. Blob has its own timers and alert display.

### Components

| Part | Choice |
| --- | --- |
| Client | One static page: fullscreen-quad shader, tap handling, one `AudioContext`, mic opened only during a turn. Plain WebGL2 or three.js (either is fine). |
| Backend | One Python process (FastAPI). WebSocket `/ws`, `POST /alerts`, `/healthz`. Models run in-process (faster-whisper, Kokoro), off the event loop, behind one `asyncio.Lock` for GPU calls. |
| STT | faster-whisper large-v3, `int8_float16`, auto-detect language, one pass. Model name is an env var. Large-v3-turbo is a benchmark candidate. |
| TTS | Kokoro. One dict `voice_for(lang)`: `ca` to a Spanish voice, `es` to Spanish, `en` to English, anything else to `es`. Catalan alerts will sound wrong until a Catalan voice replaces the `ca` entry. |
| Hermes | `/v1/chat/completions`. Slice 1 uses `stream: false`. |
| Storage (alerts slice) | SQLite on block or local storage, not NFS. Alerts table and a `turns` table. |
| Deployment (slice 2 on) | Container on the homelab cluster, `replicas: 1`, `Recreate`, models on a PVC, ingress routes the whole host, so `/alerts` is protected only by `ALERT_TOKEN` (amended in the design draft). |

`speaches` as a model sidecar is deferred. Slice 1 loads the models in the backend. The two functions `stt(audio, lang=None) -> {text, lang, no_speech_prob}` and `tts(text, lang) -> audio` are the seam, so a sidecar can replace them later.

### Round 3 decisions

These amend or replace earlier decisions. "Replaces" means the old row is history.

| ID | Decision | Replaces / fixes |
| --- | --- | --- |
| D51 | **Gestures** (first matching row wins). Alert showing: tap reads the alert aloud and clears it after playback ends. Speaking: tap stops playback. Thinking: tap cancels the Hermes request. Listening: tap stops and sends. Idle with no alert: tap starts listening. To talk while an alert is open: tap once to clear it, then tap again. Long press opens diagnostics. The wake word (later slice) always starts a turn. | D16, D20, NG7 (N1) |
| D52 | **Sound.** Alert sound goes to every client with `sound=true`, a per-device setting kept in a server file `config/devices.json` and read from `GET /device-config` (tablet on, desktop off). Amended in the design draft. During a turn, audio goes to the client that started it. While audio is locked, the "audio locked" cue stays on permanently, and a tap in that state only unlocks audio and clears nothing. One `AudioContext`; call `resume()` on every tap. | D12, D20, D40 (N2) |
| D53 | **Wire protocol.** Client to server: `hello{version, token, device, sound}`, `tap`, `utterance` (one message with the whole recording, 15 s cap), `cancel{turn}`, `ping`. Server to client: `snapshot{conv_state, alerts[]}` on every connect and every change, `state{conv, turn}`, `tts{turn, seq, final}` followed by a binary audio frame, `turn_done{turn, reason, timings}`, `error{code}`. The client redraws from the latest snapshot only. Audio goes as binary WebSocket frames. Slice 1 sends one WAV per reply, decoded with `decodeAudioData`; chunking comes with sentence streaming. Playback schedules chunks with `nextT = max(now, nextT) + duration`; a new turn, cancel or tap stops all sources and resets `nextT`; chunks from stale turns are dropped. Capture is not streamed: the whole utterance is sent when recording ends. | D10, D36, D38 (N4) |
| D54 | **Turn ends.** The server always ends a turn with `turn_done{reason}`, where reason is `ok`, `empty`, `stt_fail`, `hermes_fail`, `timeout` or `cancel`. The client returns to idle on it. A grey look lasts about 3 s, only for reasons other than `ok`, `empty` and `cancel`. Hermes timeouts (config values): connect 5 s, no bytes 30 s, total 120 s. On a breach, abort and speak the fallback line. Fallback audio (per language) is pre-rendered at startup and kept in memory. One dummy transcription and one dummy synthesis run at startup. If TTS fails, the client plays a local beep file. | R4, D18 (N10) |
| D55 | **Turn lock instead of a mic lease.** The server holds one `current_turn`. A second `turn_start` gets `busy`. It is released on turn end, WebSocket close, or a 90 s turn timeout. Wake word runs only on the device marked in config (the tablet). The desktop is tap-only. Mirrors animate from state messages plus a synthetic envelope; there is no 20 Hz level stream. | D11, D36 (N8) |
| D56 | **Alerts contract.** Required: `key`, `source`, `text`. Defaults: `urgency=info`, `lang=es`; `source=timer` defaults to `urgent`. `fire_at` is epoch or RFC3339 with an offset (naive times get 422); `in_s` is accepted and the server computes `fire_at` from its own clock. Stored as UTC epoch ints. `ttl_s` counts from activation. States: `pending`, `active`, `acked`. A tap sets `acked` and keeps the row; a POST to an acked `key` with unchanged `text` and `urgency` is ignored, and a changed payload re-raises it; the row is deleted on source `DELETE` or 24 h after ack. On startup, overdue timers fire once, marked late, unless `ttl_s` has also passed. Caps: `text` 300 characters, 20 active alerts. `DELETE` is idempotent. `GET /alerts` exists. Pending timers are not in the display list. The scheduler is one asyncio task that polls the table once a second. `key` is the dedupe field everywhere. | D9, D21, D23 (N15) |
| D57 | **Timers.** Blob owns timers. Hermes creates one through `POST /alerts` with `in_s`. This depends on Hermes being able to make an authenticated HTTP call and report failure; slice 1's Hermes test checks it. If it cannot, a Blob-side regex on the transcript ("temporizador", "timer", "minutos", Catalan "temporitzador") runs before Hermes (about 20 lines). | D22 (N5) |
| D58 | **Stopwatch deferred.** A stopwatch is not an alert. When it returns it is its own `kind=stopwatch` with a `started_at`, kept out of the alert list, answered by speech on request. Q13 stays open. | D50, D22, Q13 (N7) |
| D59 | **Display composition.** Precedence: offline, then a conversation turn, then the top alert, then idle. The server owns `conv_state` and the alert list and sends snapshots. The client computes `view = conv.active ? conv : top_alert`. An alert arriving during a turn is broadcast but held hidden until the turn ends. Alerts make no sound during a turn; a chime due then plays at turn end if the alert is still open. `quiet_hours` in config mutes chimes. Two frontend data tables: conversation state to colour and motion, and alert source and urgency to shape, colour and pulse. The backend never sends a shape. | R7, D24, D27 (N20) |
| D60 | **Language handling.** STT auto-detects once and logs the detected language. No re-run branch and no `{ca, es, en}` restriction in slice 1. A sticky prior or a re-run is added only if the logs show wrong detections (SC3). Drop server-side `vad_filter` once browser VAD exists; slice 1 keeps it with an empty-text drop. | D3, D35 (N12) |
| D61 | **Hermes history.** One merged system message (short spoken sentences, no markdown, Spanish or English, ask before actions that change things). The Hermes test checks whether a session ID or server-side history works; if it does, drop Blob-side history. Otherwise store only completed user and assistant pairs (last 6, dropped after 5 min idle). Filler, fallback, cancelled and errored turns never enter history. | D31, D32 (N21) |
| D62 | **Filler and stop phrases.** The filler phrase (D45) is deferred; only the fixed error line stays in slice 1. If the filler is added later: trigger on a timer only (about 4 s, config), cancelled by the first token, skipped if a sentence is already ready, language from STT through `voice_for`, `thinking` display stays on. Stop phrases (D46) are dropped; tap-to-cancel replaces them. | D45, D46 (N11, N22) |
| D63 | **Security.** Two tokens: `ALERT_TOKEN` (sources such as Hermes or Home Assistant, through the in-cluster Service) and `DEVICE_TOKEN` (browsers). The browser sends its token in the `hello` message; the server closes with code 4401 on a wrong token and the client does not retry. Install once by opening `https://host/#t=TOKEN`; the page stores it in `localStorage` and strips the hash. The PWA `start_url` carries no secret. Voice-triggered Hermes tools: if Hermes supports a separate profile or toolset for Blob, exclude locks, garage doors and shell. If not, the risk is accepted for a home LAN and written down here. After a reply that ends with a question, the mic opens once for about 6 s with no wake word. | D32 (N16) |
| D64 | **Tablet.** Accept that after a reboot the first tap unlocks audio (known limit). Re-acquire Wake Lock on `visibilitychange`. Handle `webglcontextlost`. No service worker in the manifest at first (check once on the tablet whether Chrome needs one for fullscreen). `index.html` is served with `Cache-Control: no-cache`; assets have hashed names. Reload at most once per server version (stored in `localStorage`); on a second mismatch show the fault cue and stop. Reconnect with backoff 1 to 30 s. | D15, D38 (N17) |
| D65 | **Fallback ladder instead of the native wrapper.** If the wake word cannot run on the tablet for 2 hours: (1) tap or hardware button only, (2) a plain WebView shell with no wake logic, (3) switch to option A (triggers below). D48 is removed. NG6 (no native app) stands. | D48 (N18) |
| D66 | **Data.** stdout carries timings only. Turn text goes to the `turns` table; rows older than 14 days are deleted at startup and every 24 h. Alerts can be re-created by their sources; turn logs are disposable; no backup. Hermes keeps its own memory outside the 14 days. | D37, D39, D23 (N19) |
| D67 | **Privacy wording.** Audio leaves the device only after an explicit trigger: tap, key or wake word. In tap mode the mic opens only during a turn and the tracks stop after it. The server drops audio unless a turn is open. | G2, R27 (N24) |
| D68 | **Browser audio stack (wake slice).** One `getUserMedia` stream and one worklet feed both consumers. The wake detector runs only in local state `idle`; VAD only while listening. Mute uses the client's own playback state with a 0.5 s hangover. ONNX Runtime uses one thread in a worker. End-of-speech silence is 0.6 to 0.8 s. | D17, D18, D19 (N23) |
| D69 | **Where Hermes's LLM runs.** D39 says an external provider. Treat that as the working assumption: large-v3 plus Kokoro should fit in 8 GB (unverified estimate of 4 to 5 GB). If the LLM turns out to be local, the 8 GB budget fails. Record peak VRAM with `nvidia-smi` in slice 1. | Q10 (N13) |
| D70 | **Cuts and deferrals** (not rejections): droplets and smooth-min in `thinking` (slice 1 `thinking` is amber breathing), the 2-minute chime (pulse speed only until alerts exist), four alert shapes (two to start), second wake phrase, speaches, diagnostics and status icons beyond one dim fault line plus client events in the turn log. | D25, D26, D27, D40, D47, D49 (N22) |

### Success criteria (replaces the D41 table)

| ID | Criterion | Value |
| --- | --- | --- |
| SC1 | Last voiced frame to first audio of the real reply (filler does not count) | Report the median over 20 turns. About 6 s is the loose target for whole-reply mode; 3 s is a goal after sentence streaming, not a pass mark. |
| SC2 | Wake-word false accepts | Under 1 per day over 3 days with the TV on, and fewer than 2 misses in 10 attempts. Replay recorded TV audio faster than real time where possible. |
| SC3 | Language-ID accuracy and WER on the author's clips | Measured; no target. |
| SC4 | Tablet frame rate and heat | About 30 fps for 8 h with no throttling visible in frame time. |
| SC5 | `POST /alerts` to visible change | Under 1 s on connected clients. |
| SC6 | Recovery after a restart | Start HTTP, DB and scheduler first; load models in a background task. `/healthz` reports alive at once and ready later. A tap while warming shows a grey blob. |

### Staging (replaces Stage 0 to 4)

**Kill-spikes (hours, run first):**

1. Hermes curl test (about 1 h): server-side sessions? system message honoured? stream contents? Can Hermes `POST` to a test endpoint with a token and report failure (D57)? Where does Hermes run and how does it reach `/alerts` (D63)?
2. Tablet stub page: `getUserMedia` plus a stock wake word running for 2 hours or more over a secure context. Use `adb reverse` or a minimal TLS (`mkcert`) because `localhost` is not secure on the tablet (N6; unverified). Kill rule: if the wake word cannot run for 2 hours, ship tap or button mode and move on (D65).

**Slice 1, "tap, talk, hear Hermes, with timings" (first deliverable):**

- Desktop browser on `localhost`, one Python process, models in-process. No Kubernetes, TLS, PWA, auth, wake word, VAD, alerts, SQLite, shapes or morph.
- The page shows a sphere only. Colour comes from a five-row state table: idle, listening, thinking, speaking, error. Listening deforms from a client-side `AnalyserNode` on the mic; speaking pulses from an `AnalyserNode` on playback.
- Click to start recording, click to stop, 15 s cap. The whole utterance is sent as one message. (Browser `MediaRecorder` webm/opus decoded by the server is the cheapest capture; whether faster-whisper accepts it is unverified. If not, record PCM with an AudioWorklet.)
- Backend: STT with auto-detect, `vad_filter` and an empty-text drop; Hermes with `stream: false`, history per D61 and one merged system message; strip markdown, emoji and URLs; Kokoro on the whole reply through `voice_for(lang)`; return one WAV.
- Tap rules per D51 (listen, stop, cancel), `turn_done` per D54, a fixed fallback line on Hermes error, and one JSON timing line per turn (last voiced frame, STT done, Hermes done, first audio out, detected language).
- Out: filler, stop phrases, diagnostics, status icons, Catalan TTS, sentence streaming, second device.

Build order: Hermes test; backend skeleton with `/healthz` and a logging `/ws`; STT on a WAV file (including an empty file and a silence file); Hermes client with timeouts and fallback; TTS to WAV (confirm Kokoro voice and language codes, unverified); wire the pipeline in `/ws`; page with state circle, taps, recording and the `nextT` playback queue; error paths (empty STT, Hermes down, Hermes slow, forced exception).

Exit test, all on the desktop with the GPU:

- 10 spoken turns (4 Spanish, 3 English, 3 Catalan, with short commands) each end with spoken audio and `turn_done reason=ok`.
- A tap on silence returns to idle with zero Hermes requests in the log.
- A wrong Hermes key, or Hermes stopped, gives a grey blob, the spoken fallback line, and idle within the timeout.
- A tap during speaking stops the audio. A tap during thinking cancels, and the next turn works.
- "What did I just ask?" within 5 minutes uses history; after 5 minutes idle it does not (or, if Hermes holds the session, the same holds on its side).
- The blob visibly changes in all five states.
- `nvidia-smi` peak VRAM is recorded and under 8 GB. The median SC1 time is logged.

**Later slices:**

- Slice 2, tablet with taps: minimal TLS or `adb reverse`, container image, PWA manifest, Wake Lock, audio-locked cue, tokens (D63, D64). Exit: 8 h at about 30 fps, tap turns working.
- Slice 3, hands-free: `vad-web`, wake word on the tablet only, mute rules (D68). Exit: measured false accepts over several days.
- Slice 4, alerts and timers: D56, D57, D66, scheduler, two shapes, `mix()` morph, one Home Assistant call through Hermes or direct. Exit: an alert is visible after a pod restart, and a voice timer works (or the regex fallback does).
- Later: sentence streaming (flush the first sentence at the first `[.!?]` followed by whitespace, send the rest as one chunk), filler, droplets, chime and quiet hours, stopwatch, second wake phrase, Catalan TTS, multi-device lease, speaches.

### Switch to option A if any of these happens

1. The tablet wake word drops more than once in 8 h on Chrome, or the tablet is an iPad, and the author does not accept tap or button mode.
2. The shader and the wake word cannot share the tablet (below about 30 fps or throttling at the lowest quality tier).
3. The custom wake model misses SC2 after about two training attempts, or the author will not maintain the training recipe.
4. Hermes cannot create a timer through `POST /alerts` and the Blob-side regex fallback proves too weak.
5. Timer, calendar and announcement logic starts to duplicate what Home Assistant owns, beyond the three or four sources.
6. Slices 1 and 2 take well beyond the plan (rule of thumb: more than about 6 weekends in total; a judgment call).
7. Precondition to check for about an hour before switching: Voice Satellite's overlay can be hidden and its satellite state is readable from another page. If not, option A is not viable.

To keep A alive cheaply, the display is a page whose only input is the WebSocket state and alert stream. The voice loop is then a replaceable client.

### Still open

- Q10 (partly): tablet model and OS, GPU model and vendor, where Hermes runs and its route back to `/alerts`. These are Stage 0 facts.
- Q11: opt-in clip log of the author's own voice for the STT benchmark.
- Q13: stopwatch, and how elapsed time shows without text (deferred, D58).
- Author name for the header.
- Licences of vad-web, openWakeWord, Kokoro and speaches to check before shipping. Read Voice Satellite (AGPL) for ideas but do not copy its code.

### Next three actions

1. Run the two kill-spikes (Hermes curl test; tablet stub page).
2. Record 10 test clips (Spanish, Catalan, English, with short commands) for the exit test and the STT benchmark.
3. Build slice 1 in the order above.

---

## Overview (round 1, history)

Blob is a web app that replaces a smart speaker. On screen it is a semi-transparent liquid-metal blob on a dark background, drawn with three.js. It is a sphere by default and morphs into other shapes. Each state has its own colour. It runs as one container on the user's homelab Kubernetes cluster. The UI shows in a desktop browser while the user works, or on a tablet in kiosk mode in the living room. On the tablet it is decorative, like a moving painting, so looks matter a lot.

**Voice path.** A wake word ("hola blob", "hi blob" or similar) is detected in the browser. Only after it fires does audio leave the device. The backend transcribes the speech with faster-whisper, sends the text to Hermes Agent (Nous Research) through its OpenAI-compatible HTTP API, cuts the streamed reply into sentences, and speaks them with TTS.

**Alert path.** Timers, calendar alerts and Home Assistant problems call `POST /alerts` on Blob's backend directly, with no LLM involved. The blob changes shape and colour and stays that way until the alert is read or attended. Hermes can create alerts by calling the same endpoint.

**Transport.** One WebSocket per client carries state, alerts and TTS audio. One device listens at a time.

**Status today.** The look, the stack and the 8-state table are decided. Round 1 review found the concept clear on appearance and weak on interfaces, state composition and failure behaviour. Round 2 (D15 to D43 in Key Decisions) gives a simple default for each of those gaps. What remains open is Stage 0 facts: tablet model, GPU model, and Hermes behaviour. The concept is ready for spikes, not for a full build.

### Terms used in this brief

| Term | Meaning |
| --- | --- |
| Turn | One cycle from wake word to the end of the spoken reply. |
| Wake word | Trigger phrase detected locally in the browser. |
| STT / TTS | Speech to text / text to speech. |
| VAD | Voice activity detection. Decides when the user stopped talking. The concept does not mention it. |
| Barge-in | Interrupting the blob while it speaks. |
| Mic lock | Server-side rule that lets one device be the listener at a time. |
| Active device | The device that holds the mic lock; it also plays sound (assumed). |
| Kiosk mode | Tablet browser locked to one full-screen page. |
| Wake Lock | Browser API that keeps the screen on. Needs a secure context and a visible page. |
| SDF | Signed distance function: a formula giving the distance from a point to a shape's surface. Lets the shader draw shapes without a mesh. |
| Raymarching | Drawing by stepping a ray through space until it nears a surface. |
| Smooth-min (smin) | A function that blends two SDFs into one merged shape (a smooth union). |
| Fresnel | Surfaces reflect more at grazing angles; gives the glassy rim. |
| Attended | Undefined by the user. See Q1. |

---

## Analysis

### Constraints

| Constraint | Value | Source |
| --- | --- | --- |
| Deployment | One container, homelab Kubernetes | User |
| GPU | Available; STT + TTS together within 8 GB VRAM | User |
| Languages spoken | Spanish, Catalan, English (prefers Catalan, Spanish) | User |
| Background | Dark (mandatory) | User |
| Mic access | `getUserMedia` needs HTTPS, so ingress needs TLS | User |
| Tablet | One first touch to unlock audio, persistent mic permission, Wake Lock | User |
| Hermes link | OpenAI-compatible server, default port 8642, localhost only, needs `API_SERVER_HOST` and `API_SERVER_KEY` in k8s | User (researched) |
| Privacy | Audio leaves the browser only after the wake word | User |

### Stack

| Component | Choice | Runtime / VRAM | Status |
| --- | --- | --- | --- |
| Wake word | openWakeWord (WASM) or Porcupine, custom "hola blob" model to train | Browser CPU | Open (engine not chosen) |
| STT | faster-whisper large-v3, int8_float16, language limited to {ca, es, en} | About 3 GB VRAM (user figure) | Decided; large-v3 vs large-v3-turbo to be measured |
| TTS (prototype) | Kokoro-82M, es and en only | Small (82M parameters) | Decided |
| TTS (later) | Matxa + alVoCat (BSC / Projecte AINA), Catalan only | About 1 GB (user figure) | Deferred |
| Rendering | three.js, fullscreen raymarching shader, SDFs | Client GPU | Decided |
| Transport | WebSocket, backend to every client | n/a | Decided |
| Hermes link | `/v1/chat/completions`, `stream: true`, sentence cutting | n/a | Decided; behaviour unverified |

VRAM note from review (unverified, from reviewer memory): each process adds a CUDA context of about 0.3 to 0.5 GB, so budget Whisper at about 3.5 GB. The "about 1 GB" for Matxa may be disk size, not VRAM. If Hermes's own LLM runs on the same GPU, the 8 GB budget is wrong; the concept does not say where Hermes's model runs.

### Language matrix

| Language | Wake word | STT | TTS (prototype) | Reply |
| --- | --- | --- | --- | --- |
| Catalan | Not planned ("hola" is shared with Spanish) | Yes, accuracy unmeasured | None | Spoken in Spanish or English |
| Spanish | Yes | Yes | Kokoro | Spanish |
| English | "hi blob" if a second phrase is added | Yes | Kokoro | English |

Consequence the user accepted: the user may speak Catalan, but replies are spoken in Spanish or English, and Hermes must be told to answer in es/en. The user prefers Catalan, so this is a known product gap, not a neutral limit (see D6 and the revisit trigger in Alternatives).

### Behaviour states (as approved by the user)

| State | Shape | Colour | Motion |
| --- | --- | --- | --- |
| idle | Sphere | Deep blue / violet | Slow breathing |
| wake | Sphere | Cyan flash | Flash |
| listening | Sphere | Cyan | Deforms with mic volume |
| thinking | Sphere (superseded: was "slow cycle through shapes"; see Current Design and D25/D70) | Amber | Slow breathing |
| speaking | Sphere | Warm white | Pulses with TTS audio |
| alert-info | Shape by alert source | Green / blue | Persists until attended |
| alert-urgent | Shape by alert source | Red / magenta | Faster, more insistent |
| offline / error | Sphere | Dim grey | Dim |

Rule approved by the user: shape = alert source, colour = urgency. More states can be added later.

### Findings from the seven lenses

Findings are deduplicated and grouped by severity. "Lens" names the reviewer(s) that raised it.

#### Blockers (can invalidate the concept or block any build)

| ID | Finding | Lens | Suggested handling |
| --- | --- | --- | --- |
| R1 | **Tablet feasibility is unproven.** The "painting with an always-on mic" case needs all of these at once on the real tablet: raymarched shader at usable fps without overheating, persistent mic permission, WASM wake word running continuously, Wake Lock, audio unlock, HTTPS. Tablet model, OS and browser are not stated. iPad Safari has fragile always-on mic and audio unlock (reviewer memory, unverified). Android kiosk browsers may need a setting to auto-grant the mic (unverified). Whether the mic survives screen-off is untested. | design, zoom-out, impl-readiness, inventive | Name the tablet and browser. Run a day-0 spike: stock wake word + stub shader + `getUserMedia`, running for hours. |
| R2 | **Alert contract is missing.** `POST /alerts` has no payload, no auth, no dedupe key, no clear/acknowledge call. Timer ownership is unclear: a timer is a future event, but `/alerts` reads as "alert now". Who runs the countdown (Blob, Hermes or Home Assistant)? | comprehension, impl-readiness, design | Define a versioned schema (see Decisions, D9). Decide timer ownership (Q6). |
| R3 | **"Attended" is undefined.** The core alert rule says alerts persist until read or attended. Voice, touch, timeout and source-clears are all possible. "Read" (spoken aloud) and "attended" (acknowledged) are different. | comprehension, design, zoom-out | User decision (Q1). |
| R4 | **No turn narrative and no end-of-speech design.** The concept does not say how the system knows the user stopped talking (VAD), what happens if the wake word fires and nobody speaks, or whether there is a listening timeout. Whisper also tends to produce text from silence or noise (reviewer knowledge, high confidence). A false wake can then become a Hermes turn. | design, comprehension, impl-readiness, codebase | Run VAD in the browser, with a pre-roll buffer, a hard utterance cap and a listen timeout. Drop empty or low-confidence transcripts before Hermes. |
| R5 | **Alert state is lost on pod restart.** Alerts "stay until attended" but no storage is defined. With in-memory state, a restart or rollout drops active alerts and any timers Hermes created. | impl-readiness, structural, design | Choose: persistent (SQLite on a PVC) or explicitly volatile (Q7). |
| R6 | **Security: voice and ingress.** Anyone or anything in earshot (guest, TV saying "hola blob") can start a Hermes turn; Hermes has tools. TLS ingress exposes the WebSocket and `/alerts`; unauthenticated `/alerts` allows spoofed or flooded alerts. | design, codebase, impl-readiness | Token on `/alerts` and on the WebSocket; keep `/alerts` off the public ingress where possible; restricted Hermes toolset for the voice channel; log every turn. |

#### Major

| ID | Finding | Lens | Suggested handling |
| --- | --- | --- | --- |
| R7 | **Eight states mix two things.** Conversation states (idle, wake, listening, thinking, speaking) and alert states are not mutually exclusive. The table does not say what happens when an alert arrives during listening, thinking or speaking, or when the user speaks while an alert is open. | design, impl-readiness, structural, comprehension, inventive | Model as two layers: a conversation state machine plus an alert set. Display is a function of both. Shape and colour live in one data table. |
| R8 | **Several simultaneous alerts.** One body has one shape. Which alert shows when two are open? | comprehension, inventive, zoom-out | User decision (Q2). Reviewer sorting default: urgency, then arrival time (proposal, not a decision). |
| R9 | **Meaning collision: thinking cycles through shapes, but shape = alert source.** A thinking blob can look like a calendar-alert triangle. | inventive | User decision (Q9). Options in Alternatives. |
| R10 | **Morph operator is probably wrong.** Smooth-min is a union. Sphere smin cube gives a larger merged bulge, not a sphere turning into a cube. Reviewers (two, high confidence) say a morph is `mix(sdfA, sdfB, t)`, with the march step shortened about 0.6 to 0.8 because the result is not an exact distance field. Smooth-min stays useful for lava-lamp merging of droplets. The user chose "smooth-min" in the rendering decision. | design, codebase | Prototype one transition and look at it before committing. |
| R11 | **Metal and transparency on a near-black background.** Reflection and fresnel need something to reflect; otherwise the blob looks dead. True refraction needs a second march and costs more. | codebase, design | Procedural studio-style environment tinted per state; fake transparency with fresnel alpha. Decide this up front. |
| R12 | **Tablet GPU, thermal and screen wear on a 24/7 display.** Caps on pixel ratio and march steps are named; more are possible: bounding-volume early exit (most pixels are empty background), render at 0.5 to 0.75 scale, 30 fps cap in idle, frame-time-based quality governor, dithering against banding, slow drift against burn-in, night dimming. Thermal throttling also hurts the wake-word worker. | codebase, design, inventive, impl-readiness | Fixed frame-time budget measured on the real tablet. Named quality tiers. |
| R13 | **Language detection on short clips.** Picking the highest probability among {ca, es, en} is the standard method (reviewer, high confidence), but it is unreliable on 1 to 3 s utterances, especially Catalan vs Spanish. A full detection pass costs an extra encoder pass; transcribing once and checking the detected language is cheaper. Large-v3 is not "light" (about 1.55B parameters, reviewer memory). | codebase, design, comprehension | Measure on the user's own audio. Consider a sticky prior from the last turn. Make the model name a config value. |
| R14 | **Wake word is a larger project risk than the concept admits.** "hola blob" is short; "hola" is common speech in Spanish and Catalan homes. openWakeWord has no official browser build; community ports run its three ONNX models in `onnxruntime-web` (reviewer memory, unverified; maintenance is the user's problem). Pretrained openWakeWord models are CC BY-NC-SA (unverified); the user's own trained model depends on the training data. The openWakeWord training recipe uses English-voice synthetic data, so Spanish and Catalan phrases may need real recordings (unverified). Porcupine needs an AccessKey, has a non-commercial free tier, and (reviewer memory, low confidence) does not support Catalan. | design, codebase, comprehension, zoom-out | Spike on the real tablet. Measure false accepts per hour with TV, music and speech. Run the detector in a Worker or AudioWorklet, not on the main thread next to the shader. |
| R15 | **Echo and self-trigger.** The blob's own TTS can trigger the wake word, especially if a reply contains "blob". No barge-in decision exists. | design, zoom-out, comprehension, impl-readiness, inventive | Mute wake detection while speaking; echo cancellation on; no barge-in in the prototype; test on the real tablet speaker. |
| R16 | **Mic lock lifecycle.** No lease, heartbeat or timeout. A tablet that sleeps or loses Wi-Fi mid-turn could hold the lock and leave every device deaf. Two devices can detect the wake word within milliseconds of each other. Mirrors cannot animate to mic volume or TTS audio unless an envelope is sent to them. | design, impl-readiness, structural, comprehension | Lease with heartbeat and expiry. Short arbitration window. Send a level/envelope stream for mirrors. Multi-device is a candidate for later staging (S3). |
| R17 | **Hermes behaviour is unverified.** Whether `/v1/chat/completions` keeps server-side sessions or expects history; whether a system message is honoured; whether streamed output contains tool-progress lines, markdown, emoji or URLs that must be stripped before TTS; how concurrency behaves; how a long agent run (tools) shows in the stream. Hermes push to Blob is unverified. | all | Day-0 `curl` spike. Strip markdown, emoji and URLs before TTS. Sentence splitting must handle decimals, abbreviations and Spanish `¿¡`. |
| R18 | **Hermes does not know about alerts.** Alerts bypass Hermes, so Hermes cannot answer "what was that alert?" or "snooze the timer" unless told. | inventive, design | Option: Blob injects a short active-alert summary into each Hermes request; Hermes manages alerts through Blob's endpoints. Needs a check that Hermes can use a custom tool. |
| R19 | **Success criteria are missing.** No latency target, no false-wake target, no frame-rate target. | comprehension, zoom-out, impl-readiness, design | User decision (Q5). Add per-turn timestamps from the first build. |
| R20 | **Kubernetes and GPU operations.** One GPU means one replica. Default rolling updates leave the new pod pending while the old one holds the GPU, so use `replicas: 1` with `strategy: Recreate` (every deploy has downtime). Model weights should live on a PVC, not in the image. The container needs a CUDA base image that matches the pinned CTranslate2 and cuDNN versions (unverified). `int8_float16` needs compute capability 7.0 or higher (unverified). The GPU vendor and model are not stated; an AMD GPU would break the faster-whisper plan (unverified). STT/TTS inference must not block the WebSocket event loop. | design, codebase, impl-readiness | Name the GPU. Skeleton container spike with real VRAM measurement. |
| R21 | **Kiosk TLS trust.** A private CA may not be trusted by Android kiosk apps. | design, codebase, impl-readiness | Real domain, Let's Encrypt through cert-manager DNS-01, internal DNS. |
| R22 | **Catalan TTS gap contradicts the user's stated preference.** Alert text from calendar and Home Assistant is often Catalan; Kokoro will mispronounce it. | design, inventive, codebase | See Alternatives (Piper Catalan stopgap). |
| R23 | **No observability.** A bad or slow turn cannot be traced. The tablet has no devtools. | codebase | A `turn_id` and timestamps: wake, end of speech, STT done (with detected language), Hermes first token, first sentence, first audio out. Client error and wake-word score reporting. `/healthz` covering models loaded, Hermes reachable, GPU present. |
| R24 | **Contract versioning.** A kiosk tablet can run a cached old frontend against a newer backend. HA and calendar automations hold old `/alerts` payloads. | impl-readiness | `version` field in the WebSocket hello and in `/alerts`; defined behaviour on mismatch; forced reload on version bump. |
| R25 | **Timers and stopwatch.** "Set a timer for 10 minutes" goes through Hermes; something must create, persist and fire the timer. A stopwatch is a running display, not an alert, and the blob has no text to show elapsed time. | codebase, design, impl-readiness | Decide ownership (Q6). Home Assistant already has timer helpers (reviewer suggestion). |

#### Nit

| ID | Finding | Lens |
| --- | --- | --- |
| R26 | The concept calls Whisper "light", but large-v3 is not light. Reword to "large-v3, with large-v3-turbo as a candidate". | comprehension, codebase |
| R27 | Privacy statement is narrow. Audio leaves the browser only after wake, but then goes to the backend. The concept does not say whether audio or transcripts are stored or logged, or that Hermes may forward text to an external LLM provider. | comprehension, inventive |
| R28 | "One container" holds a UI, a backend and GPU workers. The process model (one process or several), model cache, ingress WebSocket timeouts (nginx closes idle sockets after 60 s by default, unverified) and ping/pong need definition. | comprehension, codebase |
| R29 | The offline/error state is one grey sphere for many causes (mic denied, socket down, Hermes down, audio locked). Before the first touch, the tablet needs a visible "audio locked" signal, or a silent tablet is invisible. | comprehension, design |
| R30 | The custom wake-word model is a one-off artifact. Record the training recipe and data, and version the file. | structural, impl-readiness |
| R31 | "More insistent" for urgent alerts has no measurable meaning (speed, pulse rate, sound?). Sound design (wake chime, alert tone) is not mentioned. | comprehension |
| R32 | Rendering with WebGL2 is safer than WebGPU on tablets (reviewer, medium confidence). A single fullscreen quad uses little of three.js; plain WebGL2 would also work. Optional. | codebase, design |

### Reuse candidates (all unverified; confirm before use)

- STT/TTS behind an OpenAI-compatible HTTP API: speaches (formerly faster-whisper-server), with Kokoro and Piper support. Alternatives: Kokoro-FastAPI, or Wyoming protocol servers used by Home Assistant. Could run as a sidecar in the same pod.
- `@ricky0123/vad-web` (Silero VAD in the browser) for end-of-speech detection.
- `onnxruntime-web` plus a maintained openWakeWord web port.
- Inigo Quilez's published SDF and smooth-min formulas.
- `Intl.Segmenter` (sentence granularity) or `pysbd` for sentence splitting; `lingua` or `franc` for text language ID.
- BSC may publish a Catalan fine-tuned faster-whisper model (reviewer recalled a name such as `projecte-aina/faster-whisper-large-v3-ca-3catparla`; medium-low confidence on the exact name). Check Hugging Face.
- cert-manager with DNS-01 for TLS.

---

## Prior Art (searched 2026-11-12)

The author asked whether something similar exists, to borrow ideas, fork it, or stop. Findings come from web searches and page fetches on the date above. I did not install or run any of them. Star counts and dates come from the pages as fetched. Items marked "unverified" are inferences.

### Closest existing projects

| Project | What it covers | What it lacks for Blob | Licence / health |
| --- | --- | --- | --- |
| [Voice Satellite](https://github.com/jxlarrea/voice-satellite-card-integration) (HACS, for Home Assistant) | Turns a browser, tablet or phone into an Assist satellite. Wake word runs in the browser in JavaScript (microWakeWord on CPU, plus WebGPU engines), so audio leaves the device only after the wake word. Custom wake-word `.tflite` files, up to two wake words in parallel, each with its own pipeline. 10 skins, including "Ink Blobs". Timers with countdown pills. Services `assist_satellite.announce`, `start_conversation`, `ask_question`. Chimes for wake, done, error, alert, announce. Screensaver. Works with any Assist pipeline (Whisper, Piper, Kokoro, LLM agents). | Custom skins are not supported beyond CSS overrides (developer reply seen in a community thread, second-hand). No documented persistent on-screen alert that stays until attended. The page does not list wake-word languages. No liquid-metal orb. | AGPL-3.0. 927 stars, 846 commits, 9 open issues. Pull requests are not being accepted. Needs Home Assistant 2025.6.1 or later and HTTPS. |
| [Kiosk Satellite](https://newreleases.io/project/github/jxlarrea/kiosk-satellite/release/2026.9.87) (Android app, same author) | Runs the wake word natively, so it keeps listening with the screen off. Starts on boot. The page says detection is 10x to 30x faster than in-browser. Voice Satellite is built in. | Same as above. | Free, per the Voice Satellite page. Not independently checked. |
| [majorminorlabs/hermes-voice](https://github.com/majorminorlabs/hermes-voice) | Home Assistant conversation agent that sends each turn to a Hermes profile, with a session ID so Hermes keeps the history. Streaming replies. Says a short "working" phrase while Hermes runs a tool. Speaks a fallback line on timeout. | No Home Assistant device control in v0.1. Needs Home Assistant 2026.10 or later. Reported latency about 3.5 s per plain turn. | MIT, but the bundled "Hey Hermes" wake-word model is non-commercial. About 685 stars. |
| Other Hermes to Home Assistant conversation agents: [ha-hermes-conversation](https://github.com/brotherbrown831/ha-hermes-conversation), [WolframRavenwolf/hermes-ha-integration](https://github.com/WolframRavenwolf/hermes-ha-integration), [RichiCoder1/hermes-assistant](https://github.com/RichiCoder1/hermes-assistant), [sj-unit72/hass-hermes](https://github.com/sj-unit72/hass-hermes) | Each registers Hermes as a selectable Assist conversation agent through Hermes's OpenAI-compatible API. | Community projects of unknown maturity. Not compared. | Not checked. |
| [rusty4444/hermes-voice-ha-integration](https://github.com/rusty4444/hermes-voice-ha-integration) | Wake word, STT, Hermes, TTS and a Home Assistant media player. Hermes tools for Home Assistant. | Assist replies are a single completion with no tool calls. Room-satellite experience "needs more work" (its README). | MIT. 94 stars. v0.0.20 dated 2026-11-12. |
| Hermes Agent's own voice mode ([wake word docs](https://hermes-agent.nousresearch.com/docs/user-guide/features/wake-word), [voice mode](https://github.com/nousresearch/hermes-agent/blob/main/website/docs/user-guide/features/voice-mode.md)) | Wake word ("hey hermes"), faster-whisper, sentence-by-sentence TTS, barge-in, stop phrases like "never mind". | Wake word runs only in the CLI, TUI and desktop app, not in a browser. The docs describe English models only. No documented push channel to clients. | Part of Hermes. |
| [OrbitVox](https://orbitvox.github.io/) | Local Whisper and Kokoro with a browser orb that follows the loudness of the voice output. Silero VAD ends the turn after 0.8 s of silence. | Windows only. No wake word. Not a kiosk. | MIT. |
| Voice-assistant demos with an orb or web UI ([PanPenek/JarvisAi](https://github.com/PanPenek/JarvisAi), [aymanokas/jarvis](https://github.com/aymanokas/jarvis), [kushaldave002/Whisper_Voice_Assistant](https://github.com/kushaldave002/Whisper_Voice_Assistant)) | openWakeWord, Whisper, Kokoro, a local web UI or desktop overlay. | Single-user desktop projects, no alerts, no kiosk, no Hermes. Useful as code to read, not to fork. | Not checked. |
| Shader references: [webgl-shader-lab](https://github.com/PSCactux/webgl-shader-lab) (raymarched "Liquid Metal" metaballs on a fullscreen quad), [shader-playground](https://github.com/douglasgoodwin/shader-playground) (audio-reactive SDF, ferrofluid), Codrops [audio-reactive shaders](https://tympanus.net/codrops/2023/02/07/audio-reactive-shaders-with-three-js-and-shader-park/) and [liquid raymarching](https://tympanus.net/codrops/2024/07/15/how-to-create-a-liquid-raymarching-scene-using-three-js-shading-language/) | Working examples of the exact look. | None combine the look with a voice assistant. | Not checked. |

No project was found that combines a liquid-metal blob display, persistent shape-and-colour alerts, and a voice loop to Hermes. The pieces exist separately.

### What this changes

The voice half of Blob (wake word in the browser, tablet kiosk, STT, TTS, timers, announcements, Hermes as the brain) is already built by Voice Satellite plus a Hermes conversation agent, if the author runs Home Assistant. The author's alert examples (Home Assistant problems, calendar, timers) suggest they do; this has not been confirmed. What does not exist is the Blob display and the persistent alert semantics.

Home Assistant side facts that help: an Assist satellite exposes a state (idle, listening, processing, responding in the Home Assistant developer docs, unverified for this integration) that another page can read; Home Assistant has Piper voices including Catalan and Whisper for STT (a 2023 Home Assistant post and a June 2025 post that says Catalan support is being added as an official language; accuracy not confirmed); Home Assistant already owns timers, calendar and automations.

### Options

| Option | What gets built | What it costs | Risks |
| --- | --- | --- | --- |
| A. Blob as a display layer on Home Assistant (reviewer's recommendation; the author chose C, so this is the fallback) | Install Voice Satellite (or Kiosk Satellite on the tablet) and a Hermes conversation agent. Build only a Home Assistant custom card or panel that draws the three.js blob and reads satellite state, timers and alert entities. Hide Voice Satellite's own overlay with its CSS override field. | The shader, the state-to-shape table and the alert mapping. Removes the wake word, VAD, STT/TTS serving, mic lock, WebSocket, alert API, SQLite and TLS work from the plan (D16 to D19, D21, D23, D31 to D40 mostly drop). | Depends on Home Assistant and two community projects. Hiding the overlay by CSS is unverified. The blob cannot follow mic volume unless an audio level is available to the card (otherwise it pulses on a synthetic envelope). Hermes integrations differ in maturity and need recent Home Assistant versions. About 3.5 s per turn was reported for one of them. |
| B. Fork Voice Satellite and add a Blob skin | A skin inside the fork, with the full engine. | A fork of an 846-commit AGPL project whose author does not take pull requests, so the author owns every merge from upstream. | High maintenance cost for a visual feature. AGPL applies to the modified code. |
| C. Keep the standalone plan (D15 to D43) | Everything. | The largest build. | The risks of round 1 (tablet, wake word, alerts), all self-owned. Gives full control, no Home Assistant dependency, and Hermes-native behaviour. |
| D. Hermes native voice only | Nothing. | None. | Wake word is not available in a browser. No blob. Not a fit. |

### Author decision: option C

The author chose option C, the standalone build. Reasons given by the author: Blob must be a general assistant, not a Home Assistant add-on; Home Assistant control is Hermes's job through its own Home Assistant integration; and Hermes cannot do some things, such as stopwatches or timers, so Blob needs its own logic. Options A, B and D are rejected by the author for that reason. Option A stays on record as the cheaper path if the standalone build stalls on a risk found in Stage 0 (tablet or wake word); the author has not said to revisit it.

### Ideas worth copying either way

- A short spoken "working" phrase while Hermes runs a tool, and a spoken fallback line on timeout (hermes-voice). Fills the silence in the `thinking` state.
- Session scopes `per_conversation` (5 min idle) and `per_device` (30 min idle) (hermes-voice). Compare with D31.
- Native wake word in an Android kiosk app instead of the browser (Kiosk Satellite). This directly addresses the tablet risk R1.
- Two wake words in parallel, each routed to its own pipeline (Voice Satellite). Could give "hola blob" and "hey blob" without one multilingual model.
- Stop phrases like "never mind" matched on the whole utterance only (Hermes wake-word docs). Also a barge-in grace time and a threshold multiplier.
- A "Copy report" diagnostics button on the device (Voice Satellite). Fits the observability gap R23.
- Silero VAD with about 0.8 s end-of-turn silence (OrbitVox).
- Liquid-metal raymarch reference code (webgl-shader-lab, shader-playground).

---

## Goals vs. Non-Goals

Success numbers are not set by the user. Reviewers offered starting proposals; they are listed as proposals only.

### Goals

| ID | Goal |
| --- | --- |
| G1 | Replace a smart speaker for a spoken question-and-answer loop, with Hermes Agent as the brain. |
| G2 | Detect the wake word in the browser so audio leaves the device only after it. |
| G3 | Transcribe Spanish, Catalan and English speech with faster-whisper on the homelab GPU. |
| G4 | Speak replies with TTS, starting early by cutting the streamed reply into sentences. |
| G5 | Show alerts (timers, calendar, Home Assistant) that persist until attended, without an LLM in the path. |
| G6 | Look like a moving painting on a dark background: sphere by default, smooth morphs, metallic and semi-transparent. |
| G7 | Run as one container on the homelab cluster, with STT and TTS within 8 GB VRAM. |
| G8 | Work in a desktop browser and on a kiosk tablet. |

### Success criteria (user has not set values)

| ID | Criterion | Value | Notes |
| --- | --- | --- | --- |
| SC1 | End of speech to first spoken audio | TBD | Reviewer proposals: p50 under about 2.5 to 3 s for tool-free replies. Not agreed. |
| SC2 | Wake-word false accepts | TBD | Reviewer proposal: under 1 per day with TV or music on. Not agreed. Also set a miss rate (per ten attempts). |
| SC3 | Language-ID accuracy and WER on the user's Catalan, Spanish, English clips | TBD | Measured to choose large-v3 vs large-v3-turbo. |
| SC4 | Tablet frame rate and temperature over hours | TBD | Measured on the real tablet. |
| SC5 | Time from `POST /alerts` to visible change on all screens | TBD | |
| SC6 | Recovery time after a pod restart | TBD | |

### Non-Goals (proposed; user to confirm)

| ID | Non-goal |
| --- | --- |
| NG1 | Catalan TTS in the first prototype (deferred by the user). |
| NG2 | Speaker identification and multi-user personalization. The design has no speaker check (see R6). |
| NG3 | Several devices listening at once. |
| NG4 | Smart-speaker skills such as music or shopping. |
| NG5 | Relying on Hermes pushing messages to Blob on its own (unverified; use `/alerts` only). |
| NG6 | A native app. |
| NG7 | Barge-in (interrupting the blob while it speaks) in the prototype. |
| NG8 | Blob-side calendar or Home Assistant polling. Sources call Blob. |
| NG9 | A dependency on Home Assistant, or being a Home Assistant add-on or card (author's decision, option C). |

---

## Alternatives Weighed

Only rejected, deferred or contested options are listed. The chosen path is in the Stack table.

| Area | Chosen | Alternatives | Reason / reviewer note | Revisit trigger |
| --- | --- | --- | --- | --- |
| STT model | large-v3 (int8_float16) | large-v3-turbo; a Catalan fine-tune (unverified) | Turbo is faster but may lose accuracy on Catalan (reviewer memory). Not measured. | Benchmark on the user's audio (SC3). |
| STT language choice | Highest probability among {ca, es, en} | Transcribe once and re-run only if the detected language is outside the set; sticky prior from the last turn | Short clips confuse Catalan and Spanish. | SC3 results. |
| TTS prototype | Kokoro only (es, en) | Piper for all three languages on CPU; Piper for Catalan only next to Kokoro; Matxa + alVoCat | Piper has Catalan voices such as `ca_ES-upc_ona` and `upc_pau` (reviewer memory, two reviewers, unverified). Piper's original repo was archived and development moved to a GPL fork (unverified). Voice licences are per voice. A per-sentence "language to voice" router would let Matxa replace Piper later with no client change. The user chose to defer Catalan TTS; the Piper stopgap is a reviewer suggestion, not a decision. | User listens to Piper Catalan and decides (Q8). |
| TTS rejected | n/a | XTTS-v2 | No Catalan (user). | None. |
| Wake-word engine | Open (openWakeWord or Porcupine) | Server-side wake word | Browser keeps audio local. Porcupine: AccessKey, non-commercial free tier, no Catalan (unverified). openWakeWord: community browser port, licence caveats on pretrained models (unverified). | Tablet spike (R14). |
| Wake-word phrases | Open | One model with both phrases; two models running in parallel; "hola blob" only | openWakeWord classifiers are small and share early stages, so two models may be cheap (reviewer, unverified). Ship one phrase first and add "hi blob" only if measured misses justify it (two reviewers). | Q4 and the false-accept measurement. |
| Wake-word fallback | n/a | Push-to-talk / tap-to-talk first | Gives a useful desktop mode and a test harness for everything downstream. | Used in Stage 1. |
| Render morph | Raymarched SDF with smooth-min | `mix(sdfA, sdfB, t)` for morphs, smin for droplets (two reviewers); icosphere vertex displacement (rejected by user: no straight edges) | See R10. | Visual prototype of one transition. |
| Transparency | Fresnel, semi-transparent | True refraction (second march) | Refraction is costly on a tablet. | If fresnel alpha looks flat. |
| Alert routing | Bypass Hermes, `POST /alerts` | Route alerts through Hermes | Bypass avoids LLM latency and failure. Cost: Hermes does not know about alerts (R18). | None. |
| Hermes link | OpenAI-compatible API | Anything else | Documented by the user. | Spike results. |
| Thinking visual (R9) | Slow cycle through shapes (user-approved) | Keep sphere, amber tint, small orbiting droplets that merge and split; reserve polygon morphs for alerts | Removes the meaning collision. Reviewer proposal; changes an approved row. | Q9. |
| Alert display (R7, R8) | One shape for the active alert | Alerts as small satellite blobs attached to the core by smooth-min; one satellite per source coloured by the highest urgency; cap about 4 with overflow dots | Speculative. Lets alerts and conversation coexist and shows multiple alerts. Readability across a room is unproven. | Visual prototype on the tablet. |
| Alert persistence vs calm | Persist until attended | Attention envelope: strong onset (morph, colour, chime), settle after about 10 s into a held shape at lower contrast; urgent alerts re-escalate every 2 to 5 min; info alerts never | Reviewer proposal, not tested. | Q1 and tablet trial. |
| Alert lifecycle | Not defined | Upsert by `source` + `id`; clear by `DELETE` or `state: resolved`; sources own their lifecycle; per-alert TTL as safety net | Avoids stale alerts on the screen. | Q1. |
| Streaming | Stream, cut into sentences, feed TTS early | Take the whole reply first and measure | Streaming plus splitter plus ordered playback is real code before latency is known. | Add if time to first audio is bad. |
| Multi-device mic lock | Server lock, first wake wins | Defer; single device first; winner chosen by wake score and mic level in a 200 to 300 ms window (speculative) | Distributed-systems feature for two use cases used one at a time. | Stage 3. |
| Alert logic location | Blob endpoint only | Blob owns timers, calendar, HA polling | Home Assistant already has timers, calendar triggers and automations; keep Blob thin. | Q6. |
| Number of states | Eight | Four in slice 1 (idle, listening, thinking, speaking); wake is a short transition into listening; alert-info and alert-urgent are one state with an urgency parameter; offline is a rule | The user approved the 8-row table. This is a staging suggestion, with the table kept as a data table so rows can be added. | Stage 2. |
| Product shape | Standalone Blob (author, option C) | A. Display card on Home Assistant over Voice Satellite plus a Hermes agent; B. Fork Voice Satellite with a Blob skin; D. Hermes native voice only | Rejected by the author: Blob must be general and not tied to Home Assistant; Hermes handles Home Assistant itself. A is the cheaper path and stays on record if Stage 0 shows the tablet or wake word cannot be made to work. | Stage 0 tablet or wake-word spike fails. |
| Session handling | Open | Send only the current utterance and rely on Hermes memory; send recent history from Blob; one rolling session with idle expiry (5 to 10 min proposed) | Depends on what the Hermes API does. | Q3 and Hermes spike. |

---

## Key Decisions & Staging for Next Steps

### Decision log

| ID | Decision | Status |
| --- | --- | --- |
| D1 | One container on homelab Kubernetes; desktop browser and kiosk tablet clients | Decided |
| D2 | GPU for Blob; STT + TTS within 8 GB VRAM | Decided |
| D3 | STT: faster-whisper large-v3 int8_float16, language limited to {ca, es, en}; large-v3-turbo to be benchmarked | Decided, model provisional |
| D4 | TTS prototype: Kokoro-82M; Catalan TTS deferred; XTTS-v2 rejected | Decided |
| D5 | Wake word runs in the browser; custom model to train; TLS ingress required | Decided; engine open |
| D6 | Catalan in, Spanish or English out; Hermes told to answer in es/en | Decided (prototype), flagged as a gap against stated preference |
| D7 | Hermes via `/v1/chat/completions`, `stream: true`, sentence cutting | Decided; behaviour unverified |
| D8 | Alerts bypass Hermes; sources call `POST /alerts`; Hermes may call it too | Decided |
| D9 | `/alerts` schema, auth and lifecycle | Open (reviewer sketch below) |
| D10 | WebSocket carries state, alerts and TTS audio | Decided; message schema open |
| D11 | One listening device; mic lock on the server | Decided; lease and arbitration open |
| D12 | All screens mirror state and alerts; sound only on the active device | Assumed (user did not contradict) |
| D13 | Eight states; shape = alert source, colour = urgency | Decided (user approved); composition rules open |
| D14 | Rendering: fullscreen raymarched SDF shader; icosphere displacement rejected | Decided; morph operator under question (R10) |

Reviewer sketch for D9 (a proposal, not a decision): `id` or dedupe key, `source`, `urgency`, `text`, `lang`, `created_at`, optional `fire_at` / `ttl`, `state`, `version`. Bearer token. Clear by `DELETE /alerts/{key}` or `state: resolved`. One `curl` example for Home Assistant in the spec.

### Round 2 decisions (author asked for the simplest practical default for each open point)

The author gave one preference: the tablet client should be a PWA, and WASM for the wake word is acceptable. For everything else the author delegated the choice and asked for the simplest option that works now, to be refined later. The rows below are therefore recommended defaults accepted by delegation, not independent author opinions. Each can be reopened. Items that depend on facts nobody has checked yet are marked "spike".

| ID | Resolves | Decision | Why this and not more |
| --- | --- | --- | --- |
| D15 | R1, Q10 | Tablet client is a PWA (`display: fullscreen`) in Chrome on an Android tablet that stays plugged in. Wake Lock keeps the screen on. If the tablet is an iPad, start with tap-to-talk only. | The PWA needs no kiosk app. The tablet model is still unknown (see Q10). |
| D16 | R1, R14, Q4 | Tapping the blob always starts listening, on every device. The wake word is added in Stage 2 as an extra trigger, not the only one. | Tap-to-talk works with no wake-word risk and doubles as the fallback. |
| D17 | R14, Q4 | One wake phrase, run with openWakeWord in WASM inside a Web Worker. Proposed phrase: "hey blob" instead of "hola blob". Test the pipeline first with a stock phrase such as "hey jarvis". | "Hola" is common Spanish and Catalan speech. "Hey" is not. The openWakeWord training recipe is English-centred (unverified), so "hey blob" fits it better. The author's "or similar" allows this. Spike. |
| D18 | R4 | End of speech and silence handling: `@ricky0123/vad-web` (Silero VAD) in the browser. End the utterance after 1 s of silence. Stop listening after 8 s with no speech. Hard cap of 15 s per utterance. Run faster-whisper with `vad_filter=True` and drop empty transcripts or high `no_speech_prob` before calling Hermes. | A false wake must end as a silent return to idle, not as a Hermes turn. |
| D19 | R15 | Echo: browser echo cancellation on, wake detection muted while Blob speaks, no barge-in in the prototype. | Avoids the blob triggering itself with "blob" in its own reply. |
| D20 | R2, R3 | "Attended" = the user taps the blob. A tap reads the alert text aloud and clears it. The source can also clear it with `DELETE /alerts/{key}`. Voice acknowledgement is deferred to Stage 4. | One gesture, no voice parsing. |
| D21 | R2, R24, R6 | `POST /alerts` body: `key`, `source`, `urgency` (`info` or `urgent`), `text`, optional `lang` (default `ca`), optional `ttl_s`, optional `fire_at`. Upsert by `key`. Unknown fields are ignored. Bearer token required. | Small enough to write as a single `curl` example for Home Assistant. |
| D22 | R25, Q6 | Timers: Blob owns them. A timer is an alert with `fire_at`; a small scheduler in the backend fires it. Hermes creates a timer by calling `POST /alerts` with `fire_at`. The stopwatch is a non-goal. | Avoids needing Hermes-to-Home-Assistant wiring for the most common request. |
| D23 | R5, Q7 | Alerts are stored in SQLite on a PVC. On startup the backend reloads open alerts and pending `fire_at` timers. | Without it, a pod restart loses timers. |
| D24 | R7, R8, Q2 | Two layers: the conversation state machine and an alert list. While a conversation turn is active, the conversation display wins. When the turn ends, the top alert shows. Order: `urgent` before `info`, then oldest first. Only the top alert is drawn; after it is cleared the next one shows. | No alert interrupts a turn, and no multi-alert layout in the prototype. |
| D25 | R9, Q9 | `thinking` keeps the sphere and the amber colour, with small droplets orbiting inside or around it. Polygon shapes are reserved for alerts. This changes the approved row. | Removes the collision between "thinking cycles shapes" and "shape = alert source". |
| D26 | Q6 | First alert sources and provisional shapes: `timer` = triangle, `calendar` = square, `homeassistant` = hexagon, anything else = rounded cube. Urgency colour as approved. Final shapes are picked when the shader works. | Four entries are enough to test the mapping. |
| D27 | R31 | `urgent` = pulse about twice as fast as `info`, plus a soft chime every 2 min on the active device. `info` is silent. | Gives "more insistent" a measurable meaning. |
| D28 | R10 | Morphs use `mix(sdfA, sdfB, t)` with the march step cut to about 0.7. Smooth-min is kept only for the `thinking` droplets. Prototype one transition before building the rest. | Two reviewers said smooth-min merges shapes into a bulge instead of morphing them. |
| D29 | R11 | Transparency is faked with a fresnel term and a procedural dark studio-gradient environment, tinted per state. No refraction pass. | A second march costs too much on a tablet. |
| D30 | R12 | Tablet performance: render at 0.75 scale, exit early outside a bounding sphere, cap idle at 30 fps. Measure frame time and temperature on the real tablet. | These are three cheap changes that cover most of the cost. |
| D31 | R17, Q3 | Blob keeps the conversation history itself: last 6 messages, dropped after 5 min idle, sent with each `/v1/chat/completions` call. A fixed system message asks for short spoken sentences, no markdown, and a reply in Spanish or English (Catalan input gets a Spanish reply). Strip markdown, emoji and URLs before TTS. Spike on the real Hermes API. | Works whatever the Hermes server does with sessions. |
| D32 | R6 | Security: bearer token on `/alerts` and the WebSocket; Hermes API key; ingress reachable only from the home network (internal DNS); log every turn with its text. Voice-started Hermes tool calls are not restricted in the prototype; the system message tells Hermes to ask for confirmation before any action that changes things. Speaker identification stays a non-goal. | A restricted voice toolset needs Hermes support that is unverified. |
| D33 | R21, R20 | TLS: a real domain, cert-manager with DNS-01, internal DNS. Pod: `replicas: 1`, `strategy: Recreate`, models on a PVC. GPU model and vendor are a Stage 0 fact. | Android tablets may not trust a private CA. |
| D34 | R28 | Process layout: try `speaches` (OpenAI-compatible STT plus Kokoro TTS, unverified) as the GPU container and run Blob's own backend (FastAPI: WebSocket, alerts, Hermes client, SQLite) as a CPU-only container in the same pod. If `speaches` does not fit, run the models inside the Blob backend. Ingress WebSocket timeout raised, ping every 20 s. | Reusing a model server removes the model-serving code. Spike. |
| D35 | R13 | STT language: transcribe once with auto-detect. If the detected language is not `ca`, `es` or `en`, re-run forcing the most probable of the three. Model name is a config value. | One encoder pass in the normal case. |
| D36 | R16 | One mic lock with a 30 s lease, released at the end of a turn. The first device to claim wins. The server sends a 0 to 1 volume level about 20 times a second so mirrors can animate. Built in Stage 3, not before. | Stage 1 and 2 are single-device. |
| D37 | R23 | Each turn gets a `turn_id` and timestamps: wake, end of speech, STT done with language, Hermes first token, first audio out. Logged as one JSON line. `/healthz` reports models loaded, Hermes reachable and GPU present. | A slow turn is then measurable without tablet devtools. |
| D38 | R24 | The WebSocket hello carries a `version`. On mismatch the client reloads. | Keeps a cached PWA from talking to a newer backend. |
| D39 | R27 | Audio is never stored. Transcripts are logged with a 14-day expiry. Hermes may use an external LLM provider; this is the author's existing setup. | The only record is the turn log. |
| D40 | R29, Q12 | A small status icon row (audio locked, mic denied, socket down, Hermes down) fades in on any fault and out after 5 s without one. The offline sphere stays grey. | The tablet is silent and invisible otherwise. |
| D41 | R19, Q5 | Success values (SC1 to SC6): SC1 median end of speech to first audio under 3 s with no tools; SC2 under 1 false wake per day and under 2 misses in 10; SC3 measured, no target; SC4 stable 30 fps for 8 h with the tablet not hot; SC5 alert visible within 1 s; SC6 alerts back within 30 s of a restart. | Starting numbers to adjust after the first measurements. |
| D42 | R22, Q8 | Accept the Catalan TTS gap for the prototype. First Stage 4 item: Piper Catalan as a stopgap, then Matxa. | Matches the author's earlier choice. |
| D43 | Staging | Staging above is accepted. Stage 1 uses four conversation states with a data table so rows can be added. | The 8-state table stays as the target. |
| D44 | Prior art | Standalone build (option C). No dependency on Home Assistant. Home Assistant control goes through Hermes's own Home Assistant integration; Home Assistant can still call `POST /alerts` like any other source. | Author's decision (see Prior Art). |
| D45 | Prior art, R4, R17 | While Hermes runs a tool or takes longer than about 2 s to start answering, Blob speaks one short filler phrase ("un momento") in the reply language. On a Hermes timeout or error it speaks a fixed short fallback line instead of the error text. | Borrowed from hermes-voice. Fills the `thinking` silence. |
| D46 | Prior art, R4 | Stop phrases ("cancela", "déjalo", "never mind"): if the whole utterance matches, end the turn without calling Hermes. A request that only contains the phrase (for example "cancela la reunión") still goes to Hermes. | Borrowed from the Hermes wake-word docs. |
| D47 | Prior art, R23 | Each client has a diagnostics screen reachable by a long press on the blob: version, last turn timings, wake-word score, mic and socket status, with a "copy report" button. | Borrowed from Voice Satellite. The tablet has no devtools. |
| D48 | Prior art, R1, R14 | If the PWA cannot keep the wake word running reliably on the tablet, the fallback is a thin native Android wrapper that runs the same wake-word model, not Home Assistant's Kiosk Satellite (which is tied to Home Assistant). Decide after the Stage 0 tablet spike. | Kiosk Satellite shows that a native wake word on Android is far lighter than in-browser (its own claim, unverified). |
| D49 | Prior art, Q4 | A second wake phrase ("hola blob" or "hi blob") is added later as a second parallel model, not as one multilingual model. | Voice Satellite runs two wake words in parallel (reported). Moved to Stage 4. |
| D50 | Prior art, R25 | Blob owns timers and also a stopwatch if the author wants one: a stopwatch is a running alert with no `fire_at` and an elapsed time shown by blob motion, not text. This reverses the stopwatch part of D22; the author's reason is that Hermes cannot do it. | Author's statement that Hermes will not handle stopwatches. How the elapsed time is shown is open (Q13). |

**Still needed from the author, but not blocking:** the tablet model and OS, the GPU model and vendor, and whether Hermes's LLM runs on the same GPU (Q10). The author's name for the header. These are Stage 0 facts, and the defaults above hold until they are known.

### Open questions (round 1; superseded where a round 2 or 3 decision resolves them; live items are under "Still open" in Current Design)

| ID | Question | Blocks | Reviewer proposed default (not a decision) |
| --- | --- | --- | --- |
| Q1 | How is an alert "attended": voice, touch, both, timeout, or cleared by the source? Does reading it aloud clear it? Do unattended alerts ring forever? | Stage 3 | Touch plus API clear; sources own lifecycle; per-alert TTL; urgent alerts need explicit ack. |
| Q2 | Alert priorities, and what happens when several arrive at once, or one arrives during a conversation turn | Stage 3 | Urgency then arrival time; alerts never interrupt the conversation. |
| Q3 | Conversation memory and session handling with Hermes across turns: per wake, rolling with idle timeout, per device, or global | Stage 1 | Rolling window per household, about 5 min idle expiry. Verify what Hermes supports first. |
| Q4 | Does one wake-word model cover "hola blob" and "hi blob", or two models, or one phrase only? Which engine? | Stage 2 | One phrase first. |
| Q5 | Success criteria values (SC1 to SC6) | Stage 1 | See Goals table. |
| Q6 | Number and list of alert sources, and the shape for each. Who owns timers: Blob, Hermes or Home Assistant? Is the stopwatch an alert? | Stage 3 | Home Assistant as the aggregator. |
| Q7 | Alert store: persistent (SQLite on a PVC) or volatile? | Stage 3 | Persistent, because timers are lost otherwise. |
| Q8 | Accept the Catalan TTS gap for the prototype, or add Piper Catalan as a stopgap? | Stage 1 | User listens to Piper Catalan first. |
| Q9 | Keep "thinking = cycling shapes" given shape = alert source? | Stage 2 | Change thinking to a motion mode. |
| Q10 | Which tablet, OS and kiosk browser? Which GPU model and vendor? Does Hermes's LLM share the GPU? Is there a night schedule or dimming? | Stage 0 | None; facts needed. |
| Q11 | Do audio or transcripts get stored, and for how long? Is a short, opt-in clip log acceptable to build a benchmark from the user's own voice? | Stage 1 | Opt-in, short TTL. |
| Q12 | What does the tablet show before the first touch unlocks audio? | Stage 1 | A discreet "audio locked" cue, not a tap prompt. |
| Q13 | Do you want a stopwatch (D50)? If yes, how does the blob show elapsed time without text (slow ring, colour drift, hourly pulse), or does it only show it on request by voice or tap? | Stage 3 | Show elapsed time only when asked ("cuánto lleva el cronómetro"); the blob shows a calm running state. |

### Staging (round 1, superseded by "Staging" in Current Design)

**Stage 0: Spikes (1 to 2 days, can run in parallel).** Each can reshape the design.

1. Hermes loop: `curl` to `/v1/chat/completions` with the API key. Test system prompt forcing an es/en reply, stream on and off, two consecutive turns, concurrency, what streaming contains during tool use, and how an alert-creating skill could call `/alerts`.
2. Tablet: stub shader + stock wake word + `getUserMedia` over HTTPS for hours. Check persistent mic permission, Wake Lock, audio unlock, behaviour with screen off or dimmed. Then the custom "hola blob" model and false accepts. Localhost is a secure context, so TLS can wait for this spike.
3. STT quality: large-v3 vs large-v3-turbo on the user's Catalan, Spanish and English clips including short commands. Measure language-ID accuracy, silence hallucination, and time for a 3 s utterance.
4. GPU container skeleton: chosen CUDA image, both models loaded, cold start from an empty PVC, real VRAM, GPU resource request, ingress and TLS, `Recreate` rollout.
5. Audio round trip: browser capture, PCM over WebSocket, VAD, STT, Hermes, sentence split, Kokoro, chunked playback. Measure end of speech to first audible word. Test self-trigger with the speaker on.
6. Shader on the tablet: one morph, capped pixel ratio, running for hours. Measure frame time and temperature. Test fresnel-alpha transparency and a procedural environment.

**Stage 1: Voice loop.** Button or tap-to-talk (no wake word). One device. Four conversation states (idle, listening, thinking, speaking). Whole-reply TTS first, with per-stage timing logs; add sentence streaming if latency is bad. Kokoro only, with Catalan mapped to Spanish by one lookup. Model name as config. Exit test: a full spoken turn on desktop with measured timings.

**Stage 2: Wake word and kiosk hardening.** Stock wake word first, then the custom "hola blob". VAD end-of-speech, mute while speaking. Wake Lock, audio unlock cue, TLS ingress with a real certificate. Shader quality tiers. Exit test: tablet runs for 24 hours with a measured false-accept count.

**Stage 3: Alerts.** `POST /alerts` with auth, dedupe, clear and persistence. Conversation and alert layers composed as defined. One Home Assistant automation wired in. Decide Q1, Q2, Q6, Q7 before this stage starts. Exit test: alert visible on all screens after a pod restart.

**Stage 4 (only if wanted).** Multi-device mic lock with lease; more shapes and states; second wake phrase; Catalan TTS behind a per-language router; Hermes alert summary injection.

### Next three actions

1. Run the Hermes `curl` spike and the tablet spike (Stage 0, items 1 and 2).
2. Record Catalan, Spanish and English test clips, including short commands, for the STT benchmark.
3. Decide Q1, Q2, Q6, Q7, Q9 so the alert contract and state composition can be written.
