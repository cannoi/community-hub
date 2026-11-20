#!/usr/bin/env bash
# Build the P2P test image (deps installed at BUILD time) and run ALL P2P tests inside it with the real packages.
# Strict: REQUIRE_P2P=1 turns a missing package into a FAILURE and the script fails if anything was skipped.
set -euo pipefail
cd "$(dirname "$0")/.."
IMAGE="${IMAGE:-community-hub:p2p-test}"
OUT="${OUT:-p2p-test-evidence.txt}"
command -v docker >/dev/null || { echo "docker not found"; exit 3; }
{
  echo "== docker version =="; docker version --format '{{.Server.Version}}' || true
  echo "== build (deps are installed here, never in the running container) =="
  docker build --no-cache -f Dockerfile.p2p -t "$IMAGE" .
  echo "== image user / size =="; docker image inspect "$IMAGE" --format 'user={{.Config.User}} size={{.Size}}'
  echo "== run tests: non-root, read-only rootfs, no capabilities, no extra ports, no docker socket =="
  docker run --rm --user node --read-only --tmpfs /tmp --tmpfs /app/data:uid=1000,gid=1000 \
    --cap-drop ALL --security-opt no-new-privileges -e REQUIRE_P2P=1 "$IMAGE" \
    sh -c 'node -v && node scripts/p2p-lock-check.js && npm run -s test:p2p:strict'
} 2>&1 | tee "$OUT"
grep -q "^# fail 0" "$OUT"    || { echo "FAIL: some P2P tests failed";   exit 1; }
grep -q "^# skipped 0" "$OUT" || { echo "FAIL: tests were skipped";     exit 1; }
echo "P2P tests: all passed, 0 skipped. Evidence: $OUT"
