# Deployment session report (wave 1)

Date: 2026-11-12. Nothing was applied, pushed or merged. Cluster access was read-only.
Part of this work was started by an earlier deployment session that was cancelled. This session
reviewed that work, kept it, and finished and validated it.

## Branches

| Repo | Branch | Last commit |
|------|--------|-------------|
| meet_blob | `t3/2ad1920f` (worktree `/home/arnau/.t3/worktrees/meet_blob/t3-2ad1920f-1c8341c9f5e18c24`) | `bf264be` feat(deploy), plus this report's commit |
| home_lab | `feat/blob` (worktree `/home/arnau/workspace/home_lab.worktrees/blob`, based on `origin/main` `e65946d`) | `e46033c` feat(blob) |

## Files

meet_blob: `Dockerfile`, `.dockerignore`, `.github/workflows/image.yml`, `deploy/README.md`,
`docs/notes/deploy.md` (decisions, deviations, open issues: the details behind this report).

home_lab: `faukinator/blob/` (Chart.yaml, values.yaml, templates: deployment, service, ingress,
middleware, pvc, configmap), `applications/blob.yaml`, `terraform/blob-secret.tf`,
`faukinator/hermes-agent/templates/networkpolicy.yaml`, `faukinator/hermes-agent/values.yaml`
(`networkPolicy` block), `docs/secrets.md`.

## Validation

| Check | Command | Result |
|-------|---------|--------|
| Image build | `docker build -t blob:slim .` in a scratch context: real backend from backend-branch commit `3f028f6` (`git archive`), real `web/` sources from the web worktree plus a stand-in `index.html` (the page had none yet) | PASS |
| Image size | `docker images` | 2.77 GB on disk, 916 MB compressed (the first build on the `runtime` tag was 7.08 GB / 2.62 GB) |
| User | `docker exec ... id -u` | PASS: 10001 |
| Read-only root | `docker run --read-only --tmpfs /tmp:exec -v <vol>:/data ...`; `touch /app/x` | PASS: "Read-only file system"; `/data/blob.db` owned by 10001 |
| Fake models | `BLOB_FAKE_MODELS=true`; curl `/healthz`, `/readyz`, `/` | PASS: 200, 200, 200 (page served) |
| Real models on CPU | `STT_MODEL=tiny STT_COMPUTE=int8`, real Kokoro download | PASS: `/readyz` 200, "models ready in 14.9 s" (includes Kokoro warm-up synthesis, so the bundled espeak works) |
| Device config | `GET /device-config?device=tablet` with and without token | PASS: flags returned / 401 |
| CUDA libs | `ctypes.CDLL("libcublas.so.12")`, `libcublasLt.so.12`; import ctranslate2, faster_whisper, kokoro_onnx | PASS (no GPU here: `get_cuda_device_count()` = 0) |
| Workflow | `actionlint .github/workflows/image.yml` (v1.7.7) | PASS |
| Helm lint | `helm lint faukinator/blob -f override.yaml` (image.tag + host); `helm lint faukinator/hermes-agent` | PASS; default values FAIL on purpose (`image.tag is required`) |
| Helm template | `helm template blob faukinator/blob -n blob -f override.yaml`; `--set ingress.enabled=false`; Hermes with `networkPolicy.enabled=false` | PASS (6 objects; 4 without ingress; no NetworkPolicy when disabled) |
| kubeconform | `kubeconform -strict` with the default schemas plus the datreeio CRD catalog, on Blob and Hermes renders | PASS: 10/10 valid, 0 skipped |
| Terraform | `terraform fmt -check blob-secret.tf`; `terraform init -backend=false && terraform validate` in a scratch copy | PASS (only deprecation warnings, the same as the existing files). `fmt -check` on the whole directory fails on `app-of-apps.tf` and `argocd.tf`, which are already unformatted on `origin/main` |
| home_lab CI | none exists (`.github/workflows` absent) | n/a |

## CNI and NetworkPolicy

The CNI is **flannel** (DaemonSets `kube-flannel` and `kube-proxy` only; no Calico or Cilium CRDs).
**Flannel does not enforce NetworkPolicy, so the Hermes policy is INERT today.** Any pod can reach
Hermes on port 8642, and only `API_SERVER_KEY` protects it. The policy is switchable
(`networkPolicy.enabled`) and takes effect once a policy-capable CNI is installed.

## What the coordinator must do before merging home_lab `feat/blob`

1. Merge the meet_blob branch to `main` so `image.yml` pushes `sha-<commit>`. Set that tag in
   `faukinator/blob/values.yaml` (`image.tag`); the chart does not render without it.
2. `terraform apply` (creates namespace `blob` and Secret `blob-secrets`) before Argo CD syncs.
3. Create the pull Secret in namespace `blob`. The package is private (meet_blob is a private repo):
   `kubectl create secret docker-registry github-docker-credentials -n blob --docker-server=ghcr.io --docker-username=<GITHUB_USER> --docker-password=<PAT with read:packages> --docker-email=<EMAIL>`.
   The chart's `imagePullSecrets` already names it. Or make the package public and set
   `imagePullSecrets: []`.
4. Check that `blob.faukinator.com` resolves to Traefik (192.168.1.15); other apps rely on the
   Pi-hole `*.faukinator.com` record.

## Assumptions not verified

- GPU run: CUDA 12.9 user-space with driver 580 (supports up to CUDA 13.0), cuBLAS only (no cuDNN),
  `int8_float16` on the RTX 3050, `large-v3` VRAM, and `nvidia` RuntimeClass injection.
  Fallbacks are one-line tag changes (`runtime`, then `cudnn-runtime`).
- Traefik WebSocket timeouts: Traefik v3 defaults to `readTimeout` 60 s and `idleTimeout` 180 s,
  and home_lab does not override them. The page pings every 20 s. Whether a 60 s read deadline
  cuts the upgraded connection was not tested; fix in `docs/notes/deploy.md` item 3.
- Resource requests and limits (500m / 2 Gi, 6 Gi limit) are estimates.
- The real page build: only the web sources' config was exercised (with a stand-in index.html).

## Deviations from the design and brief

- No cuDNN and a `base` instead of `runtime` CUDA image (evidence: the CTranslate2 4.9.0 binary
  names only `libcublas.so.12` and `libcuda.so.1`).
- `/tmp` must allow exec (phonemizer dlopens a copy of `libespeak-ng.so` from a temp directory).
  The Kubernetes `emptyDir` is fine; Docker needs `--tmpfs /tmp:exec`.
- The chart uses its own headers Middleware instead of `traefik-secure-headers` (that one blocks
  the microphone).
- `image.tag` is required, so `helm lint` with default values fails by design.
- `image.yml` runs only when build inputs change (path filter).
