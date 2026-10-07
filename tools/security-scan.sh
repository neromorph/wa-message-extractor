#!/usr/bin/env sh
# Local security scan. Mirrors the CI `verify` job's trivy steps.
# Requires: trivy on PATH, built image tagged wa-message-extractor:local.
set -eu

IMAGE="${1:-wa-message-extractor:local}"

echo "--- trivy fs: vuln + secret + misconfig (repo) ---"
trivy fs \
  --scanners vuln,secret,misconfig \
  --severity HIGH,CRITICAL \
  --ignore-unfixed \
  --skip-dirs .git \
  --skip-dirs auth_info \
  --skip-files targets.json \
  --exit-code 1 .

if docker image inspect "$IMAGE" >/dev/null 2>&1; then
  echo "--- trivy image: $IMAGE ---"
  trivy image \
    --severity HIGH,CRITICAL \
    --ignore-unfixed \
    --exit-code 1 "$IMAGE"
else
  echo "--- image $IMAGE not present locally, skipping image scan ---"
  echo "    build it with: docker build -t $IMAGE ."
fi
