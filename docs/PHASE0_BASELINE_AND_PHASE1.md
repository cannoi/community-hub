# Phase 0 baseline + Phase 1 zero-config (2.3.22)

## Phase 0 — Audit

### Existing components (reused, not replaced)
| Area | Location |
|------|----------|
| Peer identity | libp2p-adapter + keyDir |
| Bootstrap / seeds | bootstrap/manager, providers, fixedSeeds |
| Peer directory | peer-record, seed-routes, probe |
| WS gateway | ws-gateway.js (same HTTP port) |
| Transport | libp2p + HTTPS federation |
| Presence | presence module |
| Feed/explore/search | existing social routes |
| SQLite data | unchanged |

### Baseline tests (this environment)
- p2p-address-advertise, p2p-probe, p2p-same-ip-local: **9/9 PASS**
- Full libp2p multi-machine Internet test: **not run here** (no dual real hosts in CI sandbox)

### Critical gap found
- `src/config.js` had `P2P_ENABLED` default **false** while Dockerfile set true → non-Docker / SoloHost env without explicit env could run **without** P2P stack.

## Phase 1 — Zero-config bootstrap (delivered)
1. **P2P_ENABLED default true** (opt-out with `P2P_ENABLED=false`)
2. **ZeroConfigEngine** — UX states only: connecting / discovering / connected / syncing / degraded / reconnecting / offline
3. APIs: `GET /api/network/ux` (user), `GET /api/network/diagnostics` (owner)
4. Network simple UI shows UX label (EN+VI); no Peer ID / multiaddr in normal view
5. Keeps built-in seed `http://14.176.78.46:8181`, probe-back, same-IP local rewrite, public post sync default ON

## Not in this phase (later gates)
- Full DNS/HTTPS multi-manifest discovery productization
- Geo-lingual index shards / federated global search ranking
- Trust engine NEW→TRUSTED full matrix
- 100k–1M hub scale simulation

## Rollback
- Set `P2P_ENABLED=false` and/or `HUB_CONTENT_SYNC=off`
- Remove ZCE: optional; hub runs without `hub.zce`
