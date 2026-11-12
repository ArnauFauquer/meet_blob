# Report: web page (S1 + S2)

Branch `t3/b1991c72`. Commits on top of `bfaef3f`:

- `07356d7` feat(web): scaffold Vite page with protocol types and WebSocket client (from the cancelled earlier session; kept as is)
- `c75e76e` feat(web): turn client, taps, audio capture and playback, blob renderer, PWA assets
- `c96c2b1` test(web): e2e flows against a mock backend, screenshots and PWA icons
- `847c472` fix(web): no dark seam on grazing rays, inner glow follows the deformed surface
- `66b9951` docs(web): decisions, look review and README section for the page
- the commit that adds this report (hash in the coordinator message)

Decisions, deviations, the look review and the README text are in `docs/notes/web.md`.

## Files

- `scripts/make_sounds.py`: writes `web/public/beep.wav` (0.3 s, 440 Hz, 24 kHz mono).
- `web/` project: `package.json` (scripts `dev`, `build`, `lint`, `typecheck`, `test`, plus `e2e`, `screenshots`, `preview`), `package-lock.json`, `tsconfig.json`, `vite.config.ts` (dev proxy, version injection, vitest jsdom), `eslint.config.js`, `vite-env.d.ts`, `index.html`, `.gitignore`, `playwright.config.ts`.
- `web/src/`: `main.ts`, `config.ts`, `protocol.ts`, `ws.ts`, `state.ts`, `turn-client.ts`, `taps.ts`, `diag.ts`, `fault.ts`, `token.ts`, `version.ts`, `wakelock.ts`, `audio/capture.ts`, `audio/pcm.ts`, `audio/playback.ts`, `audio/worklet/capture-processor.ts`, `render/blob.ts`, `render/blob.frag`, `render/blob.vert`, `render/tables.ts`.
- Unit tests: `protocol.test.ts`, `ws.test.ts`, `state.test.ts`, `taps.test.ts`, `turn-client.test.ts`, `fault.test.ts`, `token.test.ts`, `version.test.ts`, `audio/capture.test.ts`, `audio/playback.test.ts`.
- `web/public/`: `manifest.webmanifest`, `icons/icon-192.png`, `icons/icon-512.png`, `beep.wav`.
- `web/e2e/`: `mock-backend.ts`, `wav.ts`, `helpers.ts`, `turn.spec.ts`, `connection.spec.ts`, `audio-locked.spec.ts`, `pwa.spec.ts`, `screenshots.spec.ts`.
- `docs/screenshots/{idle,listening,thinking,speaking,error}-{1280x800,1024x768}.png`, `docs/notes/web.md`.

No other paths were touched. `npm ci` needs no install-script allowance: the only package with an install script in the lockfile is `fsevents` (optional, macOS only); Vite 8 uses rolldown's prebuilt binaries.

## Definition of Done

### 1. lint, typecheck, unit tests, build: PASS

Run in `web/`:

- `npm run lint` (eslint .): no output, exit 0.
- `npm run typecheck` (tsc --noEmit): no output, exit 0.
- `npm test` (vitest run): `Test Files 10 passed (10)`, `Tests 73 passed (73)`.
- `npm run build` (vite build): `dist/index.html 1.50 kB`, `dist/assets/capture-processor-*.js 0.67 kB`, `dist/assets/index-*.js 548 kB (gzip 139 kB)`, `✓ built`. The chunk is three.js; the warning limit is raised to 800 kB.
- `npm ci` from the lockfile: OK. `npm audit --omit=dev`: 0 vulnerabilities. `npm audit` reports 10 moderate issues in dev tooling (minimatch through eslint 10 and typescript-eslint). The suggested fix is a downgrade to eslint 9, so I did not apply it.

What the unit tests cover:

| Required | Where |
| --- | --- |
| state.ts view precedence, error overlay and its 3 s clear | `state.test.ts` (offline > overlay > speaking kept during local playback > conv; overlay only for stt_fail/hermes_fail/timeout/tts_fail; cleared at 3 s; held while playback runs; mirror speaking from the snapshot) |
| taps.ts, every S1/S2 row incl. audio-locked | `taps.test.ts` (unlock, stop fallback, stop+cancel, cancel, send utterance, ignore double tap, start turn incl. during the overlay) |
| turn-client.ts | `turn-client.test.ts` (mic only after the first `state listening` with a turn id; utterance with dur_ms/tail_silence_ms and PCM; no frame when dur_ms 0; 15 s cap by timer and by the recorder; busy; not_ready; double tap; mic denial sends cancel; cancel while thinking; cancel after turn_done; reset closes the mic) |
| playback.ts | `playback.test.ts` (nextT scheduling, onIdle, stale-turn drop, new turn stops old audio, cancel drops later chunks, late decode dropped, beep fetched once and stoppable, fallback stoppable, level) |
| ws.ts | `ws.test.ts` (header+binary pairing and drops, hello first, ready only after hello_ok, version guard stops without retry, backoff 1-30 s and reset, no retry on 4401, ping every 20 s and reconnect when pongs stop, malformed messages) |
| capture | `audio/capture.test.ts` (15 s cap, 48/44.1/16 kHz to 16 kHz across 128-sample blocks, level kept, tail_silence_ms and dur_ms from a synthetic buffer, s16 clipping, level mapping) |
| token.ts | `token.test.ts` (#t=&device= parse, storage, hash removal, stored fallback) |
| version guard | `version.test.ts` (reload at most once per server version, then stop) |
| fault line | `fault.test.ts` |
| protocol vs messages.json | `protocol.test.ts` (message names, enums, close codes, fields per message, binary messages) |

### 2. Playwright e2e against the mock backend: PASS (16 of 16)

`npm run e2e` (vite build, then playwright test; the mock is started by the config). Last run: `16 passed (51.4s)`. Chromium headless shell from `npx playwright install chromium` (already installed, no missing system libraries), fake microphone from a generated WAV (1 s speech-like tone, 1 s silence, looped), SwiftShader GL.

- normal turn: the mic opens after the first `state listening` with a turn id. The second tap sends `utterance` (turn, pcm_s16le, 16000, dur_ms 1200-4000, 0 ≤ tail_silence_ms ≤ dur_ms) and then one binary frame of dur_ms × 32 bytes (±1 ms) with RMS > 0.01. The tts header and WAV frame arrive, turn_done is ok, the AudioContext is running and started a source, the view shows speaking, the playback-level uniform goes above 0.05, then the view returns to idle. The mic tracks are stopped.
- tap during speaking: `cancel{turn}` is sent, playback stops, the view returns to idle, the tracks are stopped.
- tap during thinking: `cancel{turn}` is sent, `turn_done cancel`, nothing plays (mock `slow`).
- empty: `turn_done empty`, no grey overlay.
- hermes_fail: the fallback tts plays under the grey overlay. A tap stops it and sends no cancel and no tap. The overlay clears and the view returns to idle.
- tts_fail: no tts. The local beep plays, the grey overlay holds for at least 1.5 s, then idle.
- busy: two browser contexts. B mirrors A's listening, B's tap gets `error busy`, and B opens no mic. A then finishes normally.
- not_ready: `error not_ready`, the grey view shows, no mic.
- bad token: the socket closes with 4401, the fault line shows the token message, and there is exactly one connection after 4 s.
- reconnect: the mock kills the first socket. The page shows offline and "Offline", reconnects (a second hello and hello_ok), and returns to idle with no fault.
- version mismatch: exactly one reload, then the `version` fault. There is no further reload or connection, and `blob.reloadedFor` is stored.
- audio locked: the cue shows. The first tap only resumes audio and sends no `tap`. The second tap starts a turn.
- webglcontextlost: drawing pauses and the `render` fault shows. After restore, frames are drawn again.
- long press: opens diagnostics (version, `socket: open`, `hermes_reachable: true`, Copy report) and sends no tap. A tap closes it.
- production build loads with no console errors, the token leaves the URL, and there is no service worker.
- manifest and icons: see item 3.

Against the real backend: `BLOB_URL=http://host:port BLOB_TOKEN=<DEVICE_TOKEN> npx playwright test` (the backend must serve the freshly built `web/dist`). Tests that need mock scenarios (`empty`, `hermes_fail`, `tts_fail`, `not_ready`, `version`, `slow`, `drop`) are skipped unless `BLOB_SCENARIOS=1`. Normal turn, speaking tap, busy, bad token, audio locked, context loss, long press and PWA run against any backend. They assert only frames the page sends and receives, which an in-page WebSocket wrapper records. **Not run against the real backend** (not available to me). Device names used: `e2e-normal`, `e2e-busy-a`, `e2e-busy-b`, etc. If the backend validates device names, it must accept them.

### 3. Production build, manifest, icons, no service worker: PASS

- The mock serves `web/dist` like the backend would (index.html with `Cache-Control: no-cache`). The `pwa.spec.ts` "loads without console errors" test passes.
- `vite preview` (port 4173): `/`, `/manifest.webmanifest` (application/manifest+json), `/icons/icon-192.png`, `/icons/icon-512.png` and `/beep.wav` all return 200. With no backend behind the preview proxy, the console shows only the expected `/ws` handshake failures and a 502 for `/device-config`. The page shows offline and "Offline. Reconnecting…".
- The manifest has `display: fullscreen`, `start_url: "/"` with no secret in it, `scope: "/"`, black theme and background, and 192 and 512 PNG icons. The test checks the PNG signature and the IHDR size.
- There is no service worker: `getRegistrations()` returns 0 in the test.
- `Cache-Control: no-cache` on `index.html` is the backend's job (`STATIC_DIR` serving). Hashed assets can be cached.

### 4. Screenshots: PASS (with honest weaknesses)

There are ten files in `docs/screenshots/`. `npm run screenshots` takes them from real flows against the mock. `docs/notes/web.md` describes them, including what is weak. Summary: the five states are clearly different, the background is near black, and the look is glossy, translucent and liquid. It reads more like glass or a bubble than chrome. The inner lava shapes are barely visible. The motion was never seen at real frame rate.

### 5. README section: PASS

The text is in `docs/notes/web.md`, section "README section", ready to paste.

## Not tested, and why

- Real tablet, real GPU frame rate, the 30 fps idle cap as measured on a device, and Wake Lock behaviour: there was no device and no GPU. SwiftShader gives about 12 fps at 1280x800.
- A real autoplay lock. Headless Chromium here ignores `--autoplay-policy` and starts every AudioContext as running. The e2e test suspends the page's AudioContext right after creation to simulate the locked state. The page's own unlock path (`resume()` on a tap) is the real one.
- Real speech through the mic, and audible output: headless audio is muted. Playback is checked through the AudioContext state, started sources and the analyser level.
- The real backend: none of the e2e tests ran against it.
- `navigator.clipboard` copy in diagnostics: the button is shown, but the copy itself was not tested.

## Deviations and open issues

See `docs/notes/web.md` for the full list. Items the backend or coordinator should know:

1. **Cancel after turn_done.** A tap during speaking sends `cancel` for a turn that has usually already ended. The backend should ignore it. If it answers `error{bad_message}`, the page ignores that too.
2. The page version comes from `backend/blob/__init__.py` at build time, or from `BLOB_VERSION`. Build the page after merging the backend. Otherwise the page reloads once on the version mismatch and then stops with the version fault.
3. `index.html` must be served with `Cache-Control: no-cache` (backend).
4. `hello_ok.ok` is not read; only the version is compared.
5. `error{not_ready}` shows the grey overlay for 3 s.
6. The dev tooling has moderate audit findings (minimatch via eslint 10), left as is.

## How to run

```sh
cd web
npm ci
npm run dev                      # http://localhost:5173, proxies /ws etc. to BLOB_BACKEND (default http://localhost:8000)
npm run lint && npm run typecheck && npm test && npm run build
npx playwright install chromium  # once
npm run e2e                      # build + mock backend + all e2e flows (about 1 min)
npm run screenshots              # rewrite docs/screenshots and the PWA icons (about 1.5 min)
BLOB_URL=http://localhost:8000 BLOB_TOKEN=<token> npx playwright test   # against a real backend
node e2e/mock-backend.ts         # the mock alone on :8787 (PORT, MOCK_TOKEN=test-token, MOCK_STATIC=dist)
```

Open `http://localhost:8787/#t=test-token&device=desk` with the mock running. A device name of `empty`, `hermes_fail`, `tts_fail`, `not_ready`, `version`, `slow` or `drop` selects that scenario.
