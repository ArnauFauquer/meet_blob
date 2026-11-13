#!/usr/bin/env bash
# Prints the one-time install link for a device (and a QR code if qrencode is installed).
# Usage: scripts/pair-url.sh [device] [host]   (needs kubectl access to namespace blob)
set -euo pipefail
export PATH="$HOME/.local/bin:$PATH"
device=${1:-tablet}; host=${2:-blob.faukinator.com}
tok=$(kubectl -n blob get secret blob-secrets -o jsonpath='{.data.DEVICE_TOKEN}' | base64 -d)
url="https://$host/#t=$tok&device=$device"
echo "$url"
command -v qrencode >/dev/null && qrencode -t ANSIUTF8 "$url"
