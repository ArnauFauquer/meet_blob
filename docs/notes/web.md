# Web page notes (S1 + S2)

Decisions, deviations from `docs/designs/blob_design.md`, the honest state of the look, and the README text for the page.

## Decisions where the design was ambiguous

| Topic | Decision |
| --- | --- |
| Offline view | `computeView` returns `offline` first (design precedence). It is drawn with the `error` row of the state table (dim grey). The fault line says "Offline. Reconnecting…". |
| `error{not_ready}` | Sets the grey overlay for 3 s, like a failed turn ("the page shows the grey blob"). |
| Tap rows on a mirror | The `speaking`, `thinking` and `listening` rows apply to this page's own turn only. On a device that only mirrors another device's turn, a tap sends `tap` and the backend answers `busy` (short brightness flash). |
| Tap during speaking after `turn_done` | The design says "stops playback and sends `cancel`". The backend usually sends `turn_done` before playback ends, so the page sends `cancel` with a finished turn id. The mock ignores it. **The backend should ignore a cancel for a finished turn** (an `error{bad_message}` would also be harmless: the page ignores `bad_message`). |
| Double tap | A second tap while waiting for the first `state` is ignored (tap table row `requested`). |
| `busy` racing a `state` | If another device's `state listening` arrives before our `busy`, the page may open the mic for a moment; `busy` closes it again. No audio is sent. |
| `hello_ok.ok` | Not used. The page compares `hello_ok.version` with its own version (design: "The page compares versions"). |
| Page version | Injected at build from `BLOB_VERSION`, else `backend/blob/__init__.py` `__version__`, else `0.0.0-dev`. Build the page after the backend is merged, or the page reloads once and then stops with the version fault. |
| Render scale | `devicePixelRatio × 0.75`. |
| 30 fps cap | Applies to `idle`, `error` and `offline` (the calm views). Listening and speaking run at the display rate so the level reads well. |
| Resampling | The worklet averages the input samples of each 16 kHz step (box filter). Enough for speech from 44.1 or 48 kHz; not a high-quality low-pass. |
| `tail_silence_ms` | Time from the end of the last 20 ms window with RMS > 0.01 to the end of the buffer; a trailing partial window counts as silence. No voiced window: the whole duration. |
| `dur_ms` | Length of the recorded PCM. It is 0 only when no sample was captured (S1 has no voice-activity detector; the server's speech-to-text handles a tap on silence). |
| Protocol test | Compares the TS types and constants with `protocol/messages.json` (the brief), not with a list generated from the Pydantic models (the design). Both should stay in sync through that file. |
| Device config | `GET /device-config` is fetched with the token and shown in diagnostics. Its flags are not used before S3/S4. A 401 or a failure falls back to defaults. |
| `client_event` | Sent for `mic_denied` and `webglcontextlost` (`kind: "fault"`). |
| Diagnostics frame time | Interval between the last two drawn frames (not GPU time). |
| No WebGL | The page still works by voice; the fault line says "Graphics unavailable" (also shown while a lost WebGL context is being restored). |
| Debug hooks | `window.blobDebug` exposes read-only getters (view, audio state, playback count, level maximum, fault). The e2e tests and the screenshot script use it. |

## S3/S4 extension points

- `state.ts`: `View` and `computeView` have a comment where the alert view goes (between the conversation turn and idle).
- `taps.ts`: the alert row goes right after the audio-locked row (comment in place).
- `render/blob.frag`: uniforms `uShapeA`, `uShapeB`, `uMix`; `map()` already does `mix(sdfA, sdfB, uMix)`; `shape(p, id)` returns the sphere for every id.
- `render/tables.ts`: state table only; the alert table is S4.
- `turn-client.ts`: S3 follow-up and no-speech limits go here (`Mic` interface already isolates capture).
- `protocol.ts`: S3/S4 messages are typed (for the contract test) but never sent.

## The look: what the screenshots show

Screenshots: `docs/screenshots/<state>-1280x800.png` and `-1024x768.png`. They come from real flows against the mock backend, not from a forced view: idle on load; listening after a tap, with the fake microphone (a loud looped tone); thinking during the mock's 5 s delay; speaking during the 8 s mock reply; error during the `hermes_fail` fallback line. Rendered by headless Chromium with SwiftShader (software GL).

What looks good:

- Near-black background with a faint coloured halo; the blob is the only bright thing.
- The five states are clearly different in colour and motion: deep violet idle, cyan listening with smooth swells, glowing amber thinking, pearl warm-white speaking, dim grey error.
- Glossy, semi-transparent liquid look: soft key highlight, a tall strip reflection, a fresnel rim lit by the backdrop, a coloured floor bounce, inner glow. No hard edges, no banding (dithered).
- The PWA icons (192, 512) are crops of the idle render.

What is still weak:

- It reads more like glossy glass or a soap bubble than like chrome. The reflections are a simple studio; there is no refraction.
- The inner "lava" shapes are very subtle. You cannot see distinct lava blobs inside.
- The centre is darker than the rim (the background shows through), so the blob can look like a lens.
- In listening, the fake microphone is a constant loud tone, so the swells are at their largest. With real speech they come and go. That has not been seen.
- The screenshots are stills. They do not show motion. I never watched the motion at real frame rate: SwiftShader draws about 10 to 12 frames per second at 1280x800 (frame interval about 83 ms).
- The bright states (speaking, thinking) lift the background around the blob a little through the halo.

Not verified: real GPU frame rate, the look on the tablet screen, and colour on a real display.

## README section (for the coordinator to paste)

```markdown
## Web page

The page is a static TypeScript app in `web/` (Vite, three.js, vitest, Playwright). The backend serves the built files from `web/dist` (`STATIC_DIR`) and must send `index.html` with `Cache-Control: no-cache`.

    cd web
    npm ci
    npm run dev          # http://localhost:5173, proxies /ws and the HTTP endpoints to BLOB_BACKEND (default http://localhost:8000)
    npm run lint && npm run typecheck && npm test && npm run build

Install a browser once with its token: open `https://<host>/#t=<DEVICE_TOKEN>&device=<name>`. The page stores both in `localStorage` and removes them from the address bar. Tap the blob to talk, tap again to send. Tap while it thinks or speaks to cancel. Long press opens diagnostics.

End-to-end tests (Chromium headless, fake microphone, software GL):

    npx playwright install chromium
    npm run e2e                                   # builds, starts the mock backend (e2e/mock-backend.ts), runs e2e/*.spec.ts
    BLOB_URL=http://localhost:8000 BLOB_TOKEN=<token> npx playwright test   # against a running backend; mock-only flows are skipped
    npm run screenshots                           # rewrites docs/screenshots/ and web/public/icons/

`scripts/make_sounds.py` regenerates `web/public/beep.wav`.
```
