# Deployment notes: decisions, deviations, open issues

Date: 2026-11-12. Scope: design entries 60-67 (image, chart, Argo app, Terraform secret).

## Verified facts (read-only cluster inspection)

- CNI is **flannel** (`kube-system` runs only the `kube-flannel` and `kube-proxy` DaemonSets; no
  Calico or Cilium CRDs). Flannel does **not enforce NetworkPolicy**.
- `kube1` has 1 `nvidia.com/gpu` (RTX 3050, 6 GB, compute 8.6), no taints, driver 580.126.16
  (node label `nvidia.com/cuda.runtime-version.full=13.0`). No pod requests the GPU today, and the
  device plugin does not share it (`sharing-strategy=none`, 1 replica).
- RuntimeClass `nvidia` exists (handler `nvidia`); Talos needs it for GPU containers.
- StorageClasses `ceph-block` and `longhorn` are both default; the chart names `ceph-block`.
- ClusterIssuer `letsencrypt` is Ready. Traefik Middlewares `local-whitelist`, `secure-headers`,
  `no-framing` exist in namespace `traefik`. Apps use `*.faukinator.com`.
- Namespace `blob` does not exist yet.

## Image decisions

- **CUDA base, no cuDNN.** The design assumed CUDA 12 plus cuDNN 9. The CTranslate2 4.9.0 wheel
  that `backend/uv.lock` pins contains no `cudnn` string at all; the only GPU libraries it names are
  `libcublas.so.12` and `libcuda.so.1` (cudart is static). The image therefore uses
  `nvidia/cuda:12.9.1-base-ubuntu24.04` plus the `libcublas-12-9` package. This cut the image from
  7.08 GB (runtime tag) to 2.77 GB on disk (916 MB compressed). Not yet run on the GPU: if the
  first GPU start fails to load a CUDA library, switch to `12.9.1-runtime-ubuntu24.04` (one line);
  if it asks for cuDNN, use `12.9.1-cudnn-runtime-ubuntu24.04`.
- **CUDA 12.9 vs driver 580.** Driver 580 supports CUDA up to 13.0, so a CUDA 12.9 user-space is
  supported. Not verified by a run on kube1.
- **espeak-ng not installed.** kokoro-onnx uses `espeakng-loader`, which bundles the library. A
  real start (faster-whisper `tiny` and Kokoro on CPU) reached `/readyz` 200, which includes a
  Kokoro warm-up synthesis.
- **`/tmp` must allow exec.** phonemizer copies `libespeak-ng.so` into a temporary directory and
  `dlopen`s it. With Docker's default `--tmpfs /tmp` (noexec) the model load fails with
  `failed to map segment from shared object`. A Kubernetes `emptyDir` is not noexec, so the chart
  works; the chart comments this.
- **uv** is bind-mounted from `ghcr.io/astral-sh/uv:0.13.8` during the build, not installed.
- Env defaults: the image sets only the paths that differ from the container layout
  (`STATIC_DIR`, `DEVICES_PATH`) plus `HOST`, `PORT`, `DB_PATH`, `MODEL_DIR` and `HF_HOME`;
  everything else stays in `backend/blob/config.py`.
- Image CI pushes only on `main` and only when build inputs change; a docs-only commit makes no
  new tag.

## Chart decisions (home_lab `faukinator/blob/`)

- Host `blob.faukinator.com`, LAN only: no `router.entrypoints` annotation (binds to the LAN
  entrypoints only) plus `traefik-local-whitelist`.
- `traefik-secure-headers` is **not** used: its `Permissions-Policy` has `microphone=()`, which
  blocks `getUserMedia`. The chart ships its own `blob-headers` Middleware, the same headers with
  `microphone=(self)`. `traefik-no-framing` is used.
- `image.tag` defaults to empty and is `required`: an unset tag fails the render instead of
  deploying `latest`. Consequence: `helm lint` with default values fails on purpose.
- PVC annotated `Prune=false,Delete=false` (ceph-block reclaim policy is Delete), like Hermes.
- Startup probe allows 15 minutes (90 x 10 s) for the first model download.
- Resources: requests 500m CPU / 2 Gi, limit 6 Gi memory, 1 GPU. Not measured; adjust after the
  first real run.
- `automountServiceAccountToken: false`, non-root 10001, read-only root, all capabilities dropped,
  `seccompProfile: RuntimeDefault`.

## Hermes NetworkPolicy

`faukinator/hermes-agent/templates/networkpolicy.yaml` admits only namespace `blob` to the API
port (`networkPolicy.enabled`, default true; `allowedNamespaces`, `extraFrom`).

**It is inert on this cluster: flannel does not enforce NetworkPolicy.** Today any pod in the
cluster can reach Hermes on 8642; only `API_SERVER_KEY` protects it. The policy takes effect once a
policy-capable CNI (Cilium, Calico) is installed. Kubelet probes come from the node and are allowed
by those CNIs by default. `kubectl port-forward` is not affected.

## Open issues and unverified assumptions

1. **No GPU run yet.** CUDA/cuBLAS loading, `int8_float16` on the RTX 3050, VRAM use of
   `large-v3`, and the `nvidia` RuntimeClass injection are verified only on the first real deploy.
2. **ghcr pull credentials.** meet_blob is a private repository, so its package is private. Before
   the first sync, create Secret `github-docker-credentials` (type `docker-registry`, server
   `ghcr.io`, a PAT with `read:packages`) in namespace `blob`; command in home_lab
   `docs/secrets.md`. Alternative: make the package public and set `imagePullSecrets: []`.
3. **Traefik WebSocket timeouts.** The page pings every 20 s. Traefik v3 entrypoints default to
   `readTimeout` 60 s and `idleTimeout` 180 s, and home_lab does not override them. Whether
   `readTimeout` cuts an upgraded WebSocket after 60 s was not verified. Test after deploy: keep
   the page open more than 2 minutes and watch for reconnects. Fix if needed: set
   `ports.websecure.transport.respondingTimeouts.readTimeout: 0` in `applications/traefik.yaml`.
4. **Real page not built in the test.** The web session had no `index.html` yet; the image test
   used the real `web/` sources plus a stand-in `index.html`. The real backend (commit `3f028f6`
   of the backend branch) was used unchanged.
5. **Terraform order.** `blob-secret.tf` creates namespace `blob`; the Argo app also has
   `CreateNamespace=true` (same pattern as Hermes). Run `terraform apply` before the first Argo
   sync, or import the namespace.
6. **Alerts from Hermes (S4).** Nothing gives Hermes the `ALERT_TOKEN` yet; out of scope here.
