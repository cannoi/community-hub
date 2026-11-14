#!/usr/bin/env bash
# Generate / refresh package-lock.json for the libp2p stack. Run ONCE on a machine WITH registry access
# (a throw-away `docker run --rm -v "$PWD":/w -w /w node:22-alpine sh scripts/p2p-lock.sh` is fine). Never run it in production.
set -euo pipefail
cd "$(dirname "$0")/.."
node -e "if (+process.versions.node.split('.')[0] < 22) { console.error('Node >= 22 required'); process.exit(1); }"
[ -f package-lock.json ] && cp package-lock.json "package-lock.json.bak-$(date +%s)"       # non-destructive
npm install --package-lock-only --ignore-scripts --no-audit --no-fund                      # resolves + pins + records sha512 (no node_modules written)
node scripts/p2p-lock-check.js                                                              # pinned, https registry, integrity everywhere
npm ci --omit=dev --ignore-scripts --no-audit --no-fund --dry-run >/dev/null                # lock and package.json agree
echo "--- npm audit (production deps) ---"
npm audit --omit=dev --audit-level=high || { echo "AUDIT reported high/critical findings: review before committing the lock"; exit 2; }
echo "--- direct dependencies and their resolved versions ---"
node -e "const l=require('./package-lock.json').packages; for (const [k,v] of Object.entries(l)) if (k.split('node_modules/').length===2) console.log(k.replace('node_modules/',''), v.version, v.license||'')" | sort | head -80
echo "OK: commit package-lock.json, then run scripts/p2p-docker-test.sh"
