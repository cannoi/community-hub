#!/usr/bin/env bash
# A — Zero-config: start Hub with only HUB_PUBLIC_URL / P2P_PUBLIC_PORT; no manual peer list.
set -euo pipefail
URL="${1:-http://127.0.0.1:28090}"
echo "== health =="; curl -sS "$URL/health" | head -c 500; echo
echo "== bootstrap =="; curl -sS "$URL/p2p/bootstrap" | head -c 800; echo
echo "Record: status should not stay 'p2p-unavailable' when P2P_ENABLED=true and packages installed."
echo "CLASS: field-real-network (or integration-loopback if only localhost)"
