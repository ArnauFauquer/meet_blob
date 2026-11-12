# Deploying Blob

Blob ships as one container image. The Kubernetes definitions live in the home_lab repo
(`faukinator/blob/` Helm chart, `applications/blob.yaml` Argo CD app, `terraform/blob-secret.tf`).
Decisions and open issues: [docs/notes/deploy.md](../docs/notes/deploy.md).

## The image

Built from the repository root by `Dockerfile`:

1. `node:24` stage: `npm ci && npm run build` in `web/` (the build reads the protocol version
   from `backend/blob/__init__.py`), output `web/dist`.
2. `nvidia/cuda:12.9.1-base-ubuntu24.04` plus `libcublas-12-9` (all CTranslate2 4.9.0 needs on
   the GPU), Python 3.12, and the backend installed with `uv sync --frozen --no-dev` into
   `/app/.venv`. The page goes to `/app/web/dist`.

```bash
docker build -t blob .
```

CI: `.github/workflows/image.yml` builds on every push to `main` that touches `backend/`, `web/`,
the Dockerfile or the workflow (and on manual dispatch), and pushes
`ghcr.io/arnaufauquer/meet_blob:sha-<7-char commit>` and `:latest`. It uses only `GITHUB_TOKEN`.

Run locally without a GPU or real models:

```bash
docker run --rm -p 8000:8000 --read-only --tmpfs /tmp:exec -v blob-data:/data \
  -e HERMES_URL=http://host.docker.internal:8642 -e HERMES_KEY=... -e HERMES_MODEL=hermes-agent \
  -e DEVICE_TOKEN=... -e BLOB_FAKE_MODELS=true blob
```

`/tmp` must allow exec: phonemizer (Kokoro) copies `libespeak-ng.so` there and loads it. Docker's
`--tmpfs` is `noexec` by default, so pass `:exec`. A Kubernetes `emptyDir` is fine.

## What the image provides and expects

| Item | Value |
|------|-------|
| User | `10001:10001`, no shell, `HOME=/tmp` |
| Port | `8000` (`HOST=0.0.0.0`, `PORT=8000`) |
| Entry point | `blob` (`blob.main:run`) |
| Writable paths | `/data` (volume) and `/tmp` only; the root filesystem can be read-only |
| `/data` | `blob.db` (SQLite) and `models/` (faster-whisper and Kokoro, downloaded on first start, about 3.3 GB with `large-v3`) |
| `/config/devices.json` | per-device flags (`DEVICES_PATH`), mounted from a ConfigMap |
| Probes | liveness `GET /healthz` (always 200 while the process runs); readiness and startup `GET /readyz` (503 until the database is open and both models are loaded) |
| GPU | one `nvidia.com/gpu`; the pod needs the `nvidia` RuntimeClass on Talos so the driver libraries are injected |

Environment set by the image: `HOST`, `PORT`, `DB_PATH=/data/blob.db`, `MODEL_DIR=/data/models`,
`HF_HOME=/data/models/huggingface`, `STATIC_DIR=/app/web/dist`, `DEVICES_PATH=/config/devices.json`.

Environment the chart must provide:

| Variable | Source |
|----------|--------|
| `HERMES_URL` | values (`http://hermes-agent.hermes-agent.svc.cluster.local:8642`) |
| `HERMES_MODEL` | values (`hermes-agent`) |
| `HERMES_HISTORY_MODE` | values (`session`) |
| `TZ` | values (`Europe/Madrid`; quiet hours are local time) |
| `HERMES_KEY`, `ALERT_TOKEN`, `DEVICE_TOKEN` | Secret `blob-secrets` (Terraform) |

Every other setting keeps the default in `backend/blob/config.py`.

## Deploy order (home_lab)

1. Merge the home_lab `feat/blob` branch only after the steps below are ready: Argo CD syncs `main`
   automatically, and the app-of-apps picks up `applications/blob.yaml`.
2. `terraform apply` in `home_lab/terraform` creates namespace `blob` and Secret `blob-secrets`
   (before Argo CD creates the namespace, or the namespace resource conflicts).
3. Create the ghcr pull Secret `github-docker-credentials` in namespace `blob` (home_lab
   `docs/secrets.md`, "GitHub Container Registry"): the meet_blob package is private.
4. Set `image.tag` in `faukinator/blob/values.yaml` to the `sha-<commit>` tag CI pushed. The chart
   refuses to render without it.
5. Point `blob.faukinator.com` at Traefik if the Pi-hole wildcard does not already cover it.
6. Install the tablet once with `https://blob.faukinator.com/#t=<DEVICE_TOKEN>&device=tablet`.
