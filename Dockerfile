# syntax=docker/dockerfile:1
# Blob image: the backend (FastAPI, faster-whisper, kokoro-onnx) plus the built page.
# Build from the repository root:  docker build -t blob .
# Models are NOT in the image; they download to MODEL_DIR (/data/models, the PVC) on first start.

# --- Stage 1: build the page -------------------------------------------------
FROM node:24.22.3-trixie-slim AS web
WORKDIR /src/web
COPY web/package.json web/package-lock.json ./
RUN --mount=type=cache,target=/root/.npm npm ci
COPY web/ ./
# The page build may read the protocol version from the backend package (design entry 14).
COPY backend/blob/__init__.py /src/backend/blob/__init__.py
RUN npm run build

# --- Stage 2: runtime ---------------------------------------------------------
# CTranslate2 4.9.0 (pinned by backend/uv.lock) dlopens libcublas.so.12 and libcuda.so.1 and
# has no cuDNN reference (cudart is static), so the CUDA "base" image plus cuBLAS is enough.
# The "runtime" image (3.5 GB more: cuFFT, cuSPARSE, NPP...) also works if this ever fails.
# kokoro-onnx and the faster-whisper VAD use the CPU onnxruntime. Switching to onnxruntime-gpu
# needs cuDNN 9: use the 12.9.1-cudnn-runtime-ubuntu24.04 tag then.
# kube1's driver (580) supports CUDA <= 13.0.
FROM nvidia/cuda:12.9.1-base-ubuntu24.04

# One line per system package. espeak-ng is not needed: kokoro-onnx bundles it via espeakng-loader.
# tzdata: the chart sets TZ (quiet hours are local time).
# libcublas: same version the 12.9.1 runtime image ships.
RUN apt-get update \
 && DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends \
      libcublas-12-9=12.9.1.4-1 \
      python3.12 \
      ca-certificates \
      tzdata \
 && rm -rf /var/lib/apt/lists/*

ENV UV_COMPILE_BYTECODE=1 \
    UV_LINK_MODE=copy \
    UV_PYTHON=/usr/bin/python3.12 \
    UV_PYTHON_DOWNLOADS=never \
    UV_PROJECT_ENVIRONMENT=/app/.venv

WORKDIR /app/backend
# Dependencies first (cached layer), then the project itself. uv is bind-mounted, not installed.
RUN --mount=from=ghcr.io/astral-sh/uv:0.13.8,source=/uv,target=/bin/uv \
    --mount=type=cache,target=/root/.cache/uv \
    --mount=type=bind,source=backend/pyproject.toml,target=pyproject.toml \
    --mount=type=bind,source=backend/uv.lock,target=uv.lock \
    uv sync --frozen --no-dev --no-install-project
COPY backend/ ./
RUN --mount=from=ghcr.io/astral-sh/uv:0.13.8,source=/uv,target=/bin/uv \
    --mount=type=cache,target=/root/.cache/uv \
    uv sync --frozen --no-dev --no-editable \
 && rm -rf /app/backend

COPY --from=web /src/web/dist /app/web/dist

RUN useradd --uid 10001 --user-group --no-create-home --home-dir /tmp --shell /usr/sbin/nologin blob \
 && mkdir -p /data /config \
 && chown 10001:10001 /data

# Paths match the chart: PVC at /data, devices ConfigMap at /config/devices.json.
# Other settings keep the defaults in backend/blob/config.py (one source of truth).
# HOME and HF_HOME keep library caches off the read-only root filesystem.
ENV PATH=/app/.venv/bin:$PATH \
    PYTHONUNBUFFERED=1 \
    PYTHONDONTWRITEBYTECODE=1 \
    HOME=/tmp \
    HOST=0.0.0.0 \
    PORT=8000 \
    DB_PATH=/data/blob.db \
    MODEL_DIR=/data/models \
    HF_HOME=/data/models/huggingface \
    STATIC_DIR=/app/web/dist \
    DEVICES_PATH=/config/devices.json

WORKDIR /app
USER 10001:10001
VOLUME ["/data"]
EXPOSE 8000
ENTRYPOINT ["blob"]
