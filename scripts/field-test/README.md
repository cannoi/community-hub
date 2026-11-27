# Field tests — Community Hub 2.4.0

**Class labels (docs/TEST_REPORT.md):** `unit` · `integration-loopback` · `multi-process-libp2p` · `field-real-network`

This directory is the runbook for **WP2**. Results on real multi-region hosts must be captured here or under `docs/field-evidence/`.  
If hosts are unavailable, mark items **NOT RUN** — never invent PASS.

## Prerequisites
- ≥ 3 hosts on different networks (ideally: 1 public IP, 1 NAT, 1 other region)
- Docker or Node ≥ 22.13 with `npm ci`
- Image/tag under test recorded (git SHA + version)

## Acceptance suites
| ID | Goal | Command |
|----|------|---------|
| A | Zero-config join | `./scripts/field-test/a-zero-config.sh` |
| B | Cross-region public posts without friending | `./scripts/field-test/b-cross-region.sh` |
| C | Resilience (seed/directory offline, IP change) | manual steps in script comments |
| D | Security probes | `node scripts/field-test/d-security-smoke.js` |
| E | Data integrity (tombstone, no resurrection) | `node scripts/field-test/e-integrity-smoke.js` |
| F | Resource governor under load | `npm run sim:scale -- --quick` + field note |

## Evidence to capture
For each host: `curl -sS $URL/health`, `$URL/p2p/bootstrap`, timestamps, peer counts, sync event counts, `GET /api/admin/healing` (owner session).
