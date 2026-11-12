# Blob

*   **Author:** Arnau Fauquer (arnau.fauquer@gmail.com)
*   **Status:** Draft
*   **Date:** 2026-11-12

--------------------------------------------------------------------------------

## Overview

Blob is a self-hosted voice assistant that replaces a smart speaker such as an Alexa. Its face is a dark, liquid-metal blob drawn in the browser. The blob is a sphere by default. It changes colour with what the assistant is doing, and it changes shape and colour to show an open alert. It runs on a tablet in the living room and in a desktop browser tab.

Blob is the front end and the glue. Hermes Agent (Nous Research) does the thinking and any Home Assistant work through its own integration. A Python backend on the homelab does speech-to-text and text-to-speech on a GPU, keeps timers and alerts, and talks to Hermes through Hermes's OpenAI-compatible HTTP API.

This draft covers the whole project in four slices: (1) tap-to-talk on the desktop with timings, (2) the tablet as a fullscreen PWA, (3) hands-free wake word, (4) alerts and timers. Slice 1 is specified in full. Slices 2 to 4 depend on two short tests that have not been run (a Hermes API test and a tablet test), so their plans carry marked assumptions.

## The Problem

The author wants a smart speaker that is not Alexa: it should run on their own hardware, answer in Spanish, Catalan or English, use Hermes Agent as its brain, and look like a moving painting on a tablet when idle. No existing project does all of this. Search of prior art on 2026-11-12 found parts of it:

*   Voice Satellite and Kiosk Satellite give a tablet wake word and a voice loop, but only for Home Assistant, and their skins cannot be replaced.
*   Hermes Agent has its own wake word and voice mode, but only in its CLI, terminal UI and desktop app, not in a browser.
*   Several community projects show a voice orb, but they are single-user desktop apps with no alerts and no Hermes link.

Hermes also does not handle everything the author wants from an assistant. Timers and a stopwatch need a clock and a place that holds state, and the author does not want an LLM in that path. Alerts from other systems (Home Assistant, calendar) need a display that stays on until the user attends to them.

The proposed solution is a small standalone service plus one web page. The service holds the speech models and the alert store. The page draws the blob and handles taps. Hermes stays the brain and is reached over HTTP. The service has no dependency on Home Assistant. Home Assistant can still send alerts to it, like any other source.

## Goals

*   **G1.** Replace a smart speaker for a spoken question-and-answer loop with Hermes Agent as the brain. Slice 1 exit: 10 spoken turns (4 Spanish, 3 English, 3 Catalan) each end with spoken audio and `turn_done` reason `ok`.
*   **G2.** Understand Spanish, Catalan and English speech with faster-whisper large-v3 on one GPU. Speak replies in Spanish or English with Kokoro. A Catalan question gets a Spanish reply until a Catalan voice is added.
*   **G3.** Stay within 8 GB of GPU memory for both models. Slice 1 records the peak with `nvidia-smi`.
*   **G4.** Audio leaves a device only after an explicit trigger: a tap, a key, or the wake word. In tap mode the microphone is open only during a turn.
*   **G5.** Show the assistant state as a dark, liquid-metal blob with five conversation states in slice 1 (idle, listening, thinking, speaking, error), and shape-by-source with colour-by-urgency for alerts from slice 4.
*   **G6.** Keep timers and alerts in Blob, not in Hermes. A timer or alert appears within 1 s of the request on connected screens and survives a restart of the service.
*   **G7.** Run as one container on the homelab Kubernetes cluster, on a fullscreen PWA on an Android tablet and in a desktop browser.
*   **G8.** Return to idle after any failure (empty speech, Hermes down, slow Hermes, TTS error), with a spoken fixed line when Hermes fails.
*   **G9.** Measure every turn: last voiced frame, speech-to-text done, Hermes done, first audio out, detected language. Median time from last voiced frame to first audio of the real reply is reported over 20 turns. About 6 s is the loose target for whole-reply mode. 3 s is a later goal after sentence streaming.

## Non-Goals

*   **NG1.** Home Assistant control inside Blob, or Blob as a Home Assistant add-on or card. Hermes handles Home Assistant through its own integration.
*   **NG2.** Catalan speech output in the first slices. Catalan input is supported.
*   **NG3.** Speaker identification or per-person memory.
*   **NG4.** Several devices listening at once. One turn runs at a time, and the wake word runs only on the device named in config.
*   **NG5.** Smart-speaker skills such as music or shopping.
*   **NG6.** A native mobile app.
*   **NG7.** Interrupting the assistant by voice while it speaks. A tap stops playback.
*   **NG8.** Polling a calendar or Home Assistant from Blob. Sources call Blob.
*   **NG9.** Relying on Hermes to push messages to Blob on its own. Hermes can create alerts only by calling Blob's alerts endpoint.
*   **NG10.** A stopwatch in the first four slices.
*   **NG11.** Stop phrases, a spoken filler phrase while Hermes works, droplets in the thinking state, a second wake phrase, and a model-serving sidecar. All are deferred.

## Open Questions

*   **Tablet.** Which tablet, Android version and Chrome version? Can a fullscreen PWA keep the microphone and a wake word running for 2 hours or more over a secure context? This decides slices 2 and 3.
*   **Hermes API.** Does it keep server-side sessions or need history? Does it honour a system message? What does the stream contain during tool use? Can Hermes make an authenticated HTTP call to Blob's alerts endpoint and report a failure? Where does it run and what is its route to Blob?
*   **GPU.** Which GPU model and vendor? Does Hermes's LLM run on an external provider, as assumed? If it runs locally on the same GPU, the 8 GB budget fails.
*   **Speech models on the author's voice.** How accurate are large-v3 and large-v3-turbo on the author's Catalan, Spanish and English clips, including short commands? How often does Catalan get detected as Spanish?
*   **Kokoro details.** Voice names, language codes, sample rate and whether it runs on the GPU in the chosen setup are unconfirmed.
*   **Wake word.** Can a custom "hey blob" model be trained that meets under 1 false accept per day with the TV on? This is not verified.
*   **Capture format.** Does faster-whisper accept browser `MediaRecorder` webm/opus, or does slice 1 need to record PCM?
*   **Hermes tool risk.** Does Hermes support a separate profile or toolset for Blob that excludes locks and shell? If not, the risk is accepted for a home LAN.
*   **Stopwatch.** Does the author want one, and how does the blob show elapsed time without text?
*   **Opt-in clip log** of the author's voice for benchmarks: yes or no, and for how long.
*   **Licences** of vad-web, openWakeWord, Kokoro and any model-serving tool must be checked before shipping. Voice Satellite is AGPL-3.0: read it for ideas, do not copy code.

## Critical User Journeys (CUJs)

### CUJ 1: Ask a question by tap (desktop, slice 1)

*   **Given**: Blob is running on the homelab with Hermes reachable. The browser tab shows an idle blob.
*   **When**: The user taps the blob, says a question in Spanish, and taps again to stop.
*   **Then**: The blob turns to listening while the user speaks, thinking while Hermes answers, and speaking while the reply plays. The reply is spoken in Spanish. The blob returns to idle. The turn log has one JSON line with the timings and the detected language.

### CUJ 2: Ask a question in Catalan

*   **Given**: Same as CUJ 1.
*   **When**: The user asks in Catalan.
*   **Then**: The text is transcribed, the detected language is logged as `ca`, and Hermes is asked to reply in Spanish or English. The reply is spoken with a Spanish voice.

### CUJ 3: Ask hands-free on the tablet (slice 3)

*   **Given**: The tablet shows the fullscreen PWA, audio is unlocked, and the wake word runs on this device.
*   **When**: The user says "hey blob" and a question.
*   **Then**: The blob flashes, listens, ends listening after the user stops talking, and the turn continues as in CUJ 1. Nothing was sent to the server before the wake word.

### CUJ 3b: Hermes asks a question back (slice 3)

*   **Given**: Hands-free mode is on and Hermes needs a confirmation.
*   **When**: The reply ends with a question, such as "¿Apago las luces del salón?".
*   **Then**: After the reply finishes, the microphone opens for 6 s without the wake word. The user answers "sí" and the turn continues. If the user says nothing, the blob returns to idle.

### CUJ 4: A voice timer finishes (slice 4)

*   **Given**: Blob and Hermes are running.
*   **When**: The user says "pon un temporizador de 10 minutos". Ten minutes later the timer fires.
*   **Then**: Hermes (or Blob's local timer rule) creates a timer alert. When it fires, the blob changes to the timer shape in an urgent colour and stays that way. A tap reads the alert aloud and clears it.

### CUJ 5: An external alert arrives while idle (slice 4)

*   **Given**: A source such as Hermes or a Home Assistant automation holds the alert token.
*   **When**: It posts an alert with `source=homeassistant` and `urgency=urgent`.
*   **Then**: Every connected screen shows the alert shape and colour within 1 s. If a conversation turn is running, the alert is held until the turn ends. After a restart of the service, the alert is still there.

### CUJ 6: Hermes is down

*   **Given**: Hermes does not answer.
*   **When**: The user finishes a question.
*   **Then**: After the timeout, the blob goes grey for about 3 s, speaks a fixed fallback line, and returns to idle. No error text is spoken.

## Technical Plan (Architecture)

### Parts and who owns what

Blob has two deployable parts and one external dependency.

*   **Backend** (one Python process, FastAPI). Owns the conversation state, the current turn, the alert list, the timers, the speech models, the Hermes client and the SQLite file. It serves the page, a WebSocket at `/ws`, an alerts API at `/alerts`, and `/healthz`.
*   **Page** (one static web app, TypeScript, built with Vite, three.js for the fullscreen shader). Owns the microphone, audio playback, tap handling and drawing. It holds no durable state. It redraws from the last `snapshot` it received.
*   **Hermes Agent** (external). Reached over HTTP at its OpenAI-compatible endpoint. Blob never assumes Hermes can push to it.

```text
   Tablet / desktop tab                      Homelab pod                     Hermes host
 +------------------------+  WebSocket  +-----------------------------+  HTTP  +-------------+
 | mic (PCM) | taps       |<----------->| FastAPI                     |------->| /v1/chat/   |
 | AudioContext playback  |   binary    |  - turn lock, state machine |        | completions |
 | three.js blob shader   |   audio     |  - STT  (faster-whisper)    |<-------|             |
 +------------------------+             |  - TTS  (Kokoro)            |        +-------------+
                                        |  - alerts + timers (SQLite) |              |
   Hermes tool / Home Assistant /       |  - one asyncio GPU lock     |              | optional:
   other sources  --POST /alerts------->|                             |<-------------+ POST /alerts
                                        +-----------------------------+
```

### Conversation state machine

The backend owns `conv_state` and sends it to every client in `snapshot` and `state` messages.

| State | Entered when | Leaves when |
| --- | --- | --- |
| `idle` | startup, or `turn_done` | a client sends `tap` or (slice 3) a wake event and no turn is running |
| `listening` | the backend accepts a turn start | the client sends `utterance`, or `cancel`, or the 15 s client cap fires, or the 90 s turn timeout fires |
| `thinking` | the utterance arrives | the reply audio is ready, or an error, a `cancel` or a timeout happens |
| `speaking` | the first audio frame is sent | playback ends on the client, or the user taps |
| `error` | the turn ends with a reason other than `ok`, `empty`, `cancel` | after about 3 s |

The client keeps `speaking` on screen until its own playback queue is empty. The backend sends `turn_done` after it has sent the last audio frame.

A second `tap` while a turn is running does not start another turn. The backend answers `busy` to a second `turn_start`. A turn is released on `turn_done`, on WebSocket close, or after 90 s.

### Turn pipeline (backend)

1.  `tap` in `idle` creates a `turn_id`, takes the turn lock, sets `listening`.
2.  The client opens the microphone, records 16 kHz mono signed 16-bit PCM from one AudioWorklet, and on the second tap (or the 15 s cap) stops the microphone tracks and sends `utterance` followed by one binary frame with the audio. Audio is not streamed.
3.  The backend runs speech-to-text under the GPU lock: language auto-detect, one pass, the server-side voice filter on, and an empty-text drop. It records the detected language and the no-speech probability. An empty result ends the turn with `empty` and zero Hermes calls.
4.  The backend builds the Hermes request: one merged system message, the history (see below), and the user text.
5.  Hermes is called with `stream: false` in slice 1. Timeouts (config values): connect 5 s, no bytes 30 s, total 120 s. On a failure the backend aborts the request, speaks the pre-rendered fallback line for the detected language, and ends the turn with `hermes_fail` or `timeout`.
6.  The reply text is cleaned (markdown, emoji and URLs removed), the voice is chosen with `voice_for(lang)`, and Kokoro synthesises the whole reply under the GPU lock into one WAV.
7.  The backend sends `tts{turn, seq, final}` and one binary frame, then `turn_done{turn, reason, timings}`.
8.  (Slice 3) If the cleaned reply text ends with `?`, the `tts` message carries `followup: true`. When the device that started the turn finishes playback, it sends `wake{followup: true}`. The backend starts a new turn in `listening` with a 6 s no-speech limit and no wake word. If no speech starts in 6 s, the turn ends with `empty` and the state returns to `idle`. A follow-up turn whose own reply ends with `?` can open another, up to `followup_max` in a row (config, default 3, a guard against loops).

`voice_for(lang)` is one dictionary: `ca` maps to a Spanish voice, `es` to a Spanish voice, `en` to an English voice, and anything else to `es`. Replacing the `ca` entry later adds Catalan speech with no other change.

The model calls sit behind two functions that nothing else knows the internals of: `stt(audio, lang=None)` returns `{text, lang, no_speech_prob}`, and `tts(text, lang)` returns audio. A model-serving sidecar can replace both later.

Pre-rendered audio (the fallback line, one per language, and a short beep file for the client) is made at startup. Startup also runs one dummy transcription and one dummy synthesis so the first real turn is not cold.

### Hermes client and history

*   Endpoint, API key and model name are environment variables.
*   One merged system message asks for short spoken sentences, no markdown, a reply in Spanish or English (a Catalan question gets a Spanish reply), and a question before any action that changes something.
*   History: if the Hermes test shows that a session ID or server-side history works, Blob sends only the new message and the session ID. If not, Blob keeps the last 6 completed user and assistant pairs and drops them after 5 minutes without a turn. Filler lines, fallback lines, cancelled turns and errored turns never enter history.
*   Assumption to verify: Hermes honours the system message and returns plain text. The same test checks whether Hermes can call Blob's `/alerts` endpoint with a token and report a failure.

### Alerts and timers (slice 4)

One table `alerts` in SQLite:

| Field | Meaning |
| --- | --- |
| `key` | text, unique, the dedupe key chosen by the source |
| `source` | text, such as `timer`, `calendar`, `homeassistant`, or any other value |
| `urgency` | `info` or `urgent` |
| `text` | up to 300 characters |
| `lang` | default `es` |
| `state` | `pending`, `active` or `acked` |
| `fire_at` | UTC epoch seconds, set for timers |
| `ttl_s` | optional, counts from activation |
| `created_at`, `activated_at`, `acked_at` | UTC epoch seconds |

Endpoints (all need the bearer token `ALERT_TOKEN`):

*   `POST /alerts` upserts by `key`. Required: `key`, `source`, `text`. `urgency` defaults to `info`, except `source=timer`, which defaults to `urgent`. `fire_at` is epoch or RFC3339 with an offset; a time without an offset gets HTTP 422. `in_s` is accepted and the backend computes `fire_at` from its own clock. A POST to an `acked` key with unchanged `text` and `urgency` is ignored; a changed payload sets it back to `active`. Limits: 20 active alerts.
*   `DELETE /alerts/{key}` is idempotent.
*   `GET /alerts` lists alerts so a source (such as Hermes) can find and cancel a timer.

A scheduler is one asyncio task that reads the table once a second and moves `pending` rows with `fire_at` in the past to `active`. On startup, overdue timers fire once and are marked late, unless `ttl_s` has also passed. Rows are deleted when the source calls `DELETE`, when `ttl_s` expires, or 24 h after `acked_at`.

If Hermes cannot create timers through `/alerts`, a rule in the backend runs before Hermes on the transcript (words such as "temporizador", "timer", "temporitzador", plus a number of minutes) and creates the timer directly. This is a fallback of about 20 lines and is built only if the Hermes test fails.

A tap on an alert reads the alert text aloud with `voice_for(lang)` and clears it after playback ends. If audio is locked or synthesis fails, the alert is not cleared.

### Display rules

The client, not the backend, computes what to draw: `view = conversation turn active ? conversation state : top alert`. Precedence is offline, then conversation turn, then top alert, then idle. The top alert is `urgent` before `info`, then oldest first. An alert that arrives during a turn is broadcast but held hidden until the turn ends. Alerts do not make sound during a turn. A chime that came due during a turn plays at turn end if the alert is still open. Config `quiet_hours` mutes chimes.

Two data tables in the page, not in code branches:

*   Conversation state to colour and motion: `idle` deep blue/violet with slow breathing, `listening` cyan deforming with the microphone level, `thinking` amber with slow breathing, `speaking` warm white pulsing with playback level, `error` dim grey.
*   Alert source and urgency to shape, colour and pulse speed. Slice 4 starts with two shapes (for example triangle for `timer`, square for everything else). `info` is green or blue and `urgent` is red or magenta and pulses about twice as fast. A morph between two shapes uses `mix(sdfA, sdfB, t)` with the march step shortened to about 0.7.

The shader is one fullscreen quad. Transparency is a fresnel term over a procedural dark environment, tinted per state. There is no refraction pass. Tablet cost controls: render at 0.75 scale, exit early outside a bounding sphere, cap idle at 30 fps, handle `webglcontextlost`.

### WebSocket protocol

Text messages are JSON. Audio is binary, sent right after the JSON header that announces it.

| Direction | Message | Content |
| --- | --- | --- |
| client to server | `hello` | `version`, `token`, `device`, `sound` |
| client to server | `tap` | none |
| client to server | `utterance` | `turn`, `format: pcm_s16le`, `rate: 16000`, then one binary frame |
| client to server | `cancel` | `turn` |
| client to server | `ping` | none |
| client to server | `client_event` | fault or timing events, written to the turn log |
| server to client | `snapshot` | `conv_state`, `alerts[]`; sent on every connect and every change |
| server to client | `state` | `conv`, `turn` |
| client to server | `wake` | slice 3: `followup` (boolean, default false). Starts a turn the same way as `tap`, with a 6 s no-speech limit when `followup` is true |
| client to server | `alert_read` | slice 4: `key`. The server answers with a `tts` message carrying `alert: key` and `final: true`, then one binary frame |
| client to server | `alert_ack` | slice 4: `key`. Sets the alert to `acked` |
| server to client | `tts` | `turn` (or `alert`), `seq`, `final`, `followup` (slice 3), then one binary frame |
| server to client | `turn_done` | `turn`, `reason` (`ok`, `empty`, `stt_fail`, `hermes_fail`, `timeout`, `cancel`), `timings` |
| server to client | `error` | `code` (for example `busy`, `4401` auth) |

On a wrong token the server closes with code 4401 and the client does not retry. Other disconnects reconnect with a backoff from 1 s to 30 s. Because the client redraws from the latest `snapshot`, a tablet that reconnects cannot keep a stale alert.

Audio playback uses one `AudioContext`. Chunks are scheduled at `nextT = max(now, nextT) + duration`. A new turn, a cancel or a tap stops all sources and resets `nextT`. Chunks from a stale turn are dropped. Slice 1 sends one WAV per reply and decodes it with `decodeAudioData`.

### Sound targets

Alert sound goes to every client with `sound=true`, a per-device setting kept in the server file `config/devices.json` and read by the page from `GET /device-config` (tablet on, desktop off). During a turn, audio goes to the client that started it. While audio is locked, the page shows a permanent "audio locked" cue, and a tap in that state only unlocks audio and clears nothing. The page calls `resume()` on the one `AudioContext` on every tap.

### Taps

The first matching row wins.

| State | A tap does |
| --- | --- |
| an alert is showing (and audio is unlocked) | reads the alert aloud, then clears it after playback ends |
| `speaking` | stops playback and sends `cancel` |
| `thinking` | sends `cancel`, which aborts the Hermes request |
| `listening` | stops the microphone and sends the audio |
| `idle`, no alert | starts a turn |

To talk while an alert is open, tap once to clear it, then tap again. A long press opens the diagnostics page. In slice 3, the wake word always starts a turn.

### Hands-free (slice 3, with unverified assumptions)

*   One `getUserMedia` stream and one AudioWorklet feed two consumers: the wake-word detector and the voice-activity detector. The wake detector runs only while the local state is `idle`. The voice-activity detector runs only while listening. Playback mutes the wake detector, plus a 0.5 s hangover.
*   The detector is an openWakeWord model in a Web Worker using ONNX Runtime Web with one thread. The phrase is "hey blob". A custom model must be trained. A stock phrase such as "hey jarvis" is used first to test the pipeline. Whether openWakeWord runs reliably in a browser worker on the author's tablet is the main unverified assumption of this slice.
*   End of speech is 0.6 to 0.8 s of silence from a Silero voice-activity detector (`@ricky0123/vad-web`). Listening stops after 8 s with no speech and after 15 s in total.
*   The wake detector runs only on the device marked `wake=true` in `config/devices.json`. The desktop tab is tap-only.
*   Follow-up listening: when a reply ends with `?`, the device that started the turn opens the microphone for 6 s after playback ends, without the wake word, so the user can answer a question from Hermes (for example a confirmation). The wake detector stays muted during it. It happens once per reply, at most `followup_max` times in a row. It needs the voice-activity detector and the shared stream, so it belongs to this slice. A reply that ends with `?` but is rhetorical opens the microphone for 6 s for nothing; the 6 s limit bounds that cost.
*   If the wake word cannot run on the tablet for 2 hours, the fallback order is tap or hardware button only, then a plain WebView shell with no wake logic, then a switch to a Home Assistant display layer.

### Tablet and deployment (slice 2)

*   **Page:** a PWA manifest with `display: fullscreen`. No service worker at first (check once on the tablet whether Chrome needs one for fullscreen). `index.html` is served with `Cache-Control: no-cache`. Assets have hashed names. The page re-acquires the Wake Lock when it becomes visible again. After a reboot, the first tap unlocks audio (known limit). On a version mismatch in `hello`, the page reloads at most once per server version, stored in `localStorage`; a second mismatch shows the fault cue and stops.
*   **Secure context:** `getUserMedia`, Wake Lock and PWA install need one. `localhost` on the tablet is the tablet, not the server. The first tablet test uses either `adb reverse` (unverified) or a certificate made with `mkcert`. The deployed setup uses a real domain, cert-manager and internal DNS.
*   **Container:** one image built on a CUDA base image that matches the pinned CTranslate2 and cuDNN versions. Models are stored on a PVC, not in the image. The pod has `replicas: 1` and `strategy: Recreate` because one GPU can serve one pod. The pod requests one GPU (assumes an NVIDIA GPU and the NVIDIA device plugin; the vendor is not yet confirmed).
*   **Ingress:** routes the whole host to the pod with a prefix rule, so `/alerts`, `/healthz` and `/device-config` are also reachable from the home network. `/alerts` is protected only by `ALERT_TOKEN` (author's choice; a second internal listener and exact ingress paths were the alternatives). Sources can also use the in-cluster Service. WebSocket idle timeouts are raised and the client pings every 20 s.
*   **Tokens:** `ALERT_TOKEN` for sources and `DEVICE_TOKEN` for browsers. A browser installs its token once by opening `https://host/#t=TOKEN`. The page stores it in `localStorage` and removes the hash. The PWA `start_url` carries no secret.
*   **Startup:** the HTTP server, the database and the scheduler start first. Models load in a background task. `/healthz` reports alive at once and ready after the models and a Hermes check. A tap while the models are loading shows a grey blob.

### Data, privacy and logs

*   SQLite lives on block or local storage, not NFS, in default journal mode, with one writer. It holds the `alerts` table and a `turns` table with the turn id, time, detected language, user text, reply text, reason and timings.
*   Rows in `turns` older than 14 days are deleted at startup and every 24 h. Audio is never stored. Alerts can be re-created by their sources. There is no backup.
*   Standard output carries timings only. Text goes to the `turns` table.
*   Hermes keeps its own memory outside Blob's 14 days, and may forward text to an external model provider. This is the author's existing setup.
*   Audio leaves a device only after a tap, a key or the wake word. In tap mode the microphone tracks stop after each turn. The server drops audio unless a turn is open.

### Configuration

Environment variables: Hermes URL, key and model name; STT model name and compute type; Kokoro voice names; `voice_for` map overrides; timeouts (Hermes connect, no bytes and total; turn 90 s; client cap 15 s); `ALERT_TOKEN`; `DEVICE_TOKEN`; `quiet_hours`; database path; per-device `sound` and `wake` flags in a small config file served to the page.

### Assumptions the plan depends on

1.  Hermes's `/v1/chat/completions` returns plain text for a non-streaming call and honours a system message. (Hermes test, about 1 h.)
2.  Hermes can call `POST /alerts` with a bearer token and report a failure. If not, the transcript rule is built.
3.  A fullscreen PWA on the author's Android tablet can keep a microphone and a wake word running for 2 hours or more. (Tablet test, a few hours.)
4.  Large-v3 with `int8_float16` plus Kokoro fit in 8 GB with the Hermes LLM on an external provider. (Slice 1 measures this.)
5.  Kokoro runs on the GPU in the chosen setup and exposes the voices and language codes needed. (Slice 1 confirms.)
6.  Raw PCM from an AudioWorklet is accepted by the speech model without a decoder. (It is plain samples, so this is expected to hold.)
7.  A custom "hey blob" model can reach under 1 false accept per day. (Slice 3 measures this.)

## Alternatives Considered

Source: the "Alternatives Weighed" section and the Prior Art section of `docs/designs/blob.md`, plus the decisions made in review rounds 1 and 2. Where the author asked for a simple default and accepted a recommendation, the entry says so. Deferred items are not rejections.

### Alternative A: Blob as a display layer on Home Assistant

*   **What it is**: Install Voice Satellite (or Kiosk Satellite on the tablet) and a community Hermes conversation agent. Build only a Home Assistant custom card with the three.js blob, reading satellite state, timers and alert entities.
*   **Pros**: Removes the wake word, voice-activity detection, model serving, turn lock, alerts API, SQLite and TLS work. Voice Satellite already runs a wake word in the browser and has a native Android app for the tablet.
*   **Cons**: Needs Home Assistant. Voice Satellite skins accept only CSS overrides, and hiding its overlay is unverified. The blob cannot follow microphone volume unless a level is exposed. Hermes integrations are community projects of unknown maturity and some need very recent Home Assistant versions.
*   **Reason for Rejection**: Rejected by author: Blob must be a general assistant and not tied to Home Assistant. Hermes handles Home Assistant through its own integration. The plan keeps this as the fallback if the tablet or wake-word test fails (see the switch conditions in `docs/designs/blob.md`).

### Alternative B: Fork Voice Satellite and add a Blob skin

*   **Pros**: Gets the whole engine (wake word, timers, announcements) and a skin system.
*   **Cons**: Voice Satellite is AGPL-3.0, 846 commits, and its author does not take pull requests, so the fork owns every merge. It is tied to Home Assistant.
*   **Reason for Rejection**: Rejected by author: the same reason as Alternative A, and a large maintenance burden for a visual change.

### Alternative C: Use Hermes's own voice mode

*   **Pros**: Already has a wake word, faster-whisper, sentence-by-sentence speech, barge-in and stop phrases.
*   **Cons**: The wake word runs only in the CLI, the terminal UI and the desktop app, not in a browser. The documentation lists only English wake-word models. No blob, and no documented push channel to clients.
*   **Reason for Rejection**: Rejected by author: does not give a browser or tablet client with the blob and alerts.

### Alternative D: XTTS-v2 for speech output

*   **Pros**: Multilingual, with streaming and voice cloning.
*   **Cons**: Has no Catalan.
*   **Reason for Rejection**: Rejected by author: no Catalan, and the author's languages include Catalan.

### Alternative E: Piper for all three languages, or Piper for Catalan only

*   **Pros**: One lightweight engine that can run on the CPU. Catalan voices exist (reviewer memory, unverified).
*   **Cons**: Lower voice quality than Kokoro for Spanish and English. Piper's original repository was archived and development moved to a fork under a different licence (unverified). Voice licences are per voice.
*   **Reason for Rejection**: Not chosen for the first slices by the author, who prefers better voice quality. Deferred: Piper Catalan is the first stopgap when Catalan speech is added, before Matxa.

### Alternative F: Matxa + alVoCat for Catalan speech now

*   **Pros**: Built for Catalan, with several accents. About 1 GB per the author's figure.
*   **Cons**: Catalan only, so a second engine next to Kokoro. The 1 GB may be disk size, not GPU memory (unverified).
*   **Reason for Rejection**: Rejected by author for the first prototype to keep it simpler. Catalan input is still supported. Revisit after slice 4.

### Alternative G: Whisper large-v3-turbo, or a Catalan fine-tune, as the main speech model

*   **Pros**: Turbo is faster and smaller. A Catalan fine-tune reports 6 to 12% word error on Catalan sets.
*   **Cons**: Turbo may be less accurate on Catalan (reviewer memory, not measured). A Catalan fine-tune may do worse on Spanish and English, and the exact model names are unverified.
*   **Reason for Rejection**: Not rejected. Large-v3 is the default because it fits the 8 GB budget and no Catalan comparison exists. The model name is a config value, and slice 1 measures large-v3 against turbo on the author's clips.

### Alternative H: Wake word on the server, or with Porcupine

*   **Pros**: A server-side detector would not depend on a browser worker. Porcupine is a packaged engine.
*   **Cons**: Audio would leave the device before the wake word fires. Porcupine needs an access key, has a non-commercial free tier, and its Catalan support is unverified. openWakeWord's pretrained models carry a non-commercial licence (unverified).
*   **Reason for Rejection**: Rejected by author: audio must leave the device only after an explicit trigger. The engine is still chosen in slice 3 after the tablet test, and tap or button mode is the fallback.

### Alternative I: Route alerts through Hermes

*   **Pros**: Hermes would know about every alert and could answer questions about it.
*   **Cons**: Adds LLM latency and cost to a timer, and fails when Hermes is down. A language model has no reliable clock for an absolute time.
*   **Reason for Rejection**: Rejected by author: alerts must work without an LLM in the path. Sources call `POST /alerts` directly. Later, Blob can add one line about open alerts to the Hermes system message.

### Alternative J: Blob polls the calendar or Home Assistant

*   **Pros**: No dependency on the sources to push.
*   **Cons**: Duplicates what Home Assistant and Hermes already do. Blob would need credentials for every system.
*   **Reason for Rejection**: Rejected by author: sources call Blob. Hermes handles Home Assistant.

### Alternative K: Vertex displacement on an icosphere for the blob

*   **Pros**: Cheaper than raymarching.
*   **Cons**: Cannot make straight edges, so a cube or triangle would look rounded.
*   **Reason for Rejection**: Rejected by author: the shapes must read as shapes.

### Alternative L: Smooth-min to morph between shapes

*   **Pros**: One operator for both morphs and merging.
*   **Cons**: Smooth-min is a union. Sphere and cube merge into a larger bulge instead of turning into a cube.
*   **Reason for Rejection**: Rejected by author (accepted recommendation): morphs use `mix(sdfA, sdfB, t)`. Smooth-min returns only if droplets are added to the thinking state later.

### Alternative M: True refraction for the glass look

*   **Pros**: More convincing transparency.
*   **Cons**: A second march per pixel, which is expensive on a tablet.
*   **Reason for Rejection**: Rejected by author (accepted recommendation): fresnel over a procedural environment. Revisit if the result looks flat on the tablet.

### Alternative N: A mic lock lease with a heartbeat, and a level stream to mirrors

*   **Pros**: Handles several devices that hear the wake word at the same time. Mirrors could animate to the real microphone level.
*   **Cons**: A 30 s lease is shorter than a long turn. The server has no microphone audio until the utterance ends, so it cannot compute a level. It is distributed-systems work for one household.
*   **Reason for Rejection**: Rejected by author (accepted recommendation): one `current_turn` on the server, wake word on one device only, and a synthetic envelope on mirrors. The lease returns if two wake-word devices are needed.

### Alternative O: A native Android wrapper that runs the wake word

*   **Pros**: Native wake-word capture is lighter than in-browser. It keeps the microphone with the screen off.
*   **Cons**: Needs a second runtime, native capture, a foreground service and a bridge to the page. It contradicts the non-goal of a native app.
*   **Reason for Rejection**: Rejected by author (accepted recommendation): the fallback order is tap or button mode, a plain WebView shell, then a Home Assistant display layer.

### Alternative P: Stream microphone audio with `MediaRecorder` webm/opus

*   **Pros**: Smaller uploads. Less client code at first.
*   **Cons**: Whether faster-whisper decodes browser webm/opus is unverified. The wake word and the voice-activity detector need raw samples anyway.
*   **Reason for Rejection**: Rejected by author: one AudioWorklet that records 16 kHz PCM, sent whole when recording ends.

### Alternative Q: Sentence streaming from the first slice, and a spoken filler phrase

*   **Pros**: Speech starts before Hermes finishes. A filler phrase covers silence while Hermes works.
*   **Cons**: A splitter and ordered playback are real code before the latency is measured. A filler phrase triggers on most turns if Hermes takes about 3.5 s, and the stream content during tool use is unverified.
*   **Reason for Rejection**: Deferred by author (accepted recommendation): slice 1 uses a whole reply. Streaming comes after slice 1's timings. A first-sentence flush (about 10 lines) is the first step.

### Alternative R: A model-serving sidecar (speaches) in slice 1

*   **Pros**: Removes model-serving code.
*   **Cons**: Its API may not return language probabilities or let models stay loaded, and it makes two containers in one pod. Unverified.
*   **Reason for Rejection**: Deferred by author (accepted recommendation): the models load in the backend behind `stt` and `tts` functions, so a sidecar can replace them later.

### Alternative S: Alerts as small satellite blobs, and an attention envelope

*   **Pros**: Show several alerts at once while a conversation runs. The envelope (strong start, calm hold, re-escalation for urgent alerts) avoids a screen that shouts all day.
*   **Cons**: Readability across a room is unproven, and both ideas add visual work before alerts exist.
*   **Reason for Rejection**: Deferred by author (accepted recommendation): one alert is drawn at a time, `urgent` before `info`, and a tap clears it.

--------------------------------------------------------------------------------

## Non-Functional Requirements

*   **Security and privacy.**
    *   Two bearer tokens: `ALERT_TOKEN` for sources and `DEVICE_TOKEN` for browsers. Tokens are Kubernetes secrets, never in the image or the repository.
    *   The ingress routes the whole host, so `/alerts` is reachable from the home network and is protected only by `ALERT_TOKEN`. A leaked token lets anyone on the network create or delete alerts. Sources can use the in-cluster Service. The Hermes API key is a secret. Everything runs on the home network and the ingress must not be exposed outside it.
    *   Anyone in earshot of the tablet can start a turn once the wake word is on. Hermes tools reached by voice are limited only by a system-message line, unless Hermes offers a separate profile or toolset for Blob. This risk is accepted for a home LAN and must be revisited if locks or similar are reachable through Hermes.
    *   Audio is never stored. Turn text is kept 14 days in SQLite.
*   **Performance and latency.**
    *   Both models together stay under 8 GB of GPU memory. Slice 1 records the peak.
    *   SC1: the median from the last voiced frame to the first audio of the real reply is reported over 20 turns. About 6 s is the loose target in whole-reply mode. 3 s is a later goal.
    *   SC4: about 30 fps on the tablet for 8 h with no throttling visible in frame time.
    *   SC5: an alert is visible on connected clients within 1 s.
*   **Rollout and rollback.**
    *   `replicas: 1` with `Recreate` means each deploy has downtime while the old pod releases the GPU. This is accepted.
    *   Rollback is deploying the previous image tag. The SQLite schema carries a version in `PRAGMA user_version`. A new version adds columns or tables only, so an older image still starts.
    *   SC6: after a restart the HTTP server, database and scheduler start first and `/healthz` reports alive at once. It reports ready when the models are loaded.

## Additional Resources

*   `docs/designs/blob.md`: the concepts brief and RFC this design comes from, with the review history. `review_round2.md` has the second review.
*   Hermes Agent API server: <https://hermes-agent.nousresearch.com/docs/user-guide/features/api-server>
*   Hermes voice mode and wake word (not used, studied): <https://github.com/nousresearch/hermes-agent/blob/main/website/docs/user-guide/features/voice-mode.md>, <https://hermes-agent.nousresearch.com/docs/user-guide/features/wake-word>
*   Voice Satellite (ideas only, AGPL-3.0, do not copy code): <https://github.com/jxlarrea/voice-satellite-card-integration>
*   hermes-voice (session and filler-phrase ideas): <https://github.com/majorminorlabs/hermes-voice>
*   Shader references: <https://github.com/PSCactux/webgl-shader-lab>, <https://github.com/douglasgoodwin/shader-playground>, <https://tympanus.net/codrops/2024/07/15/how-to-create-a-liquid-raymarching-scene-using-three-js-shading-language/>
*   Catalan speech: <https://huggingface.co/zuazo/whisper-large-v3-ca>, <https://huggingface.co/projecte-aina/whisper-large-v3-ca-3catparla>, <https://huggingface.co/projecte-aina/matxa-tts-cat-multiaccent/raw/87cd1f602cc8f2f87bdfb258d81b127e92f51aac/README.md>

### Future Improvements

*   **Sentence streaming.** Flush the first sentence at the first `.`, `!` or `?` followed by whitespace, send the rest as one chunk, then add a real splitter and ordered playback.
*   **Filler phrase.** A short spoken line if Hermes has not started answering after about 4 s, language taken from the speech model, cancelled by the first token, never stored in history.
*   **Catalan speech.** Piper Catalan as a stopgap behind `voice_for("ca")`, then Matxa + alVoCat.
*   **Thinking droplets.** Small droplets orbiting the sphere, using smooth-min, once the `mix()` morph works.
*   **Stopwatch.** A separate `kind=stopwatch` with a `started_at`, kept out of the alert list and answered by speech on request.
*   **Second wake phrase** ("hola blob") as a second parallel model.
*   **Voice acknowledgement** of alerts, and alert text injected into the Hermes system message so Hermes can answer questions about open alerts.
*   **Chime and quiet hours** for urgent alerts, repeated every 2 minutes.
*   **Multi-device mic lock** with a lease, a heartbeat and arbitration, if two wake-word devices are needed.
*   **Model-serving sidecar** (for example speaches) behind the `stt` and `tts` functions.
*   **Satellite blobs** for several simultaneous alerts, and the attention envelope.

--------------------------------------------------------------------------------

## Detailed Implementation Plan

All paths are relative to the repository root (`/home/arnau/workspace/meet_blob`). Slice tags: **S0** kill-spikes, **S1** tap-to-talk on the desktop, **S2** tablet and deployment, **S3** hands-free, **S4** alerts and timers. Package versions are pinned at first install, not named here. Choices made for the layout: `uv` for Python, Vite and TypeScript for the page, `pytest` and `vitest` for tests, plain YAML for Kubernetes manifests (author's choice).

### Build order

Files are numbered for reference, not for build order. Build each slice in this order:

1.  **S0:** Hermes test and tablet stub page (files 1 to 3). Kill rule: if the wake word cannot run on the tablet for 2 hours, S3 becomes tap or button mode.
2.  **S1:** every file tagged S1. Order: repository files, backend skeleton (`config`, `schemas`, `main` with `/healthz` and a logging `/ws`), `stt` and `stt_cli`, `hermes` and its tests, `tts` and `tts_cli`, `turn` and `hub`, the page, error paths, the exit test.
3.  **S2:** every file tagged S2 (container, manifests, PWA, tokens, tablet hardening).
4.  **S3:** every file tagged S3 (voice-activity detection and the wake word).
5.  **S4:** every file tagged S4 (alerts, scheduler, timer rule, shapes).

### Target Files to Create/Modify

#### Repository and docs

##### 1. `docs/spikes/hermes-test.md` (Create, S0)

*   **Type / Scope**: Written record of the Hermes test.
*   **Proposed Changes**: The date, the Hermes version, and answers to: server-side sessions or history? system message honoured? plain text for `stream: false`? what appears in the stream during a tool call? can Hermes call `POST /alerts` with a bearer token and report a failure? where does Hermes run and what is its route to the Blob pod? Records which of D57's two branches applies (Hermes tool or the transcript rule).

##### 2. `docs/spikes/tablet-test.md` (Create, S0)

*   **Type / Scope**: Written record of the tablet test.
*   **Proposed Changes**: Tablet model, Android and Chrome versions, how the secure context was achieved (`adb reverse` or `mkcert`), hours the stub ran, wake-word drops, microphone-permission behaviour after a restart, Wake Lock behaviour, frame rate. States the kill-rule outcome for S3.

##### 3. `web/spikes/tablet-stub/index.html` and `web/spikes/tablet-stub/stub.ts` (Create, S0)

*   **Type / Scope**: Throwaway test page, deleted after S0.
*   **Proposed Changes**: A page with `getUserMedia`, a stock wake word ("hey jarvis") in a worker, a simple animated canvas, a visible counter of detections and drops, and a Wake Lock request. Logs to the screen because the tablet has no devtools.

##### 4. `README.md` (Create, S1; Modify in each later slice)

*   **Type / Scope**: Project readme.
*   **Proposed Changes**: What Blob is, how to run the backend and the page on the desktop, the environment variables, how to run the tests, how to read the turn log. Later slices add the deploy steps and the tablet install steps.

##### 5. `.gitignore` (Create, S1)

*   **Type / Scope**: Git ignore rules.
*   **Proposed Changes**: Python caches, virtual environments, `node_modules`, `web/dist`, `.env`, the SQLite file, downloaded models, and `tests/clips/` (personal voice recordings are not committed).

##### 6. `.env.example` (Create, S1)

*   **Type / Scope**: Config template.
*   **Proposed Changes**: Every environment variable from the Configuration section with a safe example value and a one-line comment. Real values go in `.env`, which is ignored.

##### 7. `.github/workflows/ci.yml` (Create, S1)

*   **Type / Scope**: GitHub Actions workflow.
*   **Proposed Changes**: On push and pull request: set up `uv`, run `ruff check`, `ruff format --check`, `mypy` and `pytest -m "not gpu"` in `backend/`; set up Node, run `npm ci`, `npm run lint`, `npm run typecheck`, `npm test` and `npm run build` in `web/`. GPU tests are skipped in CI.

##### 8. `docs/testing/exit-tests.md` (Create, S1; Modify in S2 to S4)

*   **Type / Scope**: Step-by-step exit tests for each slice.
*   **Proposed Changes**: The S1 test from the Technical Plan with the clip list (4 Spanish, 3 English, 3 Catalan, including short commands), how to read the median time with `timings_report.py`, and the `nvidia-smi` command for peak memory. S2 to S4 add their exit tests as each slice starts.

##### 9. `docs/runbook.md` (Create, S2)

*   **Type / Scope**: Operations notes.
*   **Proposed Changes**: Deploy and roll back, create the secrets, install a token on a tablet with `https://host/#t=TOKEN`, read logs, what `/healthz` states mean, what to do when the tablet shows the "audio locked" cue, how to rotate a token.

#### Backend (`backend/`)

##### 10. `backend/pyproject.toml` and `backend/uv.lock` (Create, S1)

*   **Type / Scope**: Python project and lock file.
*   **Proposed Changes**: Python 3.11 or newer. Runtime dependencies: FastAPI, uvicorn with websockets, httpx, pydantic and pydantic-settings, numpy, faster-whisper, the Kokoro inference package and a WAV writer (exact package confirmed in the TTS step). Development: pytest, pytest-asyncio, ruff, mypy. A `gpu` pytest marker. Entry point `blob = blob.main:run`.

##### 11. `backend/blob/__init__.py` (Create, S1)

*   **Type / Scope**: Package marker with `__version__`, which is the value sent in `hello`.
*   **Proposed Changes**: One version string, bumped when the WebSocket protocol changes.

##### 12. `backend/blob/config.py` (Create, S1; Modify in S2, S4)

*   **Type / Scope**: Settings.
*   **Proposed Changes**: A settings class that reads the environment variables in the Configuration section and validates them at startup. S2 adds the tokens and the static directory. S4 adds `quiet_hours`.

##### 13. `backend/blob/schemas.py` (Create, S1; Modify in S4)

*   **Type / Scope**: Message and payload models.
*   **Proposed Changes**: Pydantic models for every WebSocket message in the protocol table, the `turn_done` reasons as an enum, and the conversation states as an enum. S4 adds the alert payload and the alert row models with the validation rules (required fields, RFC3339 with offset, `in_s`, 300-character limit).

##### 14. `backend/blob/textclean.py` (Create, S1)

*   **Type / Scope**: Text helpers.
*   **Proposed Changes**: `clean_for_speech(text)` removes markdown markers, emoji and URLs and collapses whitespace. `first_sentence_split(text)` returns the first sentence and the rest, used later for streaming (written and tested in S1, unused until then).

##### 15. `backend/blob/voices.py` (Create, S1)

*   **Type / Scope**: Language to voice map and fallback lines.
*   **Proposed Changes**: `voice_for(lang)` implements the dictionary (`ca`, `es`, `en`, anything else is `es`), with overrides from config. A small table of the fixed fallback line per language (`es`, `en`; Catalan uses the Spanish line).

##### 16. `backend/blob/gpu.py` (Create, S1)

*   **Type / Scope**: GPU lock.
*   **Proposed Changes**: One `asyncio.Lock` and `run_gpu(fn, *args)` that takes the lock and runs `fn` in a worker thread so the event loop stays free. All speech-model calls go through it.

##### 17. `backend/blob/stt.py` (Create, S1)

*   **Type / Scope**: Speech to text.
*   **Proposed Changes**: Load the model named in config with the configured compute type. `stt(audio, lang=None)` takes 16 kHz mono float samples (converted from the PCM bytes), runs one pass with language auto-detect and the voice filter on, and returns `{text, lang, no_speech_prob}`. An empty text or a no-speech probability above a config threshold returns an empty text. `warmup()` transcribes one second of silence at startup.

##### 18. `backend/blob/tts.py` (Create, S1)

*   **Type / Scope**: Text to speech.
*   **Proposed Changes**: Load Kokoro. `tts(text, lang)` picks the voice with `voice_for`, synthesises the whole text and returns WAV bytes. `prerender_fallbacks()` renders the fallback line for each language once and keeps the bytes in memory. `warmup()` synthesises one short phrase.

##### 19. `backend/blob/hermes.py` (Create, S1)

*   **Type / Scope**: Hermes client and history.
*   **Proposed Changes**: `ask(user_text, lang)` builds the message list (the merged system message, the history or the session ID, the user text), posts to `/v1/chat/completions` with `stream: false` and the three timeouts, and returns the reply text or raises a typed error (`hermes_fail` or `timeout`). A history object keeps the last 6 completed pairs and drops them after 5 minutes without a turn; the session-ID mode replaces it if the S0 test allows. Nothing from failed, cancelled or fallback turns is stored.

##### 20. `backend/blob/db.py` (Create, S1; Modify in S4)

*   **Type / Scope**: SQLite access.
*   **Proposed Changes**: Open the database file in default journal mode with one writer, create the `turns` table, set `PRAGMA user_version`, and expose `insert_turn(...)` and `delete_turns_older_than(days)`. Calls run in a thread. S4 adds the `alerts` table and its data-access functions.

##### 21. `backend/blob/turnlog.py` (Create, S1)

*   **Type / Scope**: Per-turn logging.
*   **Proposed Changes**: At turn end, print one JSON line with the timings and reason (no text) to standard output, and insert the full row into `turns`. Also records `client_event` messages.

##### 22. `backend/blob/turn.py` (Create, S1; Modify in S3, S4)

*   **Type / Scope**: Turn manager and pipeline.
*   **Proposed Changes**: Holds `current_turn` and the conversation state. `start(device)` returns `busy` if a turn is open. `submit_utterance(turn, pcm)` runs the pipeline in the Technical Plan: speech to text, empty check, Hermes, clean, text to speech, send audio, `turn_done`. `cancel(turn)` aborts the Hermes request and the pipeline. A 90 s watchdog ends a stuck turn. Every exit path sends `turn_done` with a reason and records timings. S3 adds the wake-start entry point and the follow-up turn (6 s no-speech limit, `followup_max`). S4 adds the pre-Hermes timer rule and a hold on alert display while a turn is open (the hold itself is client-side).

##### 23. `backend/blob/hub.py` (Create, S1; Modify in S2, S4)

*   **Type / Scope**: WebSocket hub.
*   **Proposed Changes**: Tracks connected clients, handles `hello`, validates version and token (token check added in S2), dispatches `tap`, `utterance`, `cancel`, `ping` and `client_event`, sends `snapshot` on connect and on every change, and sends `state`, `tts` and `turn_done`. Pairs the JSON header of `utterance` with the binary frame that follows it. S4 includes the alert list in the snapshot.

##### 24. `backend/blob/main.py` (Create, S1; Modify in S2, S4)

*   **Type / Scope**: Application entry.
*   **Proposed Changes**: Builds the FastAPI app. Startup order: open the database and mark the app alive; load the models, run the warm-ups and render the fallbacks in a background task; set ready. Routes: `/healthz` (alive and ready fields, models loaded, Hermes check from S2), `/ws`, and the built page as static files with `Cache-Control: no-cache` on `index.html` (S2). A daily task deletes old turns. S4 mounts the alerts router and starts the scheduler.

##### 25. `backend/blob/auth.py` (Create, S2)

*   **Type / Scope**: Token checks.
*   **Proposed Changes**: A function that compares a presented token with `DEVICE_TOKEN` in constant time, used by the hub (close code 4401 on failure), and a FastAPI dependency that checks `Authorization: Bearer` against `ALERT_TOKEN` for the alerts routes.

##### 26. `backend/blob/devices.py` (Create, S2)

*   **Type / Scope**: Per-device flags.
*   **Proposed Changes**: Reads `config/devices.json` and serves `GET /device-config?device=<name>` returning that device's `sound` and `wake` flags. Unknown devices get `sound=false` and `wake=false`.

##### 27. `config/devices.example.json` (Create, S2)

*   **Type / Scope**: Example device list.
*   **Proposed Changes**: Two entries, `tablet` with `sound=true, wake=true` and `desktop` with `sound=false, wake=false`.

##### 28. `backend/blob/alerts.py` (Create, S4)

*   **Type / Scope**: Alerts API and scheduler.
*   **Proposed Changes**: The router for `POST /alerts`, `DELETE /alerts/{key}` and `GET /alerts` with the rules in the Technical Plan, the cap of 20, and the ignore rule for an unchanged `acked` payload. The scheduler task polls once a second and activates due timers. The startup routine fires overdue timers once, marked late. Every change broadcasts a new `snapshot`.

##### 29. `backend/blob/timer_rule.py` (Create, S4, conditional)

*   **Type / Scope**: Fallback timer parser.
*   **Proposed Changes**: Built only if the S0 test shows Hermes cannot create timers. A function that matches "temporizador", "timer", "temporitzador" and a number of minutes or seconds in the transcript, and returns a request to create a timer alert. It runs before Hermes in `turn.py`.

##### 30. `backend/scripts/stt_cli.py` (Create, S1)

*   **Type / Scope**: Command-line tool.
*   **Proposed Changes**: Reads a WAV file, prints the text, the detected language, the no-speech probability and the time. Used on a real clip, an empty file and a silence file.

##### 31. `backend/scripts/tts_cli.py` (Create, S1)

*   **Type / Scope**: Command-line tool.
*   **Proposed Changes**: Takes text and a language, writes a WAV, prints the voice used and the time. Confirms Kokoro's voices, language codes and sample rate.

##### 32. `backend/scripts/e2e_turn.py` (Create, S1)

*   **Type / Scope**: Scripted client.
*   **Proposed Changes**: Connects to `/ws`, sends `hello`, `tap`, then `utterance` with a WAV file, and prints each message until `turn_done`. Used for repeatable turns without a browser. Also supports `--cancel-after` to test cancel.

##### 33. `backend/scripts/timings_report.py` (Create, S1)

*   **Type / Scope**: Report tool.
*   **Proposed Changes**: Reads the `turns` table and prints the median and the 90th percentile of last-voiced-frame-to-first-audio, plus counts by reason and by detected language. Computes SC1.

##### 34. `backend/tests/fakes/fake_hermes.py` (Create, S1)

*   **Type / Scope**: Test double.
*   **Proposed Changes**: A small HTTP app that mimics `/v1/chat/completions` with switches for a normal reply, a delayed reply, an error status, no bytes, and a reply with markdown, emoji and a URL.

##### 35. `backend/tests/test_textclean.py`, `backend/tests/test_voices.py` (Create, S1)

*   **Type / Scope**: Unit tests.
*   **Proposed Changes**: Markdown, emoji, URL and whitespace cases for `clean_for_speech`; decimals, abbreviations and Spanish `¿¡` for `first_sentence_split`; the `voice_for` map including unknown languages and overrides.

##### 36. `backend/tests/test_hermes.py` (Create, S1)

*   **Type / Scope**: Unit tests against the fake Hermes.
*   **Proposed Changes**: Message list contents, history cap of 6 pairs, expiry after 5 minutes (clock injected), no storage of failed turns, each timeout producing the right error, an error status producing `hermes_fail`.

##### 37. `backend/tests/test_turn.py` (Create, S1; Modify in S4)

*   **Type / Scope**: Pipeline tests with `stt` and `tts` replaced by stubs.
*   **Proposed Changes**: Happy path ends with `ok`. Empty speech ends with `empty` and zero Hermes calls. Hermes failure ends with `hermes_fail` and plays the fallback. A second `turn_start` gets `busy`. `cancel` in each state ends the turn. The 90 s watchdog (clock injected). WebSocket close frees the lock. S4 adds the timer rule and a timer request path.

##### 38. `backend/tests/test_hub.py` (Create, S1; Modify in S2, S4)

*   **Type / Scope**: Protocol tests with a test WebSocket client.
*   **Proposed Changes**: `snapshot` on connect, version mismatch, message ordering of `tts` header and binary frame, `busy`, ping. S2 adds the wrong token closing with 4401 and no reconnect. S4 adds alerts in the snapshot.

##### 39. `backend/tests/test_db.py` (Create, S1; Modify in S4)

*   **Type / Scope**: Storage tests on a temporary file.
*   **Proposed Changes**: Schema creation and `user_version`, turn insert, deletion of rows older than 14 days. S4 adds the alert table behaviours.

##### 40. `backend/tests/test_speech_gpu.py` (Create, S1)

*   **Type / Scope**: GPU smoke tests, marked `gpu`.
*   **Proposed Changes**: Loads both models, transcribes a short fixture, synthesises a short phrase, and checks the outputs are non-empty. Skipped in CI.

##### 41. `backend/tests/test_auth.py` (Create, S2)

*   **Type / Scope**: Unit tests.
*   **Proposed Changes**: Correct and wrong device and alert tokens; missing header; constant-time compare function used.

##### 42. `backend/tests/test_alerts_api.py` (Create, S4)

*   **Type / Scope**: API tests.
*   **Proposed Changes**: Upsert, required fields, defaults (including `source=timer` being `urgent`), 422 for a time without an offset, `in_s`, the cap of 20, the `acked` ignore and re-raise rules, idempotent `DELETE`, `GET`, bad token.

##### 43. `backend/tests/test_scheduler.py` (Create, S4)

*   **Type / Scope**: Scheduler tests with an injected clock.
*   **Proposed Changes**: A pending timer activates at `fire_at`. Overdue timers on startup fire once and are marked late, except when `ttl_s` has passed. Rows are removed after `ttl_s` and 24 h after ack. A restart keeps open alerts.

##### 44. `backend/tests/test_timer_rule.py` (Create, S4, conditional)

*   **Type / Scope**: Unit tests.
*   **Proposed Changes**: Spanish, Catalan and English phrases with minutes and seconds; phrases that must not match.

#### Page (`web/`)

##### 45. `web/package.json`, `web/package-lock.json`, `web/tsconfig.json`, `web/vite.config.ts` (Create, S1; Modify in S2, S3)

*   **Type / Scope**: Frontend project and build.
*   **Proposed Changes**: Scripts `dev`, `build`, `lint`, `typecheck`, `test`. Dependencies: three.js. Dev: Vite, TypeScript, vitest, eslint. The dev server proxies `/ws` to the backend. S2 adds the PWA manifest handling. S3 adds `onnxruntime-web` and `@ricky0123/vad-web`, and the worker bundling settings.

##### 46. `web/index.html` (Create, S1; Modify in S2)

*   **Type / Scope**: Page shell.
*   **Proposed Changes**: A full-window canvas, a small fault-line element, a diagnostics overlay container, a black background. S2 adds the manifest link and the theme colour.

##### 47. `web/src/main.ts` (Create, S1; Modify in S2 to S4)

*   **Type / Scope**: Page entry.
*   **Proposed Changes**: Wires the parts: reads the config and token, opens the WebSocket, creates the renderer, the audio, and the tap handler, and ties `snapshot` to the view computation. S2 adds Wake Lock and the version reload guard. S3 adds the wake detector. S4 adds alert tables.

##### 48. `web/src/config.ts` (Create, S1)

*   **Type / Scope**: Page settings.
*   **Proposed Changes**: Device name and flags (`sound`, `wake`) loaded from `/device-config` in S2 (a static default in S1), and the recording cap (15 s).

##### 49. `web/src/ws.ts` (Create, S1; Modify in S2)

*   **Type / Scope**: WebSocket client.
*   **Proposed Changes**: Connect, send `hello`, send the typed client messages, parse server messages and pair a `tts` header with its binary frame. Reconnect with a backoff of 1 to 30 s, 20 s pings, no retry on close code 4401. S2 adds the token.

##### 50. `web/src/state.ts` (Create, S1; Modify in S4)

*   **Type / Scope**: Client state and view.
*   **Proposed Changes**: Holds the last `snapshot`. `computeView(snapshot, localPlayback)` implements the precedence: offline, then conversation turn (with `speaking` kept until local playback ends), then the top alert, then idle. S4 adds the sort by urgency and age and the hold while a turn is open.

##### 51. `web/src/taps.ts` (Create, S1; Modify in S4)

*   **Type / Scope**: Gesture handling.
*   **Proposed Changes**: Implements the tap table (first matching row wins) and the long press. S4 adds the alert row (read aloud, clear after playback ends, do nothing while audio is locked).

##### 52. `web/src/audio/capture.ts` and `web/src/audio/worklet/capture-processor.ts` (Create, S1; Modify in S3)

*   **Type / Scope**: Microphone capture.
*   **Proposed Changes**: Open `getUserMedia` only for a turn, resample to 16 kHz mono in the worklet, collect signed 16-bit samples, stop the tracks when finished, enforce the 15 s cap, and expose a level for the listening deformation through an `AnalyserNode`. S3 changes it to a single always-open stream shared with the wake detector and the voice-activity detector (when the device has `wake=true`).

##### 53. `web/src/audio/playback.ts` (Create, S1; Modify in S2)

*   **Type / Scope**: Audio playback.
*   **Proposed Changes**: One `AudioContext`. `play(wavBytes, turn)` decodes and schedules with `nextT = max(now, nextT) + duration`. `stopAll()` and stale-turn dropping. An `AnalyserNode` on the output for the speaking pulse. The local fallback beep. S2 adds the audio-locked state and `resume()` on every tap.

##### 54. `web/src/render/blob.ts` (Create, S1; Modify in S2, S4)

*   **Type / Scope**: Renderer.
*   **Proposed Changes**: A three.js scene with one fullscreen quad and a shader material. Uniforms: time, resolution, colour, motion parameters, mic or playback level, brightness, and the shape morph (shape A, shape B, mix). S2 adds the 0.75 render scale, the 30 fps idle cap and `webglcontextlost` recovery. S4 adds the shape morph.

##### 55. `web/src/render/blob.frag` and `web/src/render/blob.vert` (Create, S1; Modify in S4)

*   **Type / Scope**: Shaders.
*   **Proposed Changes**: Raymarched signed distance field with a bounding-sphere early exit, procedural dark environment, fresnel rim, and the metal look. S1 draws a sphere with breathing and level-driven deformation. S4 adds the triangle and square distance functions and `mix(sdfA, sdfB, t)` with the shortened march step.

##### 56. `web/src/render/tables.ts` (Create, S1; Modify in S4)

*   **Type / Scope**: Data tables.
*   **Proposed Changes**: Conversation state to colour and motion (five rows). S4 adds alert source and urgency to shape, colour and pulse speed, with the default entry for unknown sources.

##### 57. `web/src/diag.ts` (Create, S1)

*   **Type / Scope**: Diagnostics view.
*   **Proposed Changes**: A long press shows the page version, the socket and microphone status, the last turn timings, and a button that copies a text report. S3 adds the wake-word score.

##### 58. `web/public/beep.wav` (Create, S1)

*   **Type / Scope**: Static audio file.
*   **Proposed Changes**: A short beep played locally when speech output fails.

##### 59. `web/src/state.test.ts`, `web/src/taps.test.ts` (Create, S1; Modify in S4)

*   **Type / Scope**: Unit tests (vitest).
*   **Proposed Changes**: Every row of the view precedence and the tap table, including the alert rows from S4 and the audio-locked case.

##### 60. `web/src/audio/playback.test.ts`, `web/src/ws.test.ts` (Create, S1)

*   **Type / Scope**: Unit tests.
*   **Proposed Changes**: The `nextT` schedule, stale-turn dropping, stop on cancel; header and binary pairing, reconnect backoff, no retry on 4401.

#### Container and deployment (S2)

##### 61. `Dockerfile` and `.dockerignore` (Create, S2)

*   **Type / Scope**: Container image.
*   **Proposed Changes**: Multi-stage build. Stage one builds the page with Node. Stage two uses a CUDA base image matching the pinned CTranslate2 and cuDNN versions, installs the backend with `uv`, copies `web/dist`, runs as a non-root user, and starts `blob`. Models are not copied in; the cache path points at the PVC mount.

##### 62. `deploy/pvc.yaml` (Create, S2)

*   **Type / Scope**: Kubernetes manifest.
*   **Proposed Changes**: A PVC for model files and the SQLite file, with the storage class left for the author to set. SQLite must not land on NFS.

##### 63. `deploy/deployment.yaml` (Create, S2)

*   **Type / Scope**: Kubernetes manifest.
*   **Proposed Changes**: `replicas: 1`, `strategy: Recreate`, one container with a GPU request (assumes NVIDIA and its device plugin), the PVC mounts, environment from the config map and secret, a readiness probe on `/healthz` ready, and a liveness probe on alive.

##### 64. `deploy/service.yaml` (Create, S2)

*   **Type / Scope**: Kubernetes manifest.
*   **Proposed Changes**: A cluster-internal Service. Sources reach `/alerts` through it.

##### 65. `deploy/ingress.yaml` (Create, S2)

*   **Type / Scope**: Kubernetes manifest.
*   **Proposed Changes**: Routes the internal host with a `/` prefix rule (so `/alerts` is reachable and protected by `ALERT_TOKEN`), with raised WebSocket timeouts and TLS from the certificate.

##### 66. `deploy/certificate.yaml` (Create, S2)

*   **Type / Scope**: cert-manager resource.
*   **Proposed Changes**: A Certificate for the host using an existing DNS-01 issuer (the issuer name is a placeholder the author sets).

##### 67. `deploy/configmap.yaml` and `deploy/secret.example.yaml` (Create, S2)

*   **Type / Scope**: Kubernetes manifests.
*   **Proposed Changes**: Non-secret settings (model names, timeouts, voices, `quiet_hours`, the device file) in the config map. The example secret lists `ALERT_TOKEN`, `DEVICE_TOKEN` and the Hermes key with empty values. The real secret is created by hand and not committed.

##### 68. `deploy/README.md` (Create, S2)

*   **Type / Scope**: Deploy notes.
*   **Proposed Changes**: The order of `kubectl apply -f` commands, the placeholders to fill, and the check commands.

##### 69. `web/public/manifest.webmanifest` and `web/public/icons/` (Create, S2)

*   **Type / Scope**: PWA assets.
*   **Proposed Changes**: Name, `display: fullscreen`, `start_url: /` with no secret in it, theme and background colour (black), and 192 and 512 pixel icons. No service worker at first.

##### 70. `web/src/token.ts` (Create, S2)

*   **Type / Scope**: Token handling.
*   **Proposed Changes**: Reads `#t=TOKEN` once, stores it in `localStorage`, removes the hash with `history.replaceState`, and returns the stored token for `hello`.

##### 71. `web/src/wakelock.ts` (Create, S2)

*   **Type / Scope**: Wake Lock.
*   **Proposed Changes**: Requests the lock and requests it again on `visibilitychange` when the page becomes visible.

##### 72. `web/src/version.ts` (Create, S2)

*   **Type / Scope**: Version guard.
*   **Proposed Changes**: On a `hello` version mismatch, reload at most once per server version, remembered in `localStorage`; a second mismatch shows the fault cue and stops.

##### 73. `web/src/fault.ts` (Create, S2; Modify in S3)

*   **Type / Scope**: Fault line.
*   **Proposed Changes**: One dim text line naming the current fault (audio locked, microphone denied, socket down, Hermes down). "Audio locked" stays on until audio is unlocked. S3 adds wake-word faults.

##### 74. `web/src/render/blob.ts` quality tiers (Modify, S2)

*   **Type / Scope**: Renderer settings.
*   **Proposed Changes**: Named quality tiers (render scale, step count) chosen by measured frame time, and the 30 fps idle cap. Records the frame time to `client_event` once a minute.

##### 75. `docs/testing/exit-tests.md` S2 section (Modify, S2)

*   **Type / Scope**: Test steps.
*   **Proposed Changes**: Tablet exit test: 8 h at about 30 fps, tap turns working, reconnect after a pod restart, first tap after reboot unlocks audio.

#### Hands-free (S3)

##### 76. `web/src/vad.ts` (Create, S3)

*   **Type / Scope**: End-of-speech detection.
*   **Proposed Changes**: Wraps `@ricky0123/vad-web`, preloaded paused, runs only while listening. Silence of 0.6 to 0.8 s ends the utterance. 8 s with no speech or 15 s in total cancels it. A follow-up turn uses a 6 s no-speech limit.

##### 77. `web/src/wake/detector.ts` and `web/src/wake/worker.ts` (Create, S3)

*   **Type / Scope**: Wake-word detector.
*   **Proposed Changes**: An openWakeWord pipeline in a Web Worker using ONNX Runtime Web with one thread. It receives audio from the shared worklet and posts detections with a score. It runs only while the local state is `idle`, and not during playback plus 0.5 s.

##### 78. `web/public/models/` (Create, S3)

*   **Type / Scope**: Model files.
*   **Proposed Changes**: The stock phrase model for pipeline tests, then the custom "hey blob" model. Licences of each file are recorded next to it. A `README.md` in this folder records how the custom model was trained.

##### 79. `docs/wake-word-training.md` (Create, S3)

*   **Type / Scope**: Training recipe.
*   **Proposed Changes**: Data used, the training steps, thresholds chosen, and the false-accept measurements. The recipe is versioned with the model file.

##### 80. `backend/blob/turn.py` wake entry (Modify, S3)

*   **Type / Scope**: Turn manager.
*   **Proposed Changes**: A `wake` message from the device with `wake=true` starts a turn the same way as `tap`. `wake{followup: true}` starts a follow-up turn with a 6 s no-speech limit, and `tts.followup` is set when the cleaned reply ends with `?`. `schemas.py` and `hub.py` handle the new message and field, and `config.py` gains `followup_max` and `followup_listen_s`. `backend/tests/test_turn.py` gains cases for: reply ending with `?`, a follow-up with no speech ending as `empty`, and the `followup_max` guard.

##### 81. `docs/testing/exit-tests.md` S3 section (Modify, S3)

*   **Type / Scope**: Test steps.
*   **Proposed Changes**: A follow-up check: a Hermes reply that ends with a question opens the microphone for 6 s without the wake word, and silence for 6 s returns to idle. Several days with the TV on and counts of false accepts and misses (fewer than 2 misses in 10 attempts). A replay of recorded TV or radio audio through the detector faster than real time if the detector allows it.

#### Alerts and timers (S4)

##### 82. `docs/testing/exit-tests.md` S4 section (Modify, S4)

*   **Type / Scope**: Test steps.
*   **Proposed Changes**: An alert is visible after a pod restart. A voice timer works end to end. A Home Assistant (or `curl`) call produces the expected shape within 1 s.

##### 83. `web/src/render/tables.ts` alert table and `web/src/render/blob.frag` shapes (Modify, S4)

*   **Type / Scope**: Shape and colour mapping.
*   **Proposed Changes**: Triangle for `timer`, square for all other sources to start. Urgency colours as approved. Urgent pulse about twice as fast.

##### 84. `web/src/taps.ts` alert rows (Modify, S4)

*   **Type / Scope**: Gesture handling.
*   **Proposed Changes**: A tap on an alert asks the backend to synthesise the alert text with `voice_for(lang)`, plays it, and sends a clear once playback ends.

##### 85. `backend/blob/hub.py` clear and read messages (Modify, S4)

*   **Type / Scope**: WebSocket hub.
*   **Proposed Changes**: Two new client messages: `alert_read{key}`, which returns the synthesised audio, and `alert_ack{key}`, which sets the alert to `acked`. Both are added to the protocol table in the schemas.

##### 86. `docs/alerts.md` (Create, S4)

*   **Type / Scope**: Source integration guide.
*   **Proposed Changes**: The `POST /alerts` contract, a `curl` example, a Home Assistant `rest_command` example, and the note on how to give Hermes a tool that calls it.

##### 87. `docs/runbook.md` alerts section (Modify, S4)

*   **Type / Scope**: Operations notes.
*   **Proposed Changes**: How to list and delete alerts by hand, and how restart behaviour treats timers.

### Verification Plan

*   **Compilation/Build**: Backend: `uv sync` then `uv run python -c "import blob"`. Page: `npm ci` and `npm run build` in `web/`. Container (S2): `docker build .`.
*   **Unit Tests**: `uv run pytest -m "not gpu"` in `backend/`; `npm test` in `web/`.
*   **GPU tests (local only)**: `uv run pytest -m gpu` on the machine with the GPU.
*   **Static Analysis & Linting**: `uv run ruff check`, `uv run ruff format --check`, `uv run mypy blob`; `npm run lint` and `npm run typecheck`.
*   **Test Coverage Requirement**: At least 80% line coverage for `textclean.py`, `voices.py`, `hermes.py`, `turn.py`, `hub.py`, `db.py`, `auth.py`, `alerts.py` and `timer_rule.py`. Model wrappers (`stt.py`, `tts.py`) and the shader are excluded from the percentage and covered by the GPU smoke test and the manual exit tests.
*   **E2E/Integration**: `backend/scripts/e2e_turn.py` against the real backend with the fake Hermes for repeatable turns, and against the real Hermes for the S1 exit test. S1 exit test (all on the desktop with the GPU): 10 spoken turns across Spanish, English and Catalan end with spoken audio and `turn_done` reason `ok`; a tap on silence returns to idle with no Hermes request in the log; a wrong Hermes key or a stopped Hermes gives a grey blob, the spoken fallback line and idle within the timeout; a tap during speaking stops audio; a tap during thinking cancels and the next turn works; history is used within 5 minutes and not after 5 minutes idle (or Hermes holds the session); the blob visibly changes in all five states; `nvidia-smi` peak memory is recorded and is under 8 GB; the SC1 median is logged by `timings_report.py`.
*   **Later slice exit tests**: S2 on the tablet for 8 h at about 30 fps with tap turns working; S3 with several days of false-accept counts; S4 with an alert surviving a restart and a voice timer working.

--------------------------------------------------------------------------------

<!-- Provenance: Indicates initial structural drafting via EGM. -->

*Drafted with EGM*
