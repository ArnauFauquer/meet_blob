# Web page notes (S3 hands-free + S4 alerts)

Decisions where `docs/designs/blob_design.md` was ambiguous, deviations, and the honest state
of what was and was not verified. S1/S2 notes are in `docs/notes/web.md`.

## Decisions

| Topic | Decision |
| --- | --- |
| View precedence | `computeView`: offline, error overlay, turn (backend not idle, or local reply playback; `speaking` kept until it ends), top alert, idle. The view type gained `'alert'`. |
| "Turn active" for alerts | `conv !== 'idle'` or a local reply still playing (`turnActive()` in `state.ts`). The chime hold also counts this page's local phase (`requested`, `listening`, `thinking`). |
| Top alert | Urgent before info, then lowest `activated_at`, then key order (so every screen agrees when two alerts share a second). |
| Alert read-out | The alert stays on screen (with the playback level driving the surface) while it is read. Its audio is not "turn playback": it does not switch the view to `speaking`, and the speaking tap row does not apply to it. |
| Tap during a read | Ignored (new tap row before the alert row), so a second tap cannot send a second `alert_read`. |
| Failed read | `error{bad_message}` or `error{not_ready}` while waiting, no `tts` within 10 s (`ALERT_READ_TIMEOUT_MS`), or a WAV that cannot be decoded: the alert is kept, the beep plays, nothing else is sent. The backend answers a failed synthesis with `error{bad_message}` (backend notes, item 14). |
| `alert_ack` timing | Sent when local playback becomes empty after the alert WAV started. |
| Chime and beep for alerts | Played as "effects" (`Playback.effect`): not counted as playback, not stopped by a tap, do not mute the wake word. |
| Chime "once per alert" | Per key seen on this page. Alerts that arrive in the same snapshot share one chime. A key that leaves the snapshot (acked, deleted) and comes back chimes again. On page load every active alert counts as new, so a reload chimes once for what is on screen. Updating an active alert (same key) does not chime again. |
| Chime and `/device-config` | No chime decision is taken before `/device-config` has answered (otherwise the default `sound=false` would mark the first alerts as already chimed). |
| Quiet hours | `HH:MM-HH:MM`, may cross midnight, browser local time, start inclusive, end exclusive. Empty, malformed or `start == end`: never quiet. A chime that falls inside quiet hours is dropped, not replayed later. |
| Shapes | Ids: 0 sphere (`sphereShape`, unchanged), 1 rounded triangular prism (timer), 2 rounded box (any other source), with a slow sway so the flat faces catch the light, scaled by the breathing radius so they pulse. In `blob.frag` only the distance code changed: new `sdTriPrism`, `sdRoundBox`, `alertShapes` (both alert shapes at once) and `pickShape`, and `map()`. The S1 placeholder `shape(p, id)` was removed. `main()`, `env()`, `normalAt()` and the uniforms' declarations are untouched (one comment line on `uShapeA` changed). |
| Shader compile cost | A first version called `shape()` (sphere + alert code) for both morph slots, which made the compiled shader about twice as large: with SwiftShader the page's main thread stalled 0.35 s at load (1.1 s while the GPU process was still busy with a previous page), long-press timers fired late, and two S1 e2e specs failed (main passed under the same load). `map()` now evaluates `sphereShape` and `alertShapes` at most once each and picks by id: no stall alone, 0.24 s after a previous page, all S1 specs pass. **For the look session:** `map()` is inlined five times (march loop and four normal taps), so code added to the distance functions costs five times in compile time. |
| March step while morphing | `map()` returns the mixed distance times 0.875 while `0 < uMix`: with `main()`'s 0.8 step factor this is the design's ~0.7. Done inside `map()` so the lighting code in `main()` did not need an edit. |
| Morph | 0.8 s, smoothstep-eased `uMix` (`render/morph.ts`). A new target during a morph waits for it to finish; a return to the old shape reverses it from where it is. Colour eases with the existing 0.6 s time constant. |
| Pulse | `INFO_PULSE_HZ = 0.45`, `URGENT_PULSE_FACTOR = 2` in `tables.ts`; the breathing amplitude for alerts is 7 % of the size. |
| Alert frame rate | `alert` joins the calm views capped at 30 fps. |
| Hands-free audio path | One `getUserMedia` stream and one AudioWorklet (`Capture.openShared()`), opened when `/device-config` says `wake=true`. A turn only starts and stops a recorder on it; the tracks stay open. The worklet now posts 20 ms blocks (320 samples) instead of one per render quantum. |
| One ONNX runtime | The wake word and Silero both run in one module Web Worker (`wake/worker.ts`) on one onnxruntime-web (wasm, `numThreads = 1`, no cross-origin isolation needed). `vad.ts` holds the endpointing logic on the main thread and gets one speech probability per 32 ms frame. Silero is `@ricky0123/vad-web`'s `Silero` class (v5 model); its `MicVAD` is not used because it opens its own stream and worklet. |
| Wake engine | openWakeWord, ported in `wake/oww.ts` (about 80 lines, same maths as `openwakeword.utils.AudioFeatures`). The npm ports found (`openwakeword-js`, `openwakeword-wasm-browser`, `@framers/agentos-ext-openwakeword`) are small one-maintainer packages; the pipeline is short enough to own. A Node test runs the real models on the Kokoro clip (score above 0.9; the Python reference gives 0.999) and on a negative clip (below 0.1). |
| Wake model and phrase | `/models/wake.json` (`model`, `phrase`, `threshold`, default `hey_jarvis_v0.1.onnx`, `hey jarvis`, 0.5). Input and output tensor names are read from the session, so a custom openWakeWord model drops in. |
| Wake reset | When the gate opens again, the worker's audio, mel and embedding buffers are reset, so speech from before a mute (a reply, the user's own question) cannot fire it. Zero embeddings score about 0.0002 with the stock model, so no warm-up skip is needed. |
| Wake flash | A detection calls the busy flash (CUJ 3: "the blob flashes"). |
| Gate | `wake-gate.ts`: runs only with `wake=true` and the model loaded, local phase `idle`, backend `idle`, no local playback (including an alert read waiting for its audio) and 0.5 s after it, no follow-up due or open. Alerts do not block it ("the wake word always starts a turn"). |
| VAD on which turns | On a hands-free device every listening phase (tap, wake, follow-up) is ended by the VAD; a stop tap still works. A tap-only device (`wake=false`) keeps the S1 behaviour (tap to stop, 15 s cap) and never loads the models. |
| Endpointing | Speech starts after 90 ms at probability ≥ 0.5; after that, frames ≥ 0.35 keep it going; 700 ms below ends it (`SILENCE_END_MS`). No speech within `listen_no_speech_s` (8 s), or `followup_listen_s` (6 s) for a follow-up turn: zero-length `utterance` (`dur_ms: 0`, `tail_silence_ms: 0`, no binary frame). 15 s total: `cap` (sends what was recorded; the S1 15 s timer also stays). A 250 ms timer checks the limits when frames stop coming. |
| Utterance audio | The whole recording from `state listening` to the end is sent; no trimming. `tail_silence_ms` is still computed from RMS against `silence_rms`, which is now read from `/device-config`. |
| Follow-up | Only on a hands-free page (the backend also sets `tts.followup` for `wake=false` devices; those pages ignore it). The page sends `wake{followup:true}` when its playback is empty and its turn is over (whichever comes last), once per reply. A cancel tap or a socket drop forgets it. The wake detector is muted while it is due or open. |
| Refused `wake` | `error{bad_message}` while a tap or wake is waiting for its `state` now frees the turn client (a `wake` from a device the backend does not list as `wake=true`). Any other `bad_message` is still ignored. |
| Wake faults | New fault line entry "Wake word unavailable. Tap to talk." when the wake or VAD model fails to load or the worker fails; also sent as `client_event` (`fault: wake_failed` or `vad_failed`). The wake score, maximum, detections, model and phrase are in the diagnostics view. |
| Audio locked and hands-free | While the AudioContext is suspended the worklet does not run, so the wake word does not run either. The first tap after a reboot unlocks it (known S2 limit). |
| Mock backend | Device flags from the name: `hf-*` has `wake=true`, a name containing `sound` has `sound=true`, a name containing `followup` gets `tts.followup=true` on a turn not started by a follow-up. `/alerts` subset with `MOCK_ALERT_TOKEN` (default `alert-token`); `alert_read` of a key starting with `ttsfail` answers `error{bad_message}`. |

## Contract notes

No defect found in `protocol/messages.json`. `protocol.ts` already typed every S3/S4 field. Two
backend behaviours the page depends on (from `docs/notes/backend-s3-s4.md` on
`t3/blob-backend-s3-s4`): `alert_read` failures answer `error{bad_message}`, and `tts.followup`
is set whatever the device, so the page filters it.

## What the screenshots show

`docs/screenshots/alert-timer-info-1280x800.png`, `alert-timer-urgent-1280x800.png`,
`alert-calendar-info-1280x800.png` and `alert-morph-1280x800.png`, from `npm run screenshots`
(real flows against the mock: POST /alerts, then the page's own view), SwiftShader software GL.

*   Timer: a green (info) or red (urgent) triangular prism, slightly turned so its side face
    shows. Calendar: a green rounded box with a bright edge highlight. The colours are clearly
    green and red.
*   The morph frame was captured at `uMix = 0.32` (red triangle to green square, the colour
    halfway, so brownish): the shape is a blend with a soft, lumpy outline and no holes or
    dark seams.
*   Weak: the triangle's edges read sharper than "rounded" (the prism distance is a bound, so
    subtracting 0.12 rounds it less than the box). The shapes keep only a faint liquid shimmer;
    they look like glossy plastic or glass rather than liquid metal. The background stays near
    black; a soft coloured halo surrounds the shape (red for urgent), from `main()`'s halo with
    the alert glow value (shading is the look session's). The shapes are smaller on screen than
    the sphere. The pulse (urgent twice as fast)
    is motion and cannot be seen in a still; it was never watched at a real frame rate
    (SwiftShader draws about 10 fps).

## Not verified

*   Anything on the tablet: whether openWakeWord in a worker keeps up for hours, CPU and
    battery cost, heat, microphone permission after a restart, the 14.8 MB onnxruntime wasm
    download and compile time. SC2 (false accepts with the TV on, misses) was not measured.
*   Real speech from a person: the wake word, the VAD and the follow-up were tested only with
    synthetic Kokoro speech played through Chromium's fake microphone. Silero thresholds,
    the 700 ms silence and the 90 ms minimum speech are design defaults, not tuned (design:
    set after the tablet test, recorded in `docs/spikes/tablet-test.md`).
*   "hey blob": no usable model (see `docs/wake-word-training.md`). The page ships with
    "hey jarvis".
*   The real backend: none of the e2e specs ran against it. The backend's behaviour the page
    relies on is taken from its notes (`alert_read` errors, `tts.followup` for every device,
    `wake` gating).
*   Audible output: headless audio is muted; the chime and reads are checked through started
    sources, effect counts and the analyser level.
*   Quiet hours end to end (unit-tested only; the mock serves an empty `quiet_hours`).
*   A custom wake model file loaded in the page (only through the Python reference).
*   The e2e flows are timing-sensitive under heavy CPU load: with a CPU-bound training job
    running in parallel, the VAD spec once measured `tail_silence_ms` 4285 (worker backlog)
    and the alert-read spec hit a logging race (fixed). Run on an idle machine they passed.
