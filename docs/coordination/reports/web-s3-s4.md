# Report: web page S3 (hands-free) + S4 (alerts)

Branch `t3/blob-web-s3-s4`, on top of `main` (`f116c4e`). Conventional commits, each with the
Claude trailer; the last one adds this report. Decisions and honest limits are in
`docs/notes/web-s3-s4.md`; the wake word training attempt is in `docs/wake-word-training.md`.

## What was built

S4 (alerts):

- `state.ts`: view `'alert'`, `topAlert()` (urgent, then oldest, then key), `turnActive()`;
  precedence offline > error overlay > turn > alert > idle; alerts are held hidden during a turn.
- `taps.ts`: alert row (`read_alert`) after audio-locked, plus "ignore while a read is pending".
- `alert-reader.ts`: `alert_read`, play the `tts{alert: key}` WAV, `alert_ack` after playback
  ends; on `error` (bad_message or not_ready), no frame within 10 s, or an undecodable WAV: keep
  the alert, play the beep, send nothing.
- `render/tables.ts`: alert table (timer triangle, any other source square, info green, urgent
  red, `URGENT_PULSE_FACTOR = 2`). `render/morph.ts`: 0.8 s eased morph state.
- `render/blob.frag`: `sdTriPrism`, `sdRoundBox`, `alertShapes`, `pickShape`, `map()` (step
  shortened to about 0.7 while morphing, inside `map()`). `main()` and `env()` untouched.
  `render/blob.ts`: shape uniforms and the alert look.
- `audio/chime.ts` (once per alert, shared chime for alerts arriving together, held during a
  turn, skipped if gone, muted in `quiet_hours` local time); `Playback.effect()`;
  `public/chime.wav` from `scripts/make_sounds.py` (880 Hz, 0.4 s, 0.12 s decay).
- `/device-config` flags now used: `sound` (chime), `wake` (hands-free), `quiet_hours`,
  `followup_listen_s`, `listen_no_speech_s`, `silence_rms`.

S3 (hands-free):

- `audio/capture.ts`: `openShared()` keeps one stream and one AudioWorklet for the wake word and
  the VAD on a `wake=true` device; the worklet posts 20 ms blocks.
- `wake/oww.ts` (openWakeWord feature pipeline, ported), `wake/models.ts`, `wake/worker.ts`
  (one module worker, onnxruntime-web wasm with one thread, running both openWakeWord and
  vad-web's Silero v5), `wake/detector.ts` (page side, `/models/wake.json` for model, phrase,
  threshold), `wake/messages.ts`.
- `wake/wake-gate.ts`: `wakeAllowed()` (idle only, muted during playback + 0.5 s and during
  follow-up) and `FollowUp`.
- `vad.ts`: `Endpointer` (700 ms silence, 90 ms minimum speech, `listen_no_speech_s`,
  `followup_listen_s`, 15 s) with an injected clock, and `VadController`.
- `turn-client.ts`: `startTurn('tap' | 'wake' | 'followup')`, VAD-ended utterances,
  zero-length utterance on no speech, a refused wake frees the client.
- `main.ts`: wiring; wake score, detections and VAD state in diagnostics; wake faults in the
  fault line and as `client_event`.
- `public/models/`: `melspectrogram.onnx`, `embedding_model.onnx`, `hey_jarvis_v0.1.onnx`
  (openWakeWord v0.5.1, CC BY-NC-SA 4.0), `silero_vad_v5.onnx` (MIT), `wake.json`, `README.md`
  with licences and hashes.
- Dependencies: `onnxruntime-web@1.31.1`, `@ricky0123/vad-web@0.0.31`. npm blocked the
  `protobufjs` postinstall script (a dependency of onnxruntime-web); nothing needs it, so it
  was not allowed. `npm audit --omit=dev`: 0 vulnerabilities. The 14.8 MB onnxruntime wasm is
  loaded only on `wake=true` devices (the hands-free code is a dynamic import).

Tests and docs: `e2e/mock-backend.ts` (S3/S4 messages, `/alerts`), `e2e/mics.ts`,
`e2e/fixtures/` (synthetic Kokoro clips and their generator), new specs `alerts`, `wake`, `vad`,
`no-speech`, alert screenshots, `docs/notes/web-s3-s4.md`, `docs/wake-word-training.md`, the
page section of `docs/testing/exit-tests.md`.

## Definition of Done

### 1. lint, typecheck, unit tests, build: PASS

In `web/`:

- `npm run lint`: exit 0, no output.
- `npm run typecheck`: exit 0, no output.
- `npm test`: `Test Files 17 passed (17)`, `Tests 136 passed (136)` (73 before).
- `npm run build`: `✓ built`; `index-*.js 559 kB` (three.js), `worker-*.js 79 kB`,
  `ort-wasm-simd-threaded-*.wasm 14.8 MB` (separate asset), `detector-*.js 0.8 kB`.

New unit tests: `state.test.ts` (alert precedence, hold, `topAlert` order), `taps.test.ts`
(alert rows, locked, read pending), `alert-reader.test.ts` (ack after playback, ignores other
keys, timeout, bad_message and not_ready, undecodable WAV, one read at a time),
`render/tables.test.ts`, `render/morph.test.ts`, `audio/chime.test.ts` (quiet hours incl.
midnight and malformed; once per alert; held during a turn; skipped if gone; re-raised; sound
false), `audio/playback.test.ts` (effect), `wake/wake-gate.test.ts` (every gate rule, follow-up
window), `vad.test.ts` (0.6 to 0.8 s silence, hysteresis, 8 s and 6 s no-speech, clicks, 15 s
cap, limits without frames, controller), `turn-client.test.ts` (wake, follow-up limits, VAD end
with audio, zero-length utterance without a frame, refused wake, tap-only device unchanged),
`wake/oww.models.test.ts` (the real ONNX models in Node: "hey jarvis" clip scores above 0.9,
the Python reference gives 0.999; a question clip stays below 0.1). `protocol.test.ts` needed
no change (S3/S4 messages were already typed).

### 2. Playwright: PASS against the mock (26 of 26); real backend NOT run

`MOCK_PORT=8797 npm run e2e` (8787 was taken by another session): `26 passed (2.5m)`.

| Spec | Flow | Real backend |
| --- | --- | --- |
| `alerts.spec.ts` | alert appears: view `alert`, `uShapeA` 1 (triangle), green `uColor`; urgent calendar goes on top, morph seen with `0 < uMix < 1`, then shape 2 (square), red; cleared: back to shape 0 | yes (needs `BLOB_ALERT_TOKEN`) |
| | two alerts ordering: oldest info first, urgent beats it, back after delete | yes |
| | tap reads: `alert_read{key}`, `tts{alert: key, turn: null}` + WAV, a source starts, view stays `alert`, `alert_ack` only after playback ends | yes |
| | alert during a turn: in the snapshot, view stays thinking/speaking, alert shown after `turn_done` | yes |
| | chime: once per alert on a `sound=true` device, not again on an update, held during a turn and played at its end | yes (`e2e-sound` must be `sound: true`) |
| | synthesis failure: `error bad_message`, beep, no `alert_ack`, alert stays | mock only |
| `wake.spec.ts` | fake mic plays synthetic Kokoro "Hey Jarvis. What time is it?"; models load in the worker; `wake{followup:false}` sent; no tap, utterance or binary frame before it; one `getUserMedia`; turn listens; the VAD sends the utterance (dur > 300 ms, with PCM) without a stop tap; tracks stay open | yes (`hf-wake` must be `wake: true`) |
| `vad.spec.ts` | tap turn on a hands-free device ends by itself after the spoken question; `tail_silence_ms` 500 to 1500 | yes (`hf-vad`) |
| `no-speech.spec.ts` | 8 s of silence: `utterance{dur_ms: 0}`, no binary frame, `turn_done empty` | yes (`hf-quiet`) |
| | follow-up: reply with `followup: true`, after playback the page sends `wake{followup: true}`, listens, zero-length utterance after 6 s, `turn_done empty`, no further wake | mock only |

Real backend command (not run, no backend instance available to me):
`BLOB_URL=http://host:port BLOB_TOKEN=<DEVICE_TOKEN> BLOB_ALERT_TOKEN=<ALERT_TOKEN> npx playwright test`,
with the e2e devices listed in `config/devices.json` (see the exit-tests page section).

Found and fixed on the way: the first shader version made the compiled shader about twice as
large; with SwiftShader the page stalled up to 1.1 s at load and two S1 specs (long press,
normal turn) failed, while `main` passed under the same machine load. `map()` now evaluates each
distance function once; all 16 S1/S2 specs pass again. Under heavy CPU load (my own training job
plus another session's Playwright run) the VAD spec once measured `tail_silence_ms` 4285 and the
alert-read spec hit a logging race (fixed); on the final run everything passed.

### 3. Screenshots: PASS (with honest notes)

`docs/screenshots/alert-timer-info-1280x800.png`, `alert-timer-urgent-1280x800.png`,
`alert-calendar-info-1280x800.png`, `alert-morph-1280x800.png` (captured at `uMix = 0.32`), from
`npm run screenshots` against the mock. The S1 state screenshots and icons that the same command
rewrites were reverted (the look session owns them). Notes: green and red read clearly; the
triangle's edges look sharper than "rounded"; the shapes look like glossy glass or plastic, not
liquid metal; the pulse was never seen at a real frame rate (SwiftShader about 10 fps).

### 4. exit-tests.md: PASS

New section "S3 and S4: page exit test (web)" between `## S1` and `## S2` in
`docs/testing/exit-tests.md`, inside `<!-- PAGE S3/S4 -->` markers. It is placed there on
purpose: the backend branch rewrote everything from `## S3` to the end of the file, so an edit
there would conflict. Move it next to the backend's section after merging if you like.

## Wake word: honest status

- Engine: openWakeWord via onnxruntime-web (one thread) in a module Web Worker. It works in
  headless Chromium with the stock "hey jarvis" model on synthetic speech.
- "hey blob": a CPU-only attempt (about 35 minutes: Kokoro positives and negatives, stock
  embeddings, small numpy head exported to ONNX) recognised the phrase from held-out voices
  (5 of 5), but fired on 9 of 21 near misses and 7 of 24 unrelated sentences with scores of
  1.0. **Not shipped.** `docs/wake-word-training.md` gives the official recipe (openWakeWord's
  training notebook on a GPU or Colab) and the drop-in steps (`wake.json`, no code change).
- Not measured: SC2, real voices, the tablet, battery, heat, long runs.

## For the coordinator and other sessions

1. Contract: no defect found in `protocol/messages.json`.
2. Look session: my `blob.frag` edits are limited to `sdTriPrism`, `sdRoundBox`, `alertShapes`,
   `pickShape`, `map()` and a comment on `uShapeA`; the S1 placeholder `shape(p, id)` is gone.
   `map()` is inlined five times (march loop and four normal taps), so any code added there
   multiplies compile time; on software GL it blocks the page's main thread.
3. Backend: the page relies on `alert_read` failures being `error{bad_message}` (or
   `not_ready`), on `tts.followup` being set for every device (the page filters it), and on
   `wake` being refused with `bad_message` for non-wake devices. For e2e against the real
   backend, `config/devices.json` needs `hf-wake`, `hf-vad`, `hf-quiet` (`wake: true`) and
   `e2e-sound` (`sound: true`).
4. README addition (page section): "On a device with `wake: true` the page loads the wake word
   and voice-activity models from `/models/` (about 20 MB with the onnxruntime wasm) and listens
   for the phrase in `web/public/models/wake.json` (stock: "hey jarvis"). See
   `docs/wake-word-training.md` for "hey blob". `npm run screenshots` also writes the alert
   screenshots. `e2e/fixtures/make_fixtures.py` regenerates the synthetic test clips (backend
   environment, Kokoro)."

## Not verified

The tablet; the real backend; real human speech; audible output (headless audio is muted:
checked through started sources and effect counts); quiet hours end to end (unit tests only);
a custom wake model loaded in the page; real GPU frame rate.
