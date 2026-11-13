# Integration record (coordinator)

Date: 2026-11-13. Everything below was run by the coordinator on the merged `main`, apart from the
unit and mock-backend suites that the implementation sessions ran (their reports are in
`docs/coordination/reports/`).

## What exists

- Backend (`backend/`): slices S1 (tap-to-talk), S2 (tokens, device config, static page), S3 (wake
  message, follow-up flag) and S4 (alerts API, scheduler, timer rule, `alert_read`/`alert_ack`).
- Page (`web/`): S1/S2 (states, taps, capture, playback, PWA), S3 (voice-activity detector, wake word with
  the stock phrase "hey jarvis", follow-up listening), S4 (alert shapes, morph, chime, quiet hours), and the
  liquid-metal look.
- Deployment: `Dockerfile`, `.github/workflows/{ci,image}.yml`, Helm chart, Argo application, Terraform
  secret and a Hermes NetworkPolicy in the `home_lab` repo, branch `feat/blob` (not merged, not applied).

## Verified

| Check | Result |
| --- | --- |
| Backend `ruff`, `mypy`, `pytest -m "not gpu" --cov` on `main` | 302 passed, coverage 98.96% |
| Web `lint`, `typecheck`, `npm test`, `build` on `main` | all pass, 136 unit tests |
| Playwright against the mock backend (run by the sessions) | 26/26 |
| Playwright against the real backend (fake models), built page served by the backend | 17 passed, 9 skipped (mock-only flows) |
| GitHub Actions `ci` and `image` on `main` | success; image `ghcr.io/arnaufauquer/meet_blob:sha-a2ec369` |
| Real browser (fake microphone playing a Kokoro-made sentence), page, backend with CPU `small` Whisper, real Hermes, reply audio played | pass: listening, thinking, speaking, idle; "¿Cuál es la capital de Francia?" answered "La capital de Francia es París."; about 10 s per turn on CPU |
| Same on the cluster GPU node (RTX 3050), `large-v3` `int8_float16`, real Hermes, image `sha-a2ec369` in a temporary namespace | pass, Spanish and English; `stt_ms` about 1.1-1.3 s, `hermes_ms` 2.3-3.2 s, `tts_ms` about 0.5 s, `sc1_ms` 3.9-5.0 s (target about 6 s) |
| Image pull from ghcr in the cluster with the existing `github-docker-credentials` | pass (32 s, 899 MB); the pod was ready about 3 min after the first start (model download) and about 20 s on later starts |
| Alert created over HTTP shows in a real page (urgent calendar = red square), a tap reads it aloud, the alert becomes `acked` | pass (`docs/screenshots/cluster/alert-calendar-urgent.png`) |
| Spoken timer ("Pon un temporizador de un minuto") over WebSocket on the GPU deployment | pass: transcript exact, timer `pending` about 60 s ahead, no Hermes call, `sc1_ms` about 2.1 s |
| Hermes creates an alert by calling `POST /alerts` with a bearer token from its terminal | pass (HTTP 201), see `docs/spikes/hermes-test.md` |
| Hermes conversation with `X-Hermes-Session-Id` keeps context | pass |
| Alerts, timers and the SQLite file survive a restart of the app (real SQLite file; an overdue timer fires once, marked `late`) | pass (backend session; the pod restart in the cluster test) |

## Not verified (be careful)

- **The real tablet**: Android and Chrome behaviour of the PWA, the always-on microphone, Wake Lock, the audio
  unlock after a reboot, the frame rate and heat of the shader on the tablet GPU. Everything on the page was
  tested in headless Chromium with software GL (about 8 to 12 fps) and a fake microphone.
- **Real human speech and Catalan**: all test audio is Kokoro speech. Kokoro has no Catalan voice, so the
  "Catalan" clip is Catalan text read by a Spanish voice; its transcript was wrong ("Quina, he acentuado").
  The accuracy of `large-v3` on a real Catalan speaker is unmeasured. In one browser run the spoken-timer
  clip was transcribed as "Pon" only; sent straight over the WebSocket the same clip was transcribed in full.
  The cause is probably how Chromium's fake microphone loops a short file, but it was not investigated.
- **Wake phrase "hey blob"**: not delivered. A model trained on this CPU-only machine fired on too many near
  misses, so the page ships the stock "hey jarvis" model (licence CC BY-NC-SA, fine for personal use). See
  `docs/wake-word-training.md` for how to train and drop in "hey blob". The false-accept rate with a TV on
  (success criterion SC2) was not measured.
- **Audible output**: headless Chromium mutes audio; playback was checked through started audio sources and the
  playback-level uniform, not by ear.
- **Real GPU frame rate and the look in motion**: judged from stills and contact sheets only.
- **Traefik and WebSockets**: the cluster test went through `kubectl port-forward`, not the Ingress, so the
  60 s read timeout concern in `docs/notes/deploy.md` is untested.
- **Production deployment**: the chart, Argo application, Terraform secret and NetworkPolicy are validated
  (`helm lint`, `kubeconform`, `terraform validate`) but nothing was applied to the `blob` namespace.
- **NetworkPolicy**: the cluster runs flannel, which does not enforce NetworkPolicy, so Hermes (whose API key
  allows commands in its pod) is still reachable from any pod.
- Whether a client disconnect stops a running Hermes request, and the Home Assistant example in `docs/alerts.md`.

## To go live (needs the owner)

1. In `home_lab`, branch `feat/blob`: `terraform apply` (creates `blob-secrets`; needs the R2 credentials), merge
   the branch to `main` so Argo deploys, copy the pull secret into the new namespace (`kubectl get secret
   github-docker-credentials -n tistic-store -o json`, rename the namespace, `kubectl apply -n blob -f -`), and
   check that `blob.faukinator.com` resolves to Traefik.
2. Read the device token (`terraform output` or the `blob-secrets` Secret) and open
   `https://blob.faukinator.com/#t=<DEVICE_TOKEN>&device=tablet` once on the tablet.
3. Test on the tablet and report what fails (microphone permission, audio unlock, wake word, performance).
