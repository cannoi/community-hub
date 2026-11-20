#!/bin/sh
set -eu
DATA="${DATA_DIR:-/app/data}"
mkdir -p "$DATA" "$DATA/uploads" "$DATA/keys" 2>/dev/null || true
exec node server.js
