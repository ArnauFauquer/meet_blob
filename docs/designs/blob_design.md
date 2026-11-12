# Blob

*   **Author:** Arnau Fauquer (arnau.fauquer@gmail.com)
*   **Status:** Draft
*   **Date:** 2026-11-12

--------------------------------------------------------------------------------

## Overview

Blob is a self-hosted voice assistant that replaces a smart speaker such as an Alexa. Its face is a dark, liquid-metal blob drawn in the browser. The blob is a sphere by default. It changes colour with what the assistant is doing, and it changes shape and colour to show an open alert. It runs on a tablet in the living room and in a desktop browser tab.

Blob is the front end and the glue. Hermes Agent (Nous Research) does the thinking and any Home Assistant work through its own integration. A Python backend on the homelab does speech-to-text and text-to-speech on a GPU, keeps timers and alerts, and talks to Hermes through Hermes's OpenAI-compatible HTTP API.

This draft covers the whole project in four slices: (1) tap-to-talk on the desktop with timings, (2) the tablet as a fullscreen PWA, (3) hands-free wake word, (4) alerts and timers. Slice 1 is specified in full. Slices 2 to 4 depend on two short tests that have not been run, the Hermes test and the tablet test (the S0 spikes in the implementation plan), so their plans carry marked assumptions.

Slice index: S1 covers the turn pipeline, state machine, taps and display; S2 the tablet and deployment; S3 hands-free and follow-up listening; S4 alerts, timers and shapes.

## The Problem

The author wants a smart speaker that is not Alexa: it should run on their own hardware, answer in Spanish, Catalan or English, use Hermes Agent as its brain, and look like a moving painting on a tablet when idle. No project found in the prior-art search of 2026-11-12 did all of this. The search found parts of it:

*   [Voice Satellite](https://github.com/jxlarrea/voice-satellite-card-integration) and [Kiosk Satellite](https://newreleases.io/project/github/jxlarrea/kiosk-satellite/release/2026.9.87) give a tablet wake word and a voice loop, but only for Home Assistant. The developer said in a community thread that skins accept only the exposed settings and CSS overrides.
*   [Hermes Agent](https://hermes-agent.nousresearch.com/docs/user-guide/features/voice-mode) has its own voice mode (also in Telegram and Discord). Its [wake word](https://hermes-agent.nousresearch.com/docs/user-guide/features/wake-word) runs only in the CLI, the terminal UI and the desktop app, not in a browser.
*   Several community projects show a voice orb. The ones found were single-user desktop apps. Their alert and Hermes support was not checked. [hermes-voice](https://github.com/majorminorlabs/hermes-voice) connects Hermes to Home Assistant Assist.

Hermes may also not be the right place for timers: it has no reliable clock, and the author does not want an LLM in that path. This is untested (Assumption 2). A timer needs a clock and a place that holds state. Alerts from other systems (Home Assistant, calendar) need a display that stays on until the user attends to them.

The proposed solution is a small standalone service plus one web page. The service holds the speech models and the alert store. The page draws the blob and handles taps. Hermes stays the brain and is reached over HTTP. The service has no dependency on Home Assistant. Home Assistant can still send alerts to it, like any other source.

## Goals

*   **G1.** Replace a smart speaker for a spoken question-and-answer loop with Hermes Agent as the brain. Slice 1 exit: 10 spoken turns (4 Spanish, 3 English, 3 Catalan) each end with spoken audio and `turn_done` reason `ok`.
*   **G2.** Transcribe Spanish, Catalan and English speech with faster-whisper large-v3 on one GPU; accuracy is measured on the author's clips, with no target. Speak replies in Spanish or English with Kokoro. A Catalan question gets a Spanish reply until a Catalan voice is added.
*   **G3.** Stay within 8 GB of GPU memory for both models. Slice 1 records the peak with `nvidia-smi`.
*   **G4.** Audio leaves a device only after an explicit trigger (a tap, a hardware button that sends a tap, or the wake word) or during the 6 s follow-up window after a reply that ends with a question. In tap mode the microphone is open only during a turn.
*   **G5.** Show the assistant state as a dark, liquid-metal blob with five conversation states in slice 1 (idle, listening, thinking, speaking, error), and shape-by-source with colour-by-urgency for alerts from slice 4.
*   **G6.** Keep timers and alerts in Blob, not in Hermes. An alert appears on connected screens within 1 s of the POST. A timer appears within 1 s of its `fire_at`. Both survive a restart of the service.
*   **G7.** Run as one container on the homelab Kubernetes cluster, on a fullscreen PWA on an Android tablet and in a desktop browser.
*   **G8.** Return to idle after any failure (empty speech, Hermes down, slow Hermes, TTS error), with a spoken fixed line when Hermes fails.
*   **G9.** Measure every turn: last voiced frame, speech-to-text done, Hermes done, first audio out, detected language. Median time from last voiced frame to first audio of the real reply is reported over 20 turns. About 6 s is the loose target for whole-reply mode. 3 s is a later goal after sentence streaming.

## Non-Goals

*   **NG1.** Home Assistant control inside Blob, or Blob as a Home Assistant add-on or card. Hermes handles Home Assistant through its own integration.
*   **NG2.** Catalan speech output in this design. Catalan input is supported.
*   **NG3.** Speaker identification or per-person memory.
*   **NG4.** Several devices listening at once. One turn runs at a time, and the wake word runs only on the device named in config.
*   **NG5.** Smart-speaker skills such as music or shopping.
*   **NG6.** A native mobile app.
*   **NG7.** Interrupting the assistant by voice while it speaks. A tap stops playback.
*   **NG8.** Polling a calendar or Home Assistant from Blob. Sources call Blob.
*   **NG9.** Relying on Hermes to push messages to Blob on its own. Hermes can create alerts only by calling Blob's alerts endpoint.
*   **NG10.** A stopwatch in this design.
*   **NG11.** Stop phrases, a spoken filler phrase while Hermes works, droplets in the thinking state, a second wake phrase, and a model-serving sidecar. All are deferred.

## Open Questions

Each item names the test or slice that answers it.

*   **Tablet.** Which tablet, Android version and Chrome version? Can a fullscreen PWA keep the microphone and a wake word running for 2 hours or more over a secure context? This decides slices 2 and 3. `[S0 tablet test]`
*   **Hermes API.** Does the `X-Hermes-Session-Id` header keep a server-side session? Does Hermes honour a system message? What does the stream contain during tool use? Does a client disconnect stop a Hermes run (if not, Hermes's `/v1/runs` endpoint, which documents cancellation, is the alternative)? Can Hermes make an authenticated HTTP call to Blob's alerts endpoint and report a failure? Where does it run and what is its route to Blob (it binds to `127.0.0.1:8642` by default, so the pod needs `API_SERVER_HOST` and a network path)? `[S0 Hermes test]`
*   **GPU.** Which GPU model and vendor? Does Hermes's LLM run on an external provider, as assumed? If it runs locally on the same GPU, the 8 GB budget fails. `[S1]`
*   **Speech models on the author's voice.** How accurate are large-v3 and large-v3-turbo on the author's Catalan, Spanish and English clips, including short commands? How often does Catalan get detected as Spanish? `[S1]`
*   **Kokoro details.** Voice names, language codes, sample rate and whether it runs on the GPU in the chosen setup are unconfirmed. `[S1]`
*   **Wake word.** Can a custom "hey blob" model be trained that meets under 1 false accept per day with the TV on? This is not verified. `[S3]`
*   **Hermes tool risk.** Does Hermes support a separate profile or toolset for Blob that excludes locks and shell? If not, the risk is accepted for a home LAN. `[S0 Hermes test]`
*   **Stopwatch.** Does the author want one, and how does the blob show elapsed time without text? Not in this design. `[later]`
*   **Night mode.** Should the blob dim on a schedule (brightness, frame rate) to limit heat and screen wear? `[S2]`
*   **Opt-in clip log** of the author's voice for benchmarks: yes or no, and for how long. `[S1]`
*   **Licences** of vad-web, openWakeWord, Kokoro and any model-serving tool must be checked before shipping. Voice Satellite is AGPL-3.0: read it for ideas, do not copy code. `[before shipping]`

## Critical User Journeys (CUJs)

### CUJ 1: Ask a question by tap (desktop, slice 1)

*   **Given**: Blob is running on the homelab with Hermes reachable. The browser tab shows an idle blob.
*   **When**: The user taps the blob, says a question in Spanish, and taps again to stop.
*   **Then**: The blob turns to listening while the user speaks, thinking while Hermes answers, and speaking while the reply plays. The reply is spoken in Spanish. The blob returns to idle. The timing line has one JSON object with the timings and the detected language.

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
*   **Then**: Hermes (or Blob's local timer rule) creates a timer alert. When it fires, the blob changes to the timer shape in an urgent colour and stays that way. A tap reads the alert aloud and clears it. Setting the same timer twice in one day creates two timers.

### CUJ 5: An external alert arrives while idle (slice 4)

*   **Given**: A source such as Hermes or a Home Assistant automation holds the alert token.
*   **When**: It posts an alert with `source=homeassistant` and `urgency=urgent`.
*   **Then**: Every connected screen shows the alert shape and colour within 1 s. If a conversation turn is running, the alert is held until the turn ends. After a restart of the service, the alert is still there.

### CUJ 6: Hermes is down

*   **Given**: Hermes does not answer.
*   **When**: The user finishes a question.
*   **Then**: After the Hermes timeout (75 s by default) or an error status, the fixed fallback line is spoken. The blob is grey while it plays and for at least 3 s, then returns to idle. No error text is spoken.

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
| `listening` | the backend accepts a `tap` or `wake` | the client sends `utterance`, or `cancel`, or the 15 s client cap fires, or the 30 s listening watchdog fires |
| `thinking` | the utterance arrives | the reply audio is ready, or an error, a `cancel` or a timeout happens |
| `speaking` | the first audio frame is sent | playback ends on the client, or the user taps |

`error` is not a backend state. It is a client-only overlay. The page sets it when `turn_done` arrives with a reason other than `ok`, `empty` or `cancel`, and clears it when local playback is empty and at least 3 s have passed. The backend never sends `conv = error`: `snapshot.conv` returns to `idle` when the turn lock is released. A tap during the overlay behaves as in `idle`, except that a tap during the fallback audio stops it.

The client keeps `speaking` on screen until its own playback queue is empty. The backend sends `turn_done` after it has sent the last audio frame.

A `tap` or `wake` in `idle` while another connection holds the turn lock gets `error{code: busy}`. The lock is released on `turn_done`, on WebSocket close, when the 30 s listening watchdog fires, or when the 120 s processing watchdog fires. The processing watchdog is measured from the moment `utterance` arrives and covers speech-to-text, Hermes and synthesis.

### Turn pipeline (backend)

1.  `tap` in `idle` creates a `turn_id`, takes the turn lock, sets `listening`.
2.  The client opens the microphone, records 16 kHz mono signed 16-bit PCM from one AudioWorklet, and on the second tap (or the 15 s cap) stops the microphone tracks and sends `utterance` followed by one binary frame with the audio. The worklet resamples the microphone input to 16 kHz, so the page does the only resampling. Audio is not streamed. The server rejects a frame over 1 MB (15 s of 16 kHz 16-bit audio is about 480 KB). `utterance` also carries `dur_ms` and `tail_silence_ms`: the page measures the time since the last 20 ms window whose RMS was above `silence_rms` (default 0.01). The server uses the arrival time of `utterance` minus `tail_silence_ms` as the "last voiced frame" for SC1. The page and server clocks are never compared.
3.  The backend runs speech-to-text under the GPU lock: language auto-detect, one pass, the faster-whisper voice-activity filter (`vad_filter`) on, and an empty-text drop. It records the detected language and the no-speech probability (the mean over segments, compared with `NO_SPEECH_MAX`, default 0.6, in one function in `stt.py`). An empty result, or a probability over the limit, ends the turn with `empty` and zero Hermes calls. A zero-length `utterance` (`dur_ms: 0`, sent by the page when no speech started within its limit) also ends as `empty`.
4.  The backend builds the Hermes request: one merged system message, the history (see below), and the user text.
5.  Hermes is called with `stream: false` in slice 1. Timeouts (config values): connect 5 s and total 75 s. A no-bytes timer (`hermes_no_bytes_s`, 30 s) applies only if streaming is enabled later, because only a stream sends keepalives. On a failure the backend aborts the request, speaks the pre-rendered fallback line for the detected language, and ends the turn with `hermes_fail` or `timeout`. A connect timeout or an error status ends with `hermes_fail`. The Hermes total timeout, the 120 s processing watchdog and the 30 s listening watchdog all end the turn with reason `timeout`; the timing line records which one (`timeout_kind: hermes | turn | listen`). No fallback line is spoken for `listen`.
6.  The reply text is cleaned (markdown, emoji and URLs removed). Text over `tts_max_chars` (default 1200) is cut at the last sentence end before the limit and the cut is logged. The voice is chosen with `voice_for(lang)`, and Kokoro synthesises the whole reply under the GPU lock into one WAV.
7.  The backend sends `tts{turn, seq, final}` and one binary frame, then `turn_done{turn, reason, timings}`.
8.  (Slice 3) If the cleaned reply text ends with `?`, the `tts` message carries `followup: true`. When the device that started the turn finishes playback, it sends `wake{followup: true}`. The backend starts a new turn in `listening`, without the wake word. The page owns the 6 s no-speech limit through its voice-activity detector (`followup_listen_s`, read from `GET /device-config`): if no speech starts in 6 s it sends a zero-length `utterance`, which the server ends as `empty`, and the state returns to `idle`. The server keeps only its 30 s and 120 s watchdogs. A follow-up turn whose own reply ends with `?` can open another, up to `FOLLOWUP_MAX` in a row (default 3, a guard against loops). `turn.py` holds the counter per chain; it resets when a turn that does not end with `?` finishes, or after 10 s of idle.

`voice_for(lang)` is one dictionary: `ca` maps to a Spanish voice, `es` to a Spanish voice, `en` to an English voice, and anything else to `es`. Replacing the `ca` entry is intended to add Catalan speech; Matxa would be a second engine and needs its own loading and sample-rate handling.

The model calls sit behind two functions that nothing else knows the internals of: `stt(audio, lang=None)` returns `{text, lang, no_speech_prob}`, and `tts(text, lang)` returns audio. A model-serving sidecar is intended to replace both later; its API is unverified.

**Cancel.** A `cancel` sets a flag on the turn. The pipeline checks it after speech-to-text, after Hermes and before synthesis, and discards the result. A model call that is already running finishes and its output is dropped. The backend also closes the HTTP connection to Hermes. Whether Hermes stops its run when the client disconnects is unverified and is a question for the Hermes test.

**Failures.** For every row the turn lock is released when `turn_done` is sent.

| Failure | `turn_done` reason | What the user gets |
| --- | --- | --- |
| speech-to-text exception, or GPU out of memory | `stt_fail` | the pre-rendered fallback line is spoken, grey overlay |
| empty speech, or high no-speech probability | `empty` | nothing is spoken, back to idle |
| Hermes error status, or connect timeout | `hermes_fail` | the fallback line is spoken, grey overlay |
| Hermes total timeout, or the 120 s processing watchdog | `timeout` (`timeout_kind` `hermes` or `turn`) | the fallback line is spoken, grey overlay |
| listening watchdog (no `utterance` for 30 s) | `timeout` (`timeout_kind` `listen`) | nothing is spoken, back to idle |
| synthesis exception | `tts_fail` | the client plays the local beep file, grey overlay |
| user cancel | `cancel` | playback stops, back to idle |

Pre-rendered audio (the fallback line, one per language, and a short beep file for the client) is made at startup. Startup also runs one dummy transcription and one dummy synthesis so the first real turn is not cold.

### Hermes client and history

*   Endpoint, API key and model name are environment variables (`HERMES_URL`, `HERMES_KEY`, `HERMES_MODEL`). The key goes in `Authorization: Bearer`.
*   One merged system message, a constant `SYSTEM_MESSAGE` in `hermes.py`, asks for short spoken sentences, no markdown, a reply in the language of the user's last message (Catalan counts as Spanish), and a question before any action that changes something. Hermes layers this message on top of its own prompt. Known limit: if Hermes replies in another language than the question (for example when asked for an English translation), the reply is spoken with the voice of the question's language and may sound wrong.
*   History: by default Blob sends a stable `X-Hermes-Session-Id` (`blob-<unix time of the last rotation>`, one per household, rotated after 5 minutes without a turn) and only the new user message, and Hermes keeps the history. If the Hermes test shows that the header does not work, `HERMES_HISTORY_MODE=replay` makes Blob keep the last 6 completed user and assistant pairs and replay them. Only the mode the test selects is built first. Fallback lines, cancelled turns and errored turns never enter history. `ask(user_text)` runs as a cancellable task: a cancelled task maps to `cancel`, not `hermes_fail`.
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
| `late` | boolean, true when an overdue timer fired after a restart |
| `created_at`, `activated_at`, `acked_at` | UTC epoch seconds |

Endpoints (all need the bearer token `ALERT_TOKEN`):

*   `POST /alerts` upserts by `key`. `key` matches `[A-Za-z0-9._-]{1,64}`. Required: `key`, `source`, `text` (up to 300 characters, else 422). `urgency` is `info` or `urgent` (else 422) and defaults to `info`, except `source=timer`, which defaults to `urgent`. `fire_at` is epoch or RFC3339 with an offset; a time without an offset gets HTTP 422. `in_s` is accepted and the backend computes `fire_at` from its own clock. Giving both `fire_at` and `in_s` gets 422. A request with no `fire_at`, a past `fire_at` or a negative `in_s` makes the alert `active` immediately. A changed `fire_at` on a `pending` or `active` key updates the row. A POST to an `acked` key is ignored if `text`, `urgency` and the computed `fire_at` are unchanged; a changed payload sets it back to `active`. A request that gives `in_s` always computes a new `fire_at`, so it counts as changed and re-raises the alert. A source that repeats a status check every minute and sends no `fire_at` is ignored while the alert is acked. Limits: 20 `active` alerts; the 21st gets HTTP 429. The response is 201 for a new key and 200 for an update, with the body `{key, state, fire_at}`.
*   `DELETE /alerts/{key}` is idempotent and returns 204.
*   `GET /alerts` returns an array of the same objects, so a source (such as Hermes) can find and cancel a timer.

`snapshot.alerts[]` items are `{key, source, urgency, text, lang, late, activated_at}`.

A scheduler is one asyncio task. It finds the earliest `pending` `fire_at`, sleeps until then (with a 250 ms cap on the sleep so a newly added timer is seen quickly), and moves `pending` rows with `fire_at` in the past to `active`. On startup, overdue timers fire once and are marked `late`, unless `ttl_s` has also passed. `ttl_s` starts when the row becomes `active`. A `pending` row is deleted only by `DELETE`. Other rows are deleted when the source calls `DELETE`, when `ttl_s` expires, or 24 h after `acked_at`. `snapshot` lists `active` alerts only.

If the S0 test shows that Hermes cannot create timers through `/alerts`, a rule in the backend (`timer_rule.py`, built only in that case) runs before Hermes on the transcript. It matches "temporizador", "timer" or "temporitzador" with a number of seconds, minutes or hours (digits, the words "un", "una", "dos" to "diez", or "media hora"; Spanish, Catalan and English units). When it matches, Hermes is not called: the reply is a pre-rendered confirmation ("Vale, temporizador de N minutos" or "Okay, N minute timer"), the turn ends `ok`, and the timer key is `timer-<unix time>`. If it does not match, the transcript goes to Hermes.

A tap on an alert sends `alert_read`; the server answers with the alert text synthesised by `voice_for(lang)`, and the page sends `alert_ack` after playback ends. If audio is locked or synthesis fails, the page keeps the alert, plays the beep, and sends nothing. `alert_read` on an unknown key, or during a turn, gets `error{bad_message}`.

### Display rules

The client, not the backend, computes what to draw: `view = conversation turn active ? conversation state : top alert`. Precedence is offline, then conversation turn, then top alert, then idle. The top alert is `urgent` before `info`, then oldest first. An alert that arrives during a turn is broadcast but held hidden until the turn ends. Alerts do not make sound during a turn. One chime file plays on every client with `sound=true` when an alert becomes active, once per alert. A chime that came due during a turn plays at turn end if the alert is still open. The page reads `quiet_hours` (format `22:00-07:00`) from `GET /device-config` and mutes chimes in that window, using the browser's local time.

Two data tables in the page, not in code branches:

*   Conversation state to colour and motion: `idle` deep blue/violet with slow breathing, `listening` cyan deforming with the microphone level, `thinking` amber with slow breathing, `speaking` warm white pulsing with playback level, `error` dim grey.
*   Alert source and urgency to shape, colour and pulse speed. Slice 4 starts with two shapes: triangle for `timer`, square for every other source. `info` is green and `urgent` is red (constants in `tables.ts`), and `urgent` pulses at twice the rate of `info` (a constant in `tables.ts`). A morph between two shapes uses `mix(sdfA, sdfB, t)` with the march step shortened to about 0.7.

The shader is one fullscreen quad. Transparency is a fresnel term over a procedural dark environment, tinted per state. There is no refraction pass. Tablet cost controls: render at 0.75 scale, exit early outside a bounding sphere, cap idle at 30 fps, handle `webglcontextlost`.

### WebSocket protocol

Text messages are JSON. Audio is binary, sent right after the JSON header that announces it. The hub writes a header and its binary frame together under a per-connection lock, so no other JSON message comes between them.

Client to server:

| Message | Slice | Content |
| --- | --- | --- |
| `hello` | S1 | `version`, `token`, `device` (`sound` and `wake` come from `GET /device-config`, not from `hello`) |
| `tap` | S1 | none |
| `utterance` | S1 | `turn`, `format: pcm_s16le`, `rate: 16000`, `dur_ms`, `tail_silence_ms`, then one binary frame (none when `dur_ms` is 0) |
| `cancel` | S1 | `turn` |
| `ping` | S1 | none |
| `client_event` | S1 | fault or timing events; written to standard output as a JSON line (`kind: client_event`), not persisted |
| `wake` | S3 | `followup` (boolean, default false). Starts a turn the same way as `tap`. Allowed only from a device whose `wake` flag is true. The page enforces the 6 s no-speech limit when `followup` is true |
| `alert_read` | S4 | `key`. The server answers with a `tts` message carrying `alert: key` and `final: true`, then one binary frame |
| `alert_ack` | S4 | `key`. Sets the alert to `acked` |

Server to client:

| Message | Slice | Content |
| --- | --- | --- |
| `hello_ok` | S1 | `version`, `ok`. The page compares versions and follows the reload rule on a mismatch |
| `snapshot` | S1 | `conv`, `alerts[]`; sent on every connect and every change |
| `state` | S1 | `conv`, `turn`; the page learns its turn id from the first `state` after a `tap` |
| `tts` | S1 | `turn` (or `alert`), `seq`, `final`, `followup` (S3), then one binary frame |
| `turn_done` | S1 | `turn`, `reason` (`ok`, `empty`, `stt_fail`, `hermes_fail`, `timeout`, `tts_fail`, `cancel`), `timings` |
| `error` | S1 | `code` (`busy`, `bad_message`, `not_ready`) |
| `pong` | S1 | none |

`snapshot` and `state` go to all clients. `tts` and `turn_done` go to the client that started the turn. The hub handles these input conditions: a message before `hello` closes the socket with code 4400; an unknown type or invalid JSON gets `error{bad_message}`; an `utterance` with no open turn, a wrong turn id or a bad `format` or `rate` gets `error{bad_message}` and leaves the lock unchanged; a frame over 1 MB gets `error{bad_message}` and the turn ends `cancel`; a `tap` while the models are still loading gets `error{not_ready}` (the page shows the grey blob); a WebSocket close releases the lock and cancels the pipeline. The backend sends `turn_done` exactly once per turn, guarded by a `done` flag against the cancel, watchdog and Hermes-error race.

`snapshot` carries the full state after every change. `state` is sent only for turn transitions, so a client can update quickly. On a wrong token the server closes the socket with WebSocket close code 4401 and the client does not retry. Other disconnects reconnect with a backoff from 1 s to 30 s. Because the client redraws from the latest `snapshot`, a reconnecting tablet does not keep a stale alert.

Other HTTP endpoints: `GET /device-config?device=<name>` returns that device's `sound` and `wake` flags plus `quiet_hours`, `followup_listen_s` and `listen_no_speech_s`, and needs `DEVICE_TOKEN` in an `Authorization` header (a missing or wrong token gets 401). The device name comes from the install URL (`#t=TOKEN&device=tablet`) and is stored in `localStorage` together with the token.

Audio playback uses one `AudioContext`. Chunks are scheduled at `nextT = max(now, nextT) + duration`. A new turn, a cancel or a tap stops all sources and resets `nextT`. Chunks from a stale turn are dropped. Slice 1 sends one WAV per reply and decodes it with `decodeAudioData`.

### Sound targets

Alert sound goes to every client with `sound=true`, a per-device setting kept in the server file `config/devices.json` and read by the page from `GET /device-config` (tablet on, desktop off). During a turn, audio goes to the client that started it. While audio is locked (the `AudioContext` state is `suspended`), the page shows a permanent "audio locked" cue, and a tap in that state only unlocks audio and does nothing else. The page calls `resume()` on the one `AudioContext` on every tap.

### Taps

The first matching row wins.

| State | A tap does |
| --- | --- |
| audio is locked | unlocks audio and does nothing else |
| an alert is showing (and audio is unlocked) | reads the alert aloud, then sends `alert_ack` after playback ends |
| fallback audio is playing (the grey overlay) | stops the fallback audio |
| `speaking` | stops playback and sends `cancel` |
| `thinking` | sends `cancel`, which sets the cancel flag and drops the result |
| `listening` | stops the microphone and sends the audio |
| `idle` or `error`, no alert | starts a turn |

To talk while an alert is open, tap once to read and clear it, then tap again. A long press opens the diagnostics view. In slice 3, the wake word always starts a turn.

The diagnostics view lists the page version, socket and microphone status, the last turn's timings, and a button that copies a text report.

### Hands-free (slice 3, with unverified assumptions)

*   One `getUserMedia` stream and one AudioWorklet feed two consumers: the wake-word detector and the voice-activity detector. The wake detector runs only while the local state is `idle`. The voice-activity detector runs only while listening. Playback mutes the wake detector, plus a 0.5 s hangover.
*   The first candidate detector is an openWakeWord model in a Web Worker using ONNX Runtime Web with one thread; the engine is confirmed by the tablet test. The phrase is "hey blob". A custom model must be trained. A stock phrase such as "hey jarvis" is used first to test the pipeline. Whether openWakeWord runs reliably in a browser worker on the author's tablet is the main unverified assumption of this slice.
*   End of speech is 0.6 to 0.8 s of silence from a Silero voice-activity detector (`@ricky0123/vad-web`). The page owns the limits: 8 s with no speech (`listen_no_speech_s`) and 15 s in total. On no speech it sends a zero-length `utterance`, which the server ends as `empty`. Parameters such as chunk size, score threshold, debounce and cooldown are set after the tablet test and recorded in `docs/spikes/tablet-test.md`.
*   The wake detector runs only on the device marked `wake=true` in `config/devices.json`. The desktop tab is tap-only.
*   Follow-up listening: when a reply ends with `?`, the device that started the turn opens the microphone for 6 s after playback ends, without the wake word, so the user can answer a question from Hermes (for example a confirmation). The wake detector stays muted during it. It happens once per reply, at most `FOLLOWUP_MAX` times in a row. It needs the voice-activity detector and the shared stream, so it belongs to this slice. A reply that ends with `?` but is rhetorical opens the microphone for 6 s for nothing; the 6 s limit bounds that cost.
*   If the wake word cannot run on the tablet for 2 hours, the fallback order is tap or hardware button only, then a plain WebView shell with no wake logic, then a switch to a Home Assistant display layer.

### Tablet and deployment (slice 2)

*   **Page:** a PWA manifest with `display: fullscreen`. No service worker at first (check once on the tablet whether Chrome needs one for fullscreen). `index.html` is served with `Cache-Control: no-cache`. Assets have hashed names. The page re-acquires the Wake Lock when it becomes visible again. After a reboot, the first tap unlocks audio (known limit). On a version mismatch in `hello`, the page reloads at most once per server version, stored in `localStorage`; a second mismatch shows the fault cue and stops.
*   **Secure context:** `getUserMedia`, Wake Lock and PWA install need one. `localhost` on the tablet is the tablet, not the server. The first tablet test uses either `adb reverse` (unverified) or a certificate made with `mkcert`. The deployed setup uses a real domain, cert-manager and internal DNS.
*   **Container:** one image built on an `nvidia/cuda` CUDA 12 runtime image with cuDNN (`ASSUMED`; the tag matches the pinned CTranslate2 version). Models are stored on a PVC, not in the image. The pod has `replicas: 1` and `strategy: Recreate` because one GPU is used by one pod at a time. The pod requests one GPU (assumes an NVIDIA GPU and the NVIDIA device plugin; the vendor is not yet confirmed).
*   **Ingress:** routes the whole host to the pod with a prefix rule, so `/alerts`, `/healthz`, `/readyz` and `/device-config` are also reachable from the home network. `/alerts` is protected only by `ALERT_TOKEN` (author's choice; a second internal listener and exact ingress paths were the alternatives). Sources can also use the in-cluster Service. WebSocket idle timeouts are raised and the client pings every 20 s.
*   **Tokens:** `ALERT_TOKEN` for sources and `DEVICE_TOKEN` for browsers. A browser installs its token once by opening `https://host/#t=TOKEN`. The page stores it in `localStorage` and removes the hash. The PWA `start_url` carries no secret.
*   **Startup:** the HTTP server, the database and the scheduler start first. Models load in a background task. `/healthz` always returns 200 while the process runs (liveness); its JSON body has `alive`, `ready` and `hermes_reachable`. `/readyz` returns 503 until the database is open and both models are loaded, then 200. The Kubernetes liveness probe uses `/healthz`, the readiness probe and a `startupProbe` (long failure threshold, because model loading can take minutes) use `/readyz`. `hermes_reachable` is a background check every 30 s with a 3 s timeout against Hermes's `GET /health` (documented on the saved Hermes page, not run). It appears in the body and in the diagnostics view only, so a Hermes outage does not take the pod out of service. A tap while the models are loading gets `error{not_ready}` and shows a grey blob.

### Data, privacy and logs

*   SQLite lives on block or local storage, not NFS, in default journal mode, with one writer. It holds the `alerts` table (S4) and a `turns` table with `turn_id` (integer, autoincrement), `ts` (UTC epoch), `lang`, `user_text`, `reply_text`, `reason`, `timeout_kind` and `timings` (JSON). `PRAGMA user_version` is 1 in S1 and 2 when S4 adds `alerts`; a new version adds tables or columns only, so an older image still opens a newer file.
*   Rows in `turns` older than 14 days are deleted at startup and every 24 h. Audio is never stored. Alerts can be re-created by their sources. There is no backup.
*   Standard output carries the timing line (one JSON object per turn with the timings, reason and `timeout_kind`, no text) and `client_event` lines. Text goes to the `turns` table. The `timings` keys are `stt_ms`, `hermes_ms`, `tts_ms`, `first_audio_ms` (utterance arrival to the first `tts` send) and `sc1_ms` (`first_audio_ms` plus `tail_silence_ms`).
*   Hermes keeps its own memory outside Blob's 14 days, and may forward text to an external model provider. This is the author's existing setup.
*   Audio leaves a device only after an explicit trigger (a tap, a hardware button that sends a tap, or the wake word) or during the 6 s follow-up window after a reply that ends with a question. In tap mode the microphone tracks stop after each turn. The server drops audio unless a turn is open.

### Configuration

Environment variables (name, default, first slice that needs it):

| Name | Default | Slice |
| --- | --- | --- |
| `HERMES_URL`, `HERMES_KEY`, `HERMES_MODEL` | required | S1 |
| `HERMES_HISTORY_MODE` | `session` or `replay`, set by the S0 test | S1 |
| `HERMES_CONNECT_S` / `HERMES_TOTAL_S` / `HERMES_NO_BYTES_S` | 5 / 75 / 30 (streaming only) | S1 |
| `LISTEN_WATCHDOG_S` / `TURN_WATCHDOG_S` | 30 / 120 | S1 |
| `SESSION_IDLE_S` / `HISTORY_PAIRS` | 300 / 6 | S1 |
| `STT_MODEL` / `STT_COMPUTE` | `large-v3` / `int8_float16` | S1 |
| `NO_SPEECH_MAX` / `SILENCE_RMS` | 0.6 / 0.01 | S1 |
| `KOKORO_DEVICE` | `cpu` (`cuda` only if S1 measures the CPU as too slow) | S1 |
| `TTS_MAX_CHARS` | 1200 | S1 |
| `RETENTION_DAYS` | 14 | S1 |
| `HOST` / `PORT` | `0.0.0.0` / 8000 | S1 |
| `DB_PATH` / `STATIC_DIR` | `/data/blob.db` / `web/dist` | S1 |
| `DEVICES_PATH` | `config/devices.json` | S2 |
| `ALERT_TOKEN` / `DEVICE_TOKEN` | required | S2 |
| `FOLLOWUP_MAX` / `FOLLOWUP_LISTEN_S` / `LISTEN_NO_SPEECH_S` | 3 / 6 / 8 | S3 |
| `QUIET_HOURS` | empty (none), format `22:00-07:00` | S4 |

The fixed fallback lines are text constants in `voices.py` (Spanish and English), not environment variables. The per-device `sound` and `wake` flags live in `config/devices.json`, served through `GET /device-config`.

### Assumptions the plan depends on

1.  Hermes's `/v1/chat/completions` returns plain text for a non-streaming call, honours a system message, and keeps a session when `X-Hermes-Session-Id` is sent. (Hermes test, about 1 h.)
2.  Hermes can call `POST /alerts` with a bearer token and report a failure. If not, the transcript rule is built.
3.  A fullscreen PWA on the author's Android tablet can keep a microphone and a wake word running for 2 hours or more. (Tablet test, a few hours.)
4.  Large-v3 with `int8_float16` plus Kokoro fit in 8 GB with the Hermes LLM on an external provider. (Slice 1 measures this.)
5.  `kokoro-onnx` runs fast enough on the CPU and exposes the Spanish and English voices and language codes needed. (Slice 1 confirms. A CPU run would remove GPU-lock contention; `onnxruntime-gpu` is the fallback if it is too slow. Slice 2 confirms that both libraries load in one container image.)
6.  Raw PCM samples go into the speech model without a decoder.
7.  A custom "hey blob" model can reach under 1 false accept per day. (Slice 3 measures this.)

--------------------------------------------------------------------------------

## Risks & Mitigations

| Risk | Effect | Mitigation | Tested in |
| --- | --- | --- | --- |
| GPU out of memory, or CUDA fails to start | speech-to-text or synthesis raises | turn ends `stt_fail` or `tts_fail`; the fallback line or the beep is played; the lock is released | S1 |
| Hermes is down or slow | no reply | connect 5 s and total 75 s; the fallback line; the pod stays ready (`/readyz` ignores Hermes) | S1 |
| A cancelled turn still runs a Hermes tool | an action happens after the user cancelled | cancel flag between stages and connection close; unverified whether Hermes stops its run | S0 Hermes test |
| Speech-to-text invents text from silence | a false turn reaches Hermes | `vad_filter`, `no_speech_prob` threshold, empty-text drop | S1 |
| `/alerts` is reachable from the home network | a leaked token lets anyone on the network create or delete alerts | single `ALERT_TOKEN`; ingress kept inside the home network | accepted |
| Hermes tools reachable by voice | a TV or a guest says the wake word and triggers an action | system-message line asking for confirmation; follow-up listening for the answer; a separate Hermes profile if one exists | accepted for a home LAN |
| SQLite damaged after a power loss | alerts or turn text lost | alerts are re-created by their sources; `turns` is disposable; no backup | accepted |
| `Recreate` downtime on each deploy | the page and timers are unavailable for the restart | accepted; alerts reload on startup | S2 |
| The wake word does not run on the tablet | no hands-free mode | tap or button mode, then a WebView shell, then switch to a Home Assistant display layer | S0 tablet test |
| Audio is locked after a tablet reboot | no sound until the first tap | permanent "audio locked" cue; the first tap only unlocks audio | S2 |

--------------------------------------------------------------------------------

## Alternatives Considered

Source: the "Alternatives Weighed" section and the Prior Art section of `docs/designs/blob.md`, plus the decisions made in review rounds 1 and 2. Where the author asked for a simple default and accepted a recommendation, the entry says so. Deferred items are not rejections.

### Alternative A: Blob as a display layer on Home Assistant

*   **What it is**: Install Voice Satellite (or Kiosk Satellite on the tablet) and a community Hermes conversation agent. Build only a Home Assistant custom card with the three.js blob, reading satellite state, timers and alert entities.
*   **Pros**: Removes the wake word, voice-activity detection, model serving, turn lock, alerts API, SQLite and TLS work. Voice Satellite already runs a wake word in the browser, and Kiosk Satellite (a separate Android app by the same author) runs it natively on the tablet.
*   **Cons**: Needs Home Assistant. Voice Satellite skins accept only CSS overrides, and hiding its overlay is unverified. The blob cannot follow microphone volume unless a level is exposed. Hermes integrations are community projects of unknown maturity and some need very recent Home Assistant versions.
*   **Decision and rationale**: Rejected by author: Blob must be a general assistant and not tied to Home Assistant. Hermes handles Home Assistant through its own integration. The plan keeps this as the fallback if the tablet or wake-word test fails (see the switch conditions in `docs/designs/blob.md`).

### Alternative B: Fork Voice Satellite and add a Blob skin

*   **Pros**: Gets the whole engine (wake word, timers, announcements) and a skin system.
*   **Cons**: Voice Satellite is AGPL-3.0, 846 commits, and its author does not take pull requests ([README](https://github.com/jxlarrea/voice-satellite-card-integration)), so the fork owns every merge. It is tied to Home Assistant.
*   **Decision and rationale**: Rejected by author: the same reason as Alternative A, and a large maintenance burden for a visual change.

### Alternative C: Use Hermes's own voice mode

*   **Pros**: Already has a wake word, faster-whisper, sentence-by-sentence speech, barge-in and stop phrases.
*   **Cons**: The wake word runs only in the CLI, the terminal UI and the desktop app, not in a browser. The documentation lists only English wake-word models. No blob, and no documented push channel to clients.
*   **Decision and rationale**: Rejected by author: does not give a browser or tablet client with the blob and alerts.

### Alternative D: XTTS-v2 for speech output

*   **Pros**: Multilingual, with streaming and voice cloning.
*   **Cons**: Has no Catalan (Kokoro has none either, so this is not the deciding reason). XTTS-v2 is a larger model than Kokoro-82M, and the author's 8 GB budget and latency target favour the smaller model (not measured; unverified).
*   **Decision and rationale**: Rejected by author: Kokoro is smaller and its quality is acceptable to the author; XTTS-v2 offers no Catalan advantage.

### Alternative E: Piper for all three languages, or Piper for Catalan only

*   **Pros**: One lightweight engine that can run on the CPU. Catalan voices exist (unverified).
*   **Cons**: Not compared with Kokoro; the author prefers Kokoro. Piper's original repository was archived and development moved to a fork under a different licence (unverified). Voice licences are per voice.
*   **Decision and rationale**: Not chosen for the first slices by the author, who prefers better voice quality. Deferred: Piper Catalan is the first stopgap when Catalan speech is added, before Matxa.

### Alternative F: Matxa + alVoCat for Catalan speech now

*   **Pros**: Built for Catalan, with several accents. About 1 GB per the author's figure.
*   **Cons**: Catalan only, so a second engine next to Kokoro. The 1 GB may be disk size, not GPU memory (unverified).
*   **Decision and rationale**: Rejected by author for the first prototype to keep it simpler. Catalan input is still supported. Revisit after slice 4.

### Alternative G: Whisper large-v3-turbo, or a Catalan fine-tune, as the main speech model

*   **Pros**: Turbo is faster and smaller. [`zuazo/whisper-large-v3-ca`](https://huggingface.co/zuazo/whisper-large-v3-ca) reports 5.97% word error on Common Voice 13; [`projecte-aina/whisper-large-v3-ca-3catparla`](https://huggingface.co/projecte-aina/whisper-large-v3-ca-3catparla) reports 0.92 to 12.25% across its test sets (the model pages).
*   **Cons**: Turbo may be less accurate on Catalan (unverified, not measured). A Catalan fine-tune may do worse on Spanish and English. Neither model page shows a CTranslate2 build, so converting for faster-whisper is unverified.
*   **Decision and rationale**: Chosen as the default (large-v3); turbo is a benchmark candidate. Fit in 8 GB is verified in slice 1, and no Catalan comparison exists. The model name is a config value, and slice 1 measures large-v3 against turbo on the author's clips.

### Alternative H1: Wake word on the server

*   **Pros**: A server-side detector would not depend on a browser worker.
*   **Cons**: Audio would leave the device before the wake word fires.
*   **Decision and rationale**: Rejected by author: audio must leave the device only after an explicit trigger.

### Alternative H2: Porcupine

*   **Pros**: A packaged engine with built-in keywords.
*   **Cons**: Needs an access key, has a non-commercial free tier, and its Catalan support is unverified. openWakeWord's pretrained models carry a non-commercial licence (unverified).
*   **Decision and rationale**: Not chosen: the access key and licence terms add friction. Revisit if the other engines do not run on the tablet.

### Alternative H3: microWakeWord

*   **Pros**: Voice Satellite uses it by default because it runs on the CPU of any device (its page). It may suit an older tablet better than openWakeWord, which Voice Satellite lists as WebGPU-based.
*   **Cons**: A "hey blob" model needs its own training recipe (unverified).
*   **Decision and rationale**: Deferred: tried second in the tablet test, if openWakeWord does not run. The engine is chosen after that test, and tap or button mode is the fallback.

### Alternative I: Route alerts through Hermes

*   **Pros**: Hermes would know about every alert and could answer questions about it.
*   **Cons**: Adds LLM latency and cost to a timer, and fails when Hermes is down. A language model has no reliable clock for an absolute time.
*   **Decision and rationale**: Rejected by author: alerts must work without an LLM in the path. Sources call `POST /alerts` directly. Later, Blob can add one line about open alerts to the Hermes system message.

### Alternative J: Blob polls the calendar or Home Assistant

*   **Pros**: No dependency on the sources to push.
*   **Cons**: Duplicates what Home Assistant and Hermes already do. Blob would need credentials for every system.
*   **Decision and rationale**: Rejected by author: sources call Blob. Hermes handles Home Assistant.

### Alternative K: Vertex displacement on an icosphere for the blob

*   **Pros**: Cheaper than raymarching.
*   **Cons**: Cannot make straight edges, so a cube or triangle would look rounded.
*   **Decision and rationale**: Rejected by author: the shapes must read as shapes.

### Alternative L: Smooth-min to morph between shapes

*   **Pros**: One operator for both morphs and merging.
*   **Cons**: Smooth-min is a union. Sphere and cube merge into a larger bulge instead of turning into a cube.
*   **Decision and rationale**: Rejected by author (accepted recommendation): morphs use `mix(sdfA, sdfB, t)`. Smooth-min returns only if droplets are added to the thinking state later.

### Alternative M: True refraction for the glass look

*   **Pros**: More convincing transparency.
*   **Cons**: A second march per pixel, which is expensive on a tablet.
*   **Decision and rationale**: Rejected by author (accepted recommendation): fresnel over a procedural environment. Revisit if the result looks flat on the tablet.

### Alternative N: A mic lock lease with a heartbeat, and a level stream to mirrors

*   **Pros**: Handles several devices that hear the wake word at the same time. Mirrors could animate to the real microphone level.
*   **Cons**: A 30 s lease is shorter than a long turn. The server has no microphone audio until the utterance ends, so it cannot compute a level. It is distributed-systems work for one household.
*   **Decision and rationale**: Rejected by author (accepted recommendation): one `current_turn` on the server, wake word on one device only, and a synthetic envelope on mirrors. The lease returns if two wake-word devices are needed.

### Alternative O: A native Android wrapper that runs the wake word

*   **Pros**: Native wake-word capture is lighter than in-browser. It keeps the microphone with the screen off.
*   **Cons**: Needs a second runtime, native capture, a foreground service and a bridge to the page. It contradicts the non-goal of a native app.
*   **Decision and rationale**: Rejected by author (accepted recommendation): the fallback order is tap or button mode, a plain WebView shell, then a Home Assistant display layer.

### Alternative P: Stream microphone audio with `MediaRecorder` webm/opus

*   **Pros**: Smaller uploads. Less client code at first.
*   **Cons**: Whether faster-whisper decodes browser webm/opus is unverified. The wake word and the voice-activity detector need raw samples anyway.
*   **Decision and rationale**: Rejected by author: one AudioWorklet that records 16 kHz PCM, sent whole when recording ends.

### Alternative Q: Sentence streaming from the first slice, and a spoken filler phrase

*   **Pros**: Speech starts before Hermes finishes. A filler phrase covers silence while Hermes works.
*   **Cons**: A splitter and ordered playback are real code before the latency is measured. A filler phrase triggers on most turns if Hermes takes about 3.5 s per plain turn (the figure hermes-voice reports in its own README), and the stream content during tool use is unverified.
*   **Decision and rationale**: Deferred by author (accepted recommendation): slice 1 uses a whole reply. Streaming comes after slice 1's timings. A first-sentence flush (about 10 lines) is the first step.

### Alternative R0: The PyTorch `kokoro` package instead of `kokoro-onnx`

*   **Pros**: The main Kokoro project's own package, with a GPU path through PyTorch.
*   **Cons**: Brings PyTorch into an image that already carries CTranslate2, which may conflict on cuDNN or CUDA versions (unverified). The image is larger.
*   **Decision and rationale**: Rejected by author (delegated; the choice is `kokoro-onnx`): smaller image, no PyTorch, and a CPU path that removes GPU-lock contention. Revisit if `kokoro-onnx` voice quality or Spanish phonemes are worse in slice 1.

### Alternative R: A model-serving sidecar (speaches) in slice 1

*   **Pros**: Removes model-serving code.
*   **Cons**: Its API may not return language probabilities or let models stay loaded, and it makes two containers in one pod. Unverified.
*   **Decision and rationale**: Deferred by author (accepted recommendation): the models load in the backend behind `stt` and `tts` functions, so a sidecar can replace them later.

### Alternative S: Alerts as small satellite blobs, and an attention envelope

*   **Pros**: Show several alerts at once while a conversation runs. The envelope (strong start, calm hold, re-escalation for urgent alerts) avoids a screen that shouts all day.
*   **Cons**: Readability across a room is unproven, and both ideas add visual work before alerts exist.
*   **Decision and rationale**: Deferred by author (accepted recommendation): one alert is drawn at a time, `urgent` before `info`, and a tap clears it.

--------------------------------------------------------------------------------

## Non-Functional Requirements

*   **Security and privacy.**
    *   Two bearer tokens: `ALERT_TOKEN` for sources and `DEVICE_TOKEN` for browsers. Tokens are Kubernetes secrets, never in the image or the repository.
    *   The ingress routes the whole host, so `/alerts` is reachable from the home network and is protected only by `ALERT_TOKEN`. A leaked token lets anyone on the network create or delete alerts. Sources can use the in-cluster Service. The Hermes API key is a secret. Everything runs on the home network and the ingress must not be exposed outside it.
    *   Anyone in earshot of the tablet can start a turn once the wake word is on. Hermes tools reached by voice are limited only by a system-message line, unless Hermes offers a separate profile or toolset for Blob. This risk is accepted for a home LAN and must be revisited if locks or similar are reachable through Hermes.
    *   Audio is never stored. Turn text is kept 14 days in SQLite.
*   **Performance and latency.**
    *   Both models together stay under 8 GB of GPU memory. Slice 1 records the peak.
    *   Success criteria SC1 to SC6 (each cross-references its goal):
        *   SC1 (G9): the median from the last voiced frame to the first audio of the real reply is reported over 20 turns. About 6 s is expected in whole-reply mode, with no pass mark. 3 s is a later goal. "Last voiced frame" is the arrival time of `utterance` on the server minus the `tail_silence_ms` the page measured; "first audio" is the server send time of the first `tts` frame. The timing line reports it as `sc1_ms`.
        *   SC2 (S3 exit test): fewer than 1 wake-word false accept per day over 3 days with the TV on, and fewer than 2 misses in 10 attempts.
        *   SC3 (S1): language detection and word accuracy are measured on the author's clips, with no target.
        *   SC4: about 30 fps on the tablet for 8 h with no throttling visible in frame time.
        *   SC5 (G6): an alert is visible on connected clients within 1 s of the POST.
        *   SC6: after a restart the service is alive at once (see Rollout).
*   **Rollout and rollback.**
    *   `replicas: 1` with `Recreate` means each deploy has downtime while the old pod releases the GPU. This is accepted.
    *   Rollback is deploying the previous image tag. The SQLite schema carries a version in `PRAGMA user_version`. A new version adds columns or tables only, so an older image still starts.
    *   SC6: after a restart the HTTP server, database and scheduler start first and `/healthz` returns 200 at once and `/readyz` returns 200 when the database is open and the models are loaded.

--------------------------------------------------------------------------------

## Additional Resources

*   [Concepts brief and RFC](./blob.md) (section "Current Design"): where this design comes from, with the review history. [`review_round2.md`](../../review_round2.md) has the second review.
*   [Hermes Agent API server](https://hermes-agent.nousresearch.com/docs/user-guide/features/api-server)
*   [Hermes voice mode](https://github.com/nousresearch/hermes-agent/blob/main/website/docs/user-guide/features/voice-mode.md) (not used, studied)
*   [Hermes wake word](https://hermes-agent.nousresearch.com/docs/user-guide/features/wake-word) (not used, studied)
*   [Voice Satellite](https://github.com/jxlarrea/voice-satellite-card-integration) (ideas only, AGPL-3.0, do not copy code)
*   [hermes-voice](https://github.com/majorminorlabs/hermes-voice) (session and filler-phrase ideas)
*   [webgl-shader-lab](https://github.com/PSCactux/webgl-shader-lab) (raymarched liquid metal)
*   [shader-playground](https://github.com/douglasgoodwin/shader-playground) (audio-reactive shaders)
*   [Codrops: liquid raymarching](https://tympanus.net/codrops/2024/07/15/how-to-create-a-liquid-raymarching-scene-using-three-js-shading-language/)
*   [zuazo/whisper-large-v3-ca](https://huggingface.co/zuazo/whisper-large-v3-ca)
*   [projecte-aina/whisper-large-v3-ca-3catparla](https://huggingface.co/projecte-aina/whisper-large-v3-ca-3catparla)
*   [Matxa multi-accent Catalan TTS](https://huggingface.co/projecte-aina/matxa-tts-cat-multiaccent/raw/87cd1f602cc8f2f87bdfb258d81b127e92f51aac/README.md)

--------------------------------------------------------------------------------

## Future Improvements

*   **Sentence streaming.** Flush the first sentence at the first `.`, `!` or `?` followed by whitespace, send the rest as one chunk, then add a real splitter and ordered playback.
*   **Filler phrase.** A short spoken line if Hermes has not started answering after about 4 s, language taken from the speech model, cancelled by the first token, never stored in history.
*   **Catalan speech.** Piper Catalan as a stopgap behind `voice_for("ca")`, then Matxa + alVoCat.
*   **Thinking droplets.** Small droplets orbiting the sphere, using smooth-min, once the `mix()` morph works.
*   **Stopwatch.** A separate `kind=stopwatch` with a `started_at`, kept out of the alert list and answered by speech on request.
*   **Second wake phrase** ("hola blob") as a second parallel model.
*   **Voice acknowledgement** of alerts, and alert text injected into the Hermes system message so Hermes can answer questions about open alerts.
*   **Repeat the urgent-alert chime** every 2 minutes.
*   **Reply-language check.** Detect the language of the reply text and choose the voice from it, instead of using the language of the question.
*   **Multi-device mic lock** with a lease, a heartbeat and arbitration, if two wake-word devices are needed.
*   **Model-serving sidecar** (for example speaches) behind the `stt` and `tts` functions.
*   **Satellite blobs** for several simultaneous alerts, and the attention envelope.

--------------------------------------------------------------------------------

## Detailed Implementation Plan

All paths are relative to the repository root (`/home/arnau/workspace/meet_blob`). Slice tags: **S0** spikes, **S1** tap-to-talk on the desktop, **S2** tablet and deployment, **S3** hands-free, **S4** alerts and timers. Each file appears once; a file touched by several slices lists them in its tag and gives one bullet per slice. Package versions are pinned at first install, not named here. Choices made for the layout: `uv` for Python, Vite and TypeScript for the page, `pytest` and `vitest` for tests, plain YAML for Kubernetes manifests (author's choice).

Two sets of choices were delegated by the author and made in this plan: the Kokoro package (entry 13) and the cluster defaults for the manifests (entries 60 to 67). The Kokoro choice is a decision. The cluster defaults are assumptions about the author's homelab that the plan cannot know; each is marked `ASSUMED` where it appears and must be checked before the first deploy.

### Build order

S0 spikes first. If the wake word cannot run on the tablet for 2 hours, S3 becomes tap or hardware-button mode (the S0 rule). Then, per slice:

1.  **S1:** repository files; `config`, `schemas`, `textclean`, `voices`, `gpu`, `db`, `turnlog`; `main` (with `/healthz`, `/readyz` and a logging `/ws`); `stt` and `stt_cli`; `hermes` and its tests; `tts` and `tts_cli`; `turn` and `hub`; the page (`protocol`, `ws`, `state`, `turn-client`, `taps`, `capture`, `playback`, renderer, `fault`, `diag`); error paths; the exit test.
2.  **S2:** container, manifests, PWA, tokens, tablet hardening.
3.  **S3:** voice-activity detection, the wake word, follow-up listening.
4.  **S4:** alerts, scheduler, timer rule (if needed), chime, shapes.

### Target Files to Create/Modify

#### Repository, docs and tools

##### 1. `docs/spikes/hermes-test.md` (Create, S0)

*   **Type / Scope**: Written record of the Hermes test.
*   **Proposed Changes**: The date, the Hermes version, and the steps with their results: a plain request; a request with a system message; two requests with the same `X-Hermes-Session-Id`; a request that makes Hermes call a tool; a request from the Hermes host to a test `/alerts` endpoint with a bearer token; a client disconnect during a run (does it stop?). Branches: "system message ignored" means the instruction moves into the user message; "reply not plain text" means `clean_for_speech` strips it; "header does not keep a session" means `HERMES_HISTORY_MODE=replay`; "Hermes cannot call `/alerts`" means `timer_rule.py` is built (entry 31). Also records where Hermes runs and its route to the Blob pod, and whether a separate profile or toolset for Blob exists.

##### 2. `docs/spikes/tablet-test.md` (Create, S0)

*   **Type / Scope**: Written record of the tablet test.
*   **Proposed Changes**: Tablet model, Android and Chrome versions, how the secure context was achieved (`adb reverse` or `mkcert`), hours the stub ran, wake-word engine tried first (openWakeWord) and second (microWakeWord), wake-word "drops" (a gap of more than 2 s with no audio frames from the worklet), microphone-permission behaviour after a restart, Wake Lock behaviour, frame rate, and whether Chrome needs a service worker for fullscreen install. States the S0 rule outcome for S3. S3 later adds the parameters chosen: audio chunk size, score threshold, debounce and cooldown.

##### 3. `spikes/tablet-stub/` (Create, S0; Delete, S1)

*   **Type / Scope**: Throwaway test project, outside `web/`.
*   **Proposed Changes**: Its own `package.json` with one `build` script (Vite) and a command that serves the build over HTTPS with a `mkcert` certificate. Files: `index.html`, `stub.ts`. The page has `getUserMedia`, the stock wake word ("hey jarvis") in a worker, an animated canvas, a visible counter of detections and drops, and a Wake Lock request. It logs to the screen because the tablet has no devtools. The folder is deleted in S1 after `tablet-test.md` is written.

##### 4. `README.md` (Create, S1; Modify, S2 and S4)

*   **Type / Scope**: Project readme.
*   **Proposed Changes**: S1: what Blob is, how to run the backend and the page on the desktop, the environment variables, how to run the tests, how to read the timing line (written after the timing keys are fixed). S2: the deploy steps and the tablet install steps.

##### 5. `.gitignore` (Create, S1)

*   **Type / Scope**: Git ignore rules.
*   **Proposed Changes**: Python caches, virtual environments, `node_modules`, `web/dist`, `.env`, the SQLite file, downloaded models, `**/tests/clips/` and `**/clips/` (personal voice recordings are never committed; the plain `tests/clips/` pattern would match only the repository root).

##### 6. `.env.example` (Create, S1; Modify, S2 to S4)

*   **Type / Scope**: Config template.
*   **Proposed Changes**: Every variable in the Configuration table, with its default, a one-line comment and its slice. S1 variables first. Real values go in `.env`, which is ignored.

##### 7. `.github/workflows/ci.yml` (Create, S1)

*   **Type / Scope**: GitHub Actions workflow.
*   **Proposed Changes**: On push and pull request: set up `uv`, run `ruff check`, `ruff format --check`, `mypy` and `pytest -m "not gpu" --cov --cov-fail-under=80` in `backend/` (the coverage list is in the Verification Plan); set up Node, run `npm ci`, `npm run lint`, `npm run typecheck`, `npm test` and `npm run build` in `web/`. GPU tests are skipped in CI.

##### 8. `docs/testing/exit-tests.md` (Create, S1; Modify, S2 to S4)

*   **Type / Scope**: The numbered exit test for each slice.
*   **Proposed Changes**: S1: the list in the Verification Plan, with the clip list (4 Spanish, 3 English, 3 Catalan including short commands, plus one turn that asks in Spanish for an English phrase to record whether the voice mismatches), how to read the median with `timings_report.py`, and the `nvidia-smi` command for peak memory. S2: 8 h on the tablet at about 30 fps with tap turns working, reconnect after a pod restart, the first tap after a reboot unlocks audio. S3: a follow-up check (a reply that ends with a question opens the microphone for 6 s without the wake word; silence returns to idle) and 3 days with the TV on, counting false accepts and misses (fewer than 2 misses in 10 attempts), plus a replay of recorded TV or radio audio through the detector faster than real time when the detector allows it (otherwise the replay is skipped). S4: an alert is visible after a pod restart; a voice timer works end to end; an alert from `curl` shows the right shape within 1 s, measured with `curl` timestamps against a 60 fps screen recording. Manual checks that have no automated test: the look of the shader, Wake Lock, microphone permission, VAD limits.

##### 9. `docs/runbook.md` (Create, S2; Modify, S4)

*   **Type / Scope**: Operations notes.
*   **Proposed Changes**: S2: deploy and roll back, create the secrets, install a token on a tablet with `https://host/#t=TOKEN&device=tablet`, read logs, what `/healthz` and `/readyz` mean, what to do when the tablet shows the "audio locked" cue, how to rotate a token. S4: list and delete alerts by hand, and how restart behaviour treats timers.

##### 10. `docs/alerts.md` (Create, S4)

*   **Type / Scope**: Source integration guide.
*   **Proposed Changes**: The `POST /alerts` contract table, a `curl` example, a Home Assistant `rest_command` example, and the copy-paste tool or skill text that gives Hermes a way to create and cancel timers through `/alerts`.

##### 11. `docs/wake-word-training.md` (Create, S3)

*   **Type / Scope**: Training recipe.
*   **Proposed Changes**: Data used, the training steps, thresholds chosen, and the false-accept measurements. The recipe is versioned with the model file.

##### 12. `scripts/make_sounds.py` (Create, S1; Modify, S4)

*   **Type / Scope**: Tool that generates audio assets.
*   **Proposed Changes**: S1: writes `web/public/beep.wav` (0.3 s, 440 Hz sine). S4: writes `web/public/chime.wav` (0.4 s, 880 Hz sine with a short decay).

#### Backend (`backend/`)

##### 13. `backend/pyproject.toml`, `backend/uv.lock`, `backend/.python-version` (Create, S1)

*   **Type / Scope**: Python project, lock file and version pin (3.11).
*   **Proposed Changes**: Runtime dependencies: FastAPI, uvicorn with websockets, httpx, pydantic and pydantic-settings, numpy, faster-whisper, and `kokoro-onnx` (with `onnxruntime`; `onnxruntime-gpu` only if the CPU path is too slow). Chosen over the PyTorch `kokoro` package because it does not bring PyTorch into the image, so it avoids a possible cuDNN version conflict with CTranslate2 and keeps the image smaller, and because it runs on the CPU, which removes GPU-lock contention (unverified; slice 1 measures it). WAV bytes are written with the standard-library `wave` module from the int16 samples. The Kokoro model and voices files are downloaded to the model cache on first start. Development: pytest, pytest-asyncio, pytest-cov, ruff, mypy. A `gpu` pytest marker. Entry point `blob = blob.main:run`, where `run()` starts uvicorn with `HOST` and `PORT`.

##### 14. `backend/blob/__init__.py` (Create, S1)

*   **Type / Scope**: Package marker with `__version__`.
*   **Proposed Changes**: One version string, bumped when the WebSocket protocol changes. It is the value sent in `hello_ok` and injected into the page at build for the reload guard.

##### 15. `backend/blob/config.py` (Create, S1; Modify, S2 to S4)

*   **Type / Scope**: Settings.
*   **Proposed Changes**: S1: a settings class that reads the variables in the Configuration table and validates them at startup (including `HOST`, `PORT`, `DB_PATH`, `STATIC_DIR`, the Hermes variables, timeouts, `NO_SPEECH_MAX`, `SILENCE_RMS`, `TTS_MAX_CHARS`, `RETENTION_DAYS`). S2: `DEVICES_PATH`, `ALERT_TOKEN`, `DEVICE_TOKEN`. S3: `FOLLOWUP_MAX`, `FOLLOWUP_LISTEN_S`, `LISTEN_NO_SPEECH_S`. S4: `QUIET_HOURS`.

##### 16. `backend/blob/schemas.py` (Create, S1; Modify, S3 and S4)

*   **Type / Scope**: Message and payload models.
*   **Proposed Changes**: S1: Pydantic models for every S1 message in the protocol tables, including `hello_ok`, `pong`, `utterance` with `dur_ms` and `tail_silence_ms`; the `turn_done` reasons (including `tts_fail`) and `timeout_kind` as enums; the conversation states as an enum; the error codes `busy`, `bad_message` and `not_ready`. S3: `wake` and the `followup` field of `tts`. S4: `alert_read`, `alert_ack`, the alert payload and row models, the `snapshot.alerts[]` item shape, and the validation rules in the contract table.

##### 17. `backend/blob/textclean.py` (Create, S1)

*   **Type / Scope**: Text helpers.
*   **Proposed Changes**: `clean_for_speech(text)` removes markdown markers, emoji and URLs and collapses whitespace. `truncate_for_speech(text, max_chars)` cuts at the last sentence end before the limit, else at the last space, and reports the cut so `turn.py` can log it. A helper `ends_with_question(text)` ignores trailing quotes and whitespace (used for `followup`, S3).

##### 18. `backend/blob/voices.py` (Create, S1)

*   **Type / Scope**: Language to voice map and fallback lines.
*   **Proposed Changes**: `voice_for(lang)` implements the dictionary (`ca`, `es`, `en`, anything else is `es`). Constants for the fixed fallback line per language (`es`, `en`; Catalan uses the Spanish line).

##### 19. `backend/blob/gpu.py` (Create, S1)

*   **Type / Scope**: GPU lock.
*   **Proposed Changes**: One `asyncio.Lock` and `run_gpu(fn, *args)` that takes the lock and runs `fn` in a worker thread. The await is shielded and the lock is released only when the thread returns, so a cancelled caller cannot let a second model call start while the first still runs.

##### 20. `backend/blob/stt.py` (Create, S1)

*   **Type / Scope**: Speech to text.
*   **Proposed Changes**: Load the model named by `STT_MODEL` with `STT_COMPUTE`. `stt(audio, lang=None)` takes 16 kHz mono float samples (converted from the PCM bytes), runs one pass with language auto-detect and the voice-activity filter on, and returns `{text, lang, no_speech_prob}`. A function `is_no_speech(segments, limit)` applies the mean-over-segments rule. `warmup()` transcribes `fixtures/short_es.wav` with `vad_filter=False` so the model call is not skipped.

##### 21. `backend/blob/tts.py` (Create, S1)

*   **Type / Scope**: Text to speech.
*   **Proposed Changes**: Load `kokoro-onnx` on `KOKORO_DEVICE` (`cpu` by default, `cuda` if slice 1 shows the CPU is too slow). `tts(text, lang)` picks the voice with `voice_for`, synthesises the whole text and returns WAV bytes written with `wave`, at the model's sample rate (24 kHz expected; confirmed in S1). `prerender_fallbacks()` renders the fallback line for each language once and keeps the bytes in memory. `warmup()` synthesises one short phrase.

##### 22. `backend/blob/hermes.py` (Create, S1)

*   **Type / Scope**: Hermes client and history.
*   **Proposed Changes**: A constant `SYSTEM_MESSAGE`. `ask(user_text)` runs as a cancellable task: it builds the message list, posts to `HERMES_URL` `/v1/chat/completions` with `Authorization: Bearer`, `model` from `HERMES_MODEL` and `stream: false`, with `httpx` connect timeout `HERMES_CONNECT_S` and an `asyncio.timeout(HERMES_TOTAL_S)` around the call. It returns the reply text or raises a typed error: connect timeout and error status map to `hermes_fail`, the total timeout to `timeout`, a cancelled task to `cancel`. In `session` mode it sends `X-Hermes-Session-Id: blob-<unix time of the last rotation>` (rotated after `SESSION_IDLE_S` without a turn) and only the new message. In `replay` mode a history object keeps the last `HISTORY_PAIRS` completed pairs and drops them after `SESSION_IDLE_S`. Only the mode chosen by the S0 test is built first. Nothing from failed, cancelled or fallback turns is stored.

##### 23. `backend/blob/db.py` (Create, S1; Modify, S4)

*   **Type / Scope**: SQLite access.
*   **Proposed Changes**: S1: open the database in default journal mode with one writer, create the `turns` table with the columns in the Data section, set `PRAGMA user_version` to 1, and expose `insert_turn(...)` and `delete_turns_older_than(days)`. Calls run in a thread. S4: add the `alerts` table and its data-access functions, and set `user_version` to 2.

##### 24. `backend/blob/turnlog.py` (Create, S1)

*   **Type / Scope**: Per-turn logging.
*   **Proposed Changes**: At turn end, print the timing line (one JSON object with the timing keys, reason and `timeout_kind`, no text) to standard output and insert the full row into `turns`. Also prints `client_event` messages as JSON lines (`kind: client_event`) and does not persist them.

##### 25. `backend/blob/turn.py` (Create, S1; Modify, S3 and S4)

*   **Type / Scope**: Turn manager and pipeline.
*   **Proposed Changes**: S1: holds `current_turn` and the conversation state. `start(device)` returns `busy` if a turn is open. `submit_utterance(turn, pcm, dur_ms, tail_silence_ms)` runs the pipeline in the Technical Plan: speech to text, empty check, Hermes, clean and truncate, text to speech, send audio, `turn_done`. `cancel(turn)` sets the cancel flag and closes the Hermes connection; the pipeline checks the flag after speech-to-text, after Hermes and before synthesis, and discards the result. A 30 s listening watchdog and a 120 s processing watchdog (from `utterance` arrival) end a stuck turn. A `done` flag makes `turn_done` go out exactly once. Every exit path records timings (`stt_ms`, `hermes_ms`, `tts_ms`, `first_audio_ms`, `sc1_ms`) and `timeout_kind`. S3: the wake entry point (from a device whose `wake` flag is true) and the follow-up chain: `tts.followup` is set when the reply ends with `?`, with the `FOLLOWUP_MAX` counter per chain (reset when a turn that does not end with `?` finishes, or after 10 s of idle). The 6 s limit belongs to the page. S4: the pre-Hermes timer rule, only if entry 31 is built.

##### 26. `backend/blob/hub.py` (Create, S1; Modify, S2 to S4)

*   **Type / Scope**: WebSocket hub.
*   **Proposed Changes**: S1: tracks connected clients, handles `hello` and replies `hello_ok` with the server version, dispatches `tap`, `utterance`, `cancel`, `ping` (answered with `pong`) and `client_event`, sends `snapshot` and `state` to all clients and `tts` and `turn_done` to the client that started the turn. Pairs the JSON header of `utterance` with the binary frame that follows it, and writes each outgoing `tts` header and its frame together under a per-connection lock. Applies the input-condition rules (message before `hello` closes with 4400; bad message; wrong turn; frame over 1 MB; `not_ready`). A WebSocket close releases the lock and cancels the pipeline. S2: the token check on `hello` (close code 4401). S3: `wake`. S4: `alert_read` and `alert_ack`, and `snapshot.alerts[]`.

##### 27. `backend/blob/main.py` (Create, S1; Modify, S2 and S4)

*   **Type / Scope**: Application entry.
*   **Proposed Changes**: S1: builds the FastAPI app. Startup order: open the database and mark the app alive; load the models, run the warm-ups and render the fallbacks in a background task; mark ready. Routes: `/healthz` (always 200, body with `alive`, `ready`, `hermes_reachable`), `/readyz` (503 until ready), `/ws`, and the built page as static files from `STATIC_DIR`. A background task checks Hermes's `GET /health` every 30 s with a 3 s timeout. A task deletes old turns at startup and every 24 h. S2: `Cache-Control: no-cache` on `index.html`, and the `/device-config` route (entry 29). S4: mounts the alerts router and starts the scheduler.

##### 28. `backend/blob/auth.py` (Create, S2)

*   **Type / Scope**: Token checks.
*   **Proposed Changes**: A function that compares a presented token with `DEVICE_TOKEN` in constant time, used by the hub (close code 4401) and as a dependency on `GET /device-config` (401). A second dependency checks `Authorization: Bearer` against `ALERT_TOKEN` for the alerts routes.

##### 29. `backend/blob/devices.py` and `config/devices.example.json` (Create, S2)

*   **Type / Scope**: Per-device flags and the example file.
*   **Proposed Changes**: `devices.py` reads `DEVICES_PATH` and serves `GET /device-config?device=<name>` (protected by the device token) returning that device's `sound` and `wake` flags plus `quiet_hours` (S4), `followup_listen_s` and `listen_no_speech_s` (S3). Unknown devices get `sound=false` and `wake=false`. A malformed file is reported at startup. The example file has `tablet` with `sound=true, wake=true` and `desktop` with `sound=false, wake=false`. `turn.py` reads the `wake` flag through a small function here.

##### 30. `backend/blob/alerts.py` (Create, S4)

*   **Type / Scope**: Alerts API and scheduler.
*   **Proposed Changes**: The router for `POST`, `DELETE` and `GET /alerts` with the contract table in the Technical Plan. The scheduler finds the earliest `pending` `fire_at`, sleeps until then (cap 250 ms), and activates due timers. Startup fires overdue timers once, marked `late`. Every change broadcasts a new `snapshot`.

##### 31. `backend/blob/timer_rule.py` (Create, S4, conditional)

*   **Type / Scope**: Fallback timer parser, built only if the S0 test shows Hermes cannot create timers.
*   **Proposed Changes**: A function that matches the words and numbers in the Technical Plan (Spanish, Catalan and English units) and returns a request to create a timer with key `timer-<unix time>`. `turn.py` runs it before Hermes and speaks the pre-rendered confirmation.

##### 32. `backend/scripts/stt_cli.py` and `backend/scripts/tts_cli.py` (Create, S1)

*   **Type / Scope**: Command-line tools.
*   **Proposed Changes**: `stt_cli.py` reads a WAV file and prints the text, the detected language, the no-speech probability and the time (used on a real clip, an empty file and a silence file). `tts_cli.py` takes text and a language, writes a WAV and prints the voice used, the sample rate and the time (confirms Kokoro's voices and language codes).

##### 33. `backend/scripts/e2e_turn.py` (Create, S1; Modify, S2)

*   **Type / Scope**: Scripted client.
*   **Proposed Changes**: Connects to `/ws`, sends `hello`, `tap`, then `utterance` with a WAV file, and prints each message until `turn_done`. `--cancel-after` tests cancel. S2 adds `--token` for the device token.

##### 34. `backend/scripts/timings_report.py` (Create, S1)

*   **Type / Scope**: Report tool.
*   **Proposed Changes**: Reads the `turns` table and prints the median and the 90th percentile of `sc1_ms`, plus counts by reason and by detected language.

##### 35. `backend/tests/conftest.py` and `backend/tests/fixtures/` (Create, S1)

*   **Type / Scope**: Test setup and audio fixtures.
*   **Proposed Changes**: `pytest-asyncio` in `auto` mode and the `gpu` marker. Fixtures: `short_es.wav`, `short_en.wav`, `short_ca.wav`, `silence.wav` (recorded by the author; they are not committed if they contain personal voice, and the tests that need them are skipped when missing).

##### 36. `backend/tests/fakes/fake_hermes.py` (Create, S1)

*   **Type / Scope**: Test double.
*   **Proposed Changes**: A small HTTP app that mimics `/v1/chat/completions` with switches for a normal reply, a delayed reply, an error status, and a reply with markdown, emoji and a URL. It records the request headers and bodies so tests can check them.

##### 37. Backend unit tests (Create, S1; Modify, S2 to S4)

*   **Type / Scope**: Unit tests.
*   **Proposed Changes**: `test_textclean.py` (markdown, emoji, URL, whitespace; truncation with and without a sentence end; the `?` check) and `test_voices.py` (the map, unknown languages, overrides). `test_config.py` (defaults, required variables, validation). `test_hermes.py` (message list and headers, `X-Hermes-Session-Id` and its rotation after 5 minutes, the replay fallback with the cap of 6 pairs and an injected clock, no storage of failed turns, connect timeout to `hermes_fail`, total timeout to `timeout`, an error status to `hermes_fail`, a cancelled task to `cancel`). `test_gpu.py` (cancelling the awaiting coroutine mid-call; a second call waits until the first thread finishes). `test_turn.py` (happy path ends `ok`; empty speech ends `empty` with zero Hermes calls; Hermes failure plays the fallback; `stt_fail` fallback language; `tts_fail` plays no spoken audio; a second `tap` or `wake` gets `busy`; `cancel` in each state ends the turn and discards the result between stages; the 30 s listening and 120 s processing watchdogs with an injected clock and the right `timeout_kind`; no fallback for `listen`; a WebSocket close frees the lock; `turn_done` sent exactly once; the `tts_max_chars` cut is logged; S3 adds a reply ending with `?`, the `FOLLOWUP_MAX` guard and a zero-length `utterance` ending `empty`; S4 adds the timer rule when built). `test_hub.py` (`snapshot` on connect, `hello_ok` and version mismatch, ordering of the `tts` header and frame, `busy`, `not_ready`, `ping`/`pong`, a 1 MB frame, audio with no open turn, `bad_message`, a message before `hello`, `wake` from a `wake=false` device; S2 adds a wrong token closing with 4401; S4 adds alerts in the snapshot and `alert_read` and `alert_ack`). `test_db.py` and `test_turnlog.py` (schema and `user_version`, turn insert, deletion of rows older than 14 days, an S1 file opened by S4 code, standard output carries no text). `test_main.py` (the `/healthz` and `/readyz` states and the startup order; `index.html` served with `Cache-Control: no-cache` from S2). `test_devices.py` and `test_auth.py` (S2: correct and wrong tokens, missing header, unknown device false and false, malformed `devices.json`, 401 on `/device-config`).

##### 38. `backend/tests/test_speech_gpu.py` (Create, S1)

*   **Type / Scope**: GPU smoke tests, marked `gpu`.
*   **Proposed Changes**: Loads both models, transcribes a short fixture, synthesises a short phrase, and checks the outputs are non-empty. Skipped in CI.

##### 39. `backend/tests/test_alerts_api.py`, `backend/tests/test_scheduler.py` (Create, S4)

*   **Type / Scope**: API and scheduler tests.
*   **Proposed Changes**: Every rule in the contract table (upsert, required fields, defaults including `source=timer` being `urgent`, 422 cases, `in_s`, past `fire_at`, the cap of 20 and 429, the `acked` ignore and re-raise rules, the same timer twice, idempotent `DELETE`, `GET`, bad token). Scheduler with an injected clock: a pending timer activates at `fire_at`; overdue timers on startup fire once marked `late`, except when `ttl_s` has passed; rows are removed after `ttl_s` and 24 h after ack; a restart keeps open alerts; a new timer added while the scheduler sleeps is seen within 250 ms.

##### 40. `backend/tests/test_timer_rule.py` (Create, S4, conditional)

*   **Type / Scope**: Unit tests, only if entry 31 is built.
*   **Proposed Changes**: Spanish, Catalan and English phrases with digits and number words, minutes, seconds and hours; phrases that must not match.

#### Page (`web/`)

##### 41. `web/package.json`, `web/package-lock.json`, `web/tsconfig.json`, `web/vite.config.ts`, `web/eslint.config.js`, `web/vite-env.d.ts` (Create, S1; Modify, S2 and S3)

*   **Type / Scope**: Frontend project, build and lint.
*   **Proposed Changes**: S1: scripts `dev`, `build`, `lint`, `typecheck`, `test`. Dependencies: three.js. Development: Vite, TypeScript, vitest with a `jsdom` environment, eslint. `vite-env.d.ts` declares the GLSL `?raw` imports so the typecheck passes. The dev server proxies `/ws`, `/device-config`, `/healthz`, `/readyz` and `/alerts` to the backend. The AudioWorklet is bundled. The page version is injected from the backend `__version__` at build. S2: PWA manifest handling. S3: `onnxruntime-web` and `@ricky0123/vad-web`, and a copy rule for their wasm assets.

##### 42. `web/index.html` (Create, S1; Modify, S2)

*   **Type / Scope**: Page shell.
*   **Proposed Changes**: S1: a full-window canvas, a fault-line element, a diagnostics overlay container, a black background. S2: the manifest link and the theme colour.

##### 43. `web/src/main.ts` (Create, S1; Modify, S2 to S4)

*   **Type / Scope**: Page entry.
*   **Proposed Changes**: Wires the parts: reads the config and token, opens the WebSocket, creates the renderer, the audio and the turn controller, and ties `snapshot` to the view computation. S2: Wake Lock and the version reload guard. S3: the wake detector. S4: the alert tables and chime.

##### 44. `web/src/config.ts` (Create, S1; Modify, S2 and S3)

*   **Type / Scope**: Page settings.
*   **Proposed Changes**: S1: a static default device name and flags, and the recording cap (15 s). S2: the device name from `localStorage` (set by `token.ts`) and the flags from `GET /device-config`. S3: `followup_listen_s` and `listen_no_speech_s` from the same call. S4: `quiet_hours`.

##### 45. `web/src/protocol.ts` and `web/src/protocol.test.ts` (Create, S1; Modify, S3 and S4)

*   **Type / Scope**: Shared message types, written by hand to match `schemas.py`.
*   **Proposed Changes**: TypeScript types for every message. The test compares the message names to a JSON list generated from the Pydantic models, so the two cannot drift silently. S3 and S4 add their messages.

##### 46. `web/src/ws.ts` (Create, S1; Modify, S2)

*   **Type / Scope**: WebSocket client.
*   **Proposed Changes**: S1: connect, send `hello`, send the typed client messages, parse server messages and pair a `tts` header with its binary frame. Reconnect with a backoff of 1 to 30 s, 20 s pings, no retry on close code 4401. S2: the token.

##### 47. `web/src/state.ts` (Create, S1; Modify, S4)

*   **Type / Scope**: Client state and view.
*   **Proposed Changes**: S1: holds the last `snapshot`. `computeView(snapshot, localPlayback, overlay)` implements the precedence: offline, then the error overlay, then the conversation turn (with `speaking` kept until local playback ends), then idle. The overlay is set on `turn_done` with a reason other than `ok`, `empty` or `cancel`, and cleared when local playback is empty and 3 s have passed. A mirror that never played audio shows `speaking` from the snapshot and clears it on the next snapshot. S4: the top alert (sorted by urgency, then age) and the hold while a turn is open.

##### 48. `web/src/turn-client.ts` (Create, S1; Modify, S3)

*   **Type / Scope**: Client turn controller.
*   **Proposed Changes**: S1: the explicit client turn table. On a tap in `idle` it sends `tap`; on the first `state` with `conv = listening` and a turn id it opens the microphone (never before); on `error{busy}` it ignores the tap and flashes briefly; on a double tap it ignores the second until `state` arrives; on microphone denial it sends `cancel` and sets the fault line; on the stop tap or the 15 s cap it sends `utterance` (with `dur_ms` and `tail_silence_ms`). S3: follow-up (`wake{followup}` after playback ends) and the 6 s and 8 s no-speech limits (sends a zero-length `utterance`).

##### 49. `web/src/taps.ts` (Create, S1; Modify, S2 and S4)

*   **Type / Scope**: Gesture handling.
*   **Proposed Changes**: S1: implements the tap table (first matching row wins) except the audio-locked and alert rows, the fallback-audio row, and the long press. S2: the audio-locked row. S4: the alert row (`alert_read`, play, then `alert_ack` after playback ends; keep the alert and play the beep if synthesis fails).

##### 50. `web/src/audio/capture.ts` and `web/src/audio/worklet/capture-processor.ts` (Create, S1; Modify, S3)

*   **Type / Scope**: Microphone capture.
*   **Proposed Changes**: S1: open `getUserMedia` only for a turn, resample to 16 kHz mono in the worklet, collect signed 16-bit samples, stop the tracks when finished, enforce the 15 s cap, compute `tail_silence_ms` from 20 ms RMS windows against `silence_rms`, and expose a level through an `AnalyserNode` for the listening deformation. The capture and playback share the one `AudioContext`. S3: a single always-open stream shared with the wake detector and the voice-activity detector (when the device has `wake=true`).

##### 51. `web/src/audio/playback.ts` (Create, S1; Modify, S2)

*   **Type / Scope**: Audio playback.
*   **Proposed Changes**: S1: `play(wavBytes, turn)` decodes with `decodeAudioData` (which resamples to the context rate) and schedules with `nextT = max(now, nextT) + duration`. `stopAll()`, stale-turn dropping, an `AnalyserNode` on the output for the speaking pulse, the local beep (played on `turn_done.reason == tts_fail` and when an alert cannot be read), and fallback audio treated as a playing source. S2: the audio-locked state and `resume()` on every tap.

##### 52. `web/src/audio/chime.ts` (Create, S4)

*   **Type / Scope**: Alert chime.
*   **Proposed Changes**: Plays `chime.wav` once per alert on a client with `sound=true` when an alert becomes active, holds it until a turn ends, skips it when the alert is gone, and mutes it inside `quiet_hours`.

##### 53. `web/src/render/blob.ts` (Create, S1; Modify, S2 and S4)

*   **Type / Scope**: Renderer.
*   **Proposed Changes**: S1: a three.js scene with one fullscreen quad and a shader material. Uniforms: time, resolution, colour, motion parameters, mic or playback level, brightness, shape A, shape B and the morph mix. S2: the fixed 0.75 render scale, the 30 fps idle cap and `webglcontextlost` recovery. S4: the shape morph. Frame time goes to the diagnostics view only.

##### 54. `web/src/render/blob.frag` and `web/src/render/blob.vert` (Create, S1; Modify, S4)

*   **Type / Scope**: Shaders.
*   **Proposed Changes**: S1: raymarched signed distance field with a bounding-sphere early exit, a procedural dark environment, a fresnel rim, and a metal look (a reflection of the environment tinted by the state colour). The sphere breathes and deforms with the level. S4: the triangle and square distance functions and `mix(sdfA, sdfB, t)` with the shortened march step.

##### 55. `web/src/render/tables.ts` (Create, S1; Modify, S4)

*   **Type / Scope**: Data tables.
*   **Proposed Changes**: S1: conversation state to colour and motion (five rows). S4: alert source and urgency to shape, colour (green for `info`, red for `urgent`) and pulse rate (`urgent` is twice `info`), with the default entry for unknown sources.

##### 56. `web/src/diag.ts` (Create, S1; Modify, S3)

*   **Type / Scope**: Diagnostics view.
*   **Proposed Changes**: S1: a long press shows the page version, the socket and microphone status, `hermes_reachable` (from `/healthz`), the last turn's timings, the frame time, and a button that copies a text report. S3: the wake-word score.

##### 57. `web/src/fault.ts` (Create, S1; Modify, S2 and S3)

*   **Type / Scope**: Fault line.
*   **Proposed Changes**: S1: one dim text line naming the current fault (microphone denied, socket down). S2: "audio locked", which stays on until audio is unlocked. S3: wake-word faults. Hermes down is not shown here (it appears only in the diagnostics view).

##### 58. `web/public/beep.wav` (Create, S1) and `web/public/chime.wav` (Create, S4)

*   **Type / Scope**: Static audio files generated by `scripts/make_sounds.py`.
*   **Proposed Changes**: `beep.wav` is played locally when speech output fails or an alert cannot be read. `chime.wav` is the alert chime.

##### 59. Page unit tests (Create, S1; Modify, S2 to S4)

*   **Type / Scope**: vitest tests.
*   **Proposed Changes**: `state.test.ts` (the view precedence including the error overlay and its 3 s clear; S4: the top alert and the hold). `taps.test.ts` (every row of the tap table; S2: audio locked; S4: alert rows). `turn-client.test.ts` (the client turn table: busy, double tap, microphone denial, the 15 s cap; S3: follow-up and the no-speech limits). `playback.test.ts` (the `nextT` schedule, stale-turn dropping, stop on cancel, the beep on `tts_fail`). `ws.test.ts` (header and frame pairing, reconnect backoff, no retry on 4401). `capture.test.ts` (the 15 s cap, `tail_silence_ms` from a synthetic buffer, resampling). `fault.test.ts`. S2: `token.test.ts` (hash parsing and removal), `version.test.ts` (reload at most once per server version). S4: `chime.test.ts` (quiet hours, once per alert).

#### Container and deployment (S2)

The cluster was inspected read-only on 2026-11-12: two Talos nodes (`kube0` control plane, `kube1` worker) on Kubernetes v1.34.0; `kube1` offers 1 GPU (`nvidia.com/gpu`) and 32 GB of RAM; `ingress-nginx` and `traefik` namespaces both exist, and both IngressClasses (`nginx` and `traefik`) are served by Traefik (`traefik.io/ingress-controller`); two StorageClasses are marked default (`ceph-block` and `longhorn`); cert-manager and Argo CD are installed. From that, the plan uses: namespace `blob` (does not exist yet); StorageClass `ceph-block` named explicitly in the PVC (the existing Hermes chart does the same, and two defaults make an unnamed claim ambiguous); a 10 Gi PVC; GPU resource `nvidia.com/gpu: 1`; `ingressClassName: traefik`; container port 8000 with a Service on port 80; models and the database mounted at `/data`; the devices file from a ConfigMap key `devices.json` mounted at `/config/devices.json` (`DEVICES_PATH`). Still `ASSUMED`: the CUDA version the node driver supports, and Traefik's WebSocket idle timeout. The host name and the cert-manager issuer name stay `TODO(author)`. The readiness and startup probes use `/readyz`, the liveness probe uses `/healthz`.

##### 60. `Dockerfile` and `.dockerignore` (Create, S2)

*   **Type / Scope**: Container image.
*   **Proposed Changes**: Multi-stage build. Stage one builds the page with Node. Stage two uses an `nvidia/cuda` CUDA 12 runtime image with cuDNN, matching the pinned CTranslate2 version (`ASSUMED`: CUDA 12 and cuDNN 9; the tag is set when `ctranslate2` is pinned and must not be newer than the CUDA version the node driver supports, which `nvidia-smi` on the node shows). It installs `espeak-ng` as a system package (Kokoro's phonemizer needs it unless the `espeakng-loader` Python package bundles it; unverified), installs `uv` and the backend, copies `web/dist`, runs as non-root user 10001, and starts `blob`. Models are not copied in; the cache path points at the PVC mount. This is also where S2 confirms that both libraries load in one image.

##### 61. `deploy/pvc.yaml` (Create, S2)

*   **Type / Scope**: Kubernetes manifest.
*   **Proposed Changes**: In namespace `blob`: a 10 Gi PVC with `storageClassName: ceph-block` (named explicitly because the cluster has two default classes; neither is NFS, which SQLite needs to avoid). Mounted at `/data`; the model cache is `/data/models` and the database is `/data/blob.db`.

##### 62. `deploy/deployment.yaml` (Create, S2)

*   **Type / Scope**: Kubernetes manifest.
*   **Proposed Changes**: `replicas: 1`, `strategy: Recreate`, one container listening on port 8000 with a GPU request `nvidia.com/gpu: 1` (`ASSUMED`: NVIDIA and its device plugin), the PVC mount at `/data`, the devices ConfigMap mounted at `/config/devices.json`, a non-root user 10001, environment from the config map and secret, a liveness probe on `/healthz`, a readiness probe on `/readyz`, and a `startupProbe` on `/readyz` with a long failure threshold.

##### 63. `deploy/service.yaml` (Create, S2)

*   **Type / Scope**: Kubernetes manifest.
*   **Proposed Changes**: A cluster-internal Service on port 80 to the container port 8000. Sources reach `/alerts` through it.

##### 64. `deploy/ingress.yaml` (Create, S2)

*   **Type / Scope**: Kubernetes manifest.
*   **Proposed Changes**: Routes the internal host with a `/` prefix rule (so `/alerts` is reachable and protected by `ALERT_TOKEN`) through `ingressClassName: traefik`, with TLS from the certificate. Traefik passes WebSocket upgrades without annotations; the client pings every 20 s, which is below Traefik's default idle timeout of 180 s (unverified; check in the entrypoint settings). The host name is `TODO(author)`.

##### 65. `deploy/certificate.yaml` (Create, S2)

*   **Type / Scope**: cert-manager resource.
*   **Proposed Changes**: A Certificate for the host using an existing DNS-01 issuer (the issuer name and host are `TODO(author)`).

##### 66. `deploy/configmap.yaml` and `deploy/secret.example.yaml` (Create, S2)

*   **Type / Scope**: Kubernetes manifests.
*   **Proposed Changes**: Non-secret settings (model names, timeouts, voices) and the `devices.json` key in the config map. The example secret lists `ALERT_TOKEN`, `DEVICE_TOKEN` and `HERMES_KEY` with empty values. The real secret is created by hand and not committed.

##### 67. `deploy/README.md` (Create, S2)

*   **Type / Scope**: Deploy notes.
*   **Proposed Changes**: The order of `kubectl apply -f` commands, the placeholders to fill, and the check commands.

##### 68. `web/public/manifest.webmanifest`, `web/public/icons/icon-192.png`, `web/public/icons/icon-512.png` (Create, S2)

*   **Type / Scope**: PWA assets.
*   **Proposed Changes**: Name, `display: fullscreen`, `start_url: /` with no secret in it, black theme and background colours. No service worker at first. The icons are a flat blob drawing generated once by a script or exported by hand.

##### 69. `web/src/token.ts` (Create, S2)

*   **Type / Scope**: Token and device name.
*   **Proposed Changes**: Reads `#t=TOKEN&device=NAME` once, stores both in `localStorage`, removes the hash with `history.replaceState`, and returns the stored token and device name for `hello` and for `GET /device-config`.

##### 70. `web/src/wakelock.ts` and `web/src/version.ts` (Create, S2)

*   **Type / Scope**: Wake Lock and version guard.
*   **Proposed Changes**: `wakelock.ts` requests the lock and requests it again on `visibilitychange`. `version.ts` reloads at most once per server version (remembered in `localStorage`) when `hello_ok` carries a different version; a second mismatch shows the fault cue and stops.

#### Hands-free (S3)

Parameters of this slice (audio chunk size, score threshold, debounce, cooldown) are set after the tablet test and recorded in `docs/spikes/tablet-test.md`.

##### 71. `web/src/vad.ts` (Create, S3)

*   **Type / Scope**: End-of-speech detection.
*   **Proposed Changes**: Wraps `@ricky0123/vad-web`, preloaded paused, runs only while listening. Silence of 0.6 to 0.8 s ends the utterance. `listen_no_speech_s` (8 s) with no speech or 15 s in total ends it, and the follow-up window is `followup_listen_s` (6 s). `turn-client.ts` acts on its results.

##### 72. `web/src/wake/detector.ts` and `web/src/wake/worker.ts` (Create, S3)

*   **Type / Scope**: Wake-word detector.
*   **Proposed Changes**: An openWakeWord pipeline in a Web Worker using ONNX Runtime Web with one thread (microWakeWord if the tablet test prefers it). It receives audio from the shared worklet and posts detections with a score. Whether to port the pipeline or use an existing package is decided in the tablet test.

##### 73. `web/src/wake/wake-gate.ts` and `web/src/wake/wake-gate.test.ts` (Create, S3)

*   **Type / Scope**: Pure gating logic and its test.
*   **Proposed Changes**: Allows the wake word only in `idle`, mutes it during playback plus 0.5 s and during follow-up listening, and opens and closes the follow-up window. The test covers each rule.

##### 74. `web/public/models/` model files (Create, S3)

*   **Type / Scope**: Model files, named after the tablet test.
*   **Proposed Changes**: The ONNX model files for the stock phrase (pipeline tests) and for the custom "hey blob" model. A `README.md` in the folder records the licence of each file and how the custom model was trained.

### Verification Plan

*   **Compilation/Build**: Backend: `uv sync` then `uv run python -c "import blob"`. Page: `npm ci` and `npm run build` in `web/`. Container (S2): `docker build .`.
*   **Unit Tests**: `uv run pytest -m "not gpu"` in `backend/`; `npm test` in `web/`.
*   **GPU tests (local only)**: `uv run pytest -m gpu` on the machine with the GPU.
*   **Static Analysis & Linting**: `uv run ruff check`, `uv run ruff format --check`, `uv run mypy blob`; `npm run lint` and `npm run typecheck`.
*   **Test Coverage Requirement**: At least 80% line coverage, enforced with `--cov-fail-under=80`, for `textclean.py`, `voices.py`, `hermes.py`, `turn.py`, `hub.py`, `db.py`, `auth.py`, `alerts.py` and (when built) `timer_rule.py`. Model wrappers (`stt.py`, `tts.py`) and the shader are excluded and covered by the GPU smoke test and the manual exit tests.
*   **E2E/Integration**: `backend/scripts/e2e_turn.py` against the real backend with the fake Hermes for repeatable turns, and against the real Hermes for the S1 exit test. The numbered S1 exit test is in `docs/testing/exit-tests.md` (entry 8) and is the pass condition for slice 1. It covers: the 10 spoken turns ending `ok`; a tap on silence (no Hermes request); a Hermes failure (grey overlay, spoken fallback, idle within the 75 s timeout plus the fallback audio); stop and cancel taps; the history check (a follow-up question within 5 minutes is answered with context, after 5 minutes idle it is not); each of the five states shows its row of the state table; `nvidia-smi` peak memory under 8 GB; the SC1 median from `timings_report.py`.
*   **Later slice exit tests**: in `docs/testing/exit-tests.md`.

--------------------------------------------------------------------------------

<!-- Provenance: Indicates initial structural drafting via EGM. -->

*Drafted with EGM*
