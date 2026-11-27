#!/usr/bin/env bash
set -Eeuo pipefail
IMAGE="${1:?Usage: scripts/smoke-test-image.sh IMAGE}"
NAME="community-hub-smoke-${GITHUB_RUN_ID:-local}-$$"
HOST_PORT="${SMOKE_HOST_PORT:-18080}"
STARTED=0
cleanup() {
  local rc=$?
  if [[ "$STARTED" == "1" ]]; then
    echo "--- container state ---"
    docker inspect "$NAME" --format 'status={{.State.Status}} running={{.State.Running}} exit={{.State.ExitCode}} oom={{.State.OOMKilled}} error={{.State.Error}}' 2>/dev/null || true
    echo "--- logs ---"
    docker logs --timestamps --tail 200 "$NAME" 2>&1 || true
    docker rm -f "$NAME" >/dev/null 2>&1 || true
  fi
  return "$rc"
}
trap cleanup EXIT

if ! docker image inspect "$IMAGE" >/dev/null 2>&1; then
  lower="$(echo "$IMAGE" | tr '[:upper:]' '[:lower:]')"
  if docker image inspect "$lower" >/dev/null 2>&1; then IMAGE="$lower"
  elif docker image inspect community-hub:ci >/dev/null 2>&1; then IMAGE=community-hub:ci
  else echo "Image not found: $IMAGE"; docker images; exit 1
  fi
fi
echo "Smoke image: $IMAGE"
docker run -d --name "$NAME" --publish "${HOST_PORT}:8080" \
  -e NODE_ENV=production -e HOST=0.0.0.0 -e PORT=8080 -e DATA_DIR=/app/data \
  -e P2P_ENABLED=false -e PRESENCE_SERVE=false -e PRESENCE_SEEDS= \
  "$IMAGE" >/dev/null
STARTED=1
for i in $(seq 1 45); do
  running="$(docker inspect "$NAME" --format '{{.State.Running}}' 2>/dev/null || echo false)"
  if [[ "$running" != "true" ]]; then
    echo "Container exited early (attempt $i)"
    docker logs --tail 200 "$NAME" || true
    exit 1
  fi
  if curl -fsS --connect-timeout 2 --max-time 4 "http://127.0.0.1:${HOST_PORT}/health" -o /tmp/ch-health.json; then
    if node -e 'const h=require("/tmp/ch-health.json"); if(h.status!=="ok") process.exit(1); console.log("health ok", h.version, h.role||"");'; then
      echo "Smoke test passed on port 8080"
      exit 0
    fi
  fi
  sleep 2
done
echo "Timeout waiting for /health"
docker logs --tail 200 "$NAME" || true
exit 1
