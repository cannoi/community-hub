# PHASE 2 — libp2p Connection  (Community Hub 2.3.0)

**Date:** 2026-11-03  
**Scope:** Phase 2 only (connection lifecycle). No DHT, GossipSub, NAT/relay, media replication.

## 1. Verification of prior work

- Presence 2.3.0 + Phase 1 Network Adapter confirmed in source (Presence module, adapter interface/HTTPS/null, hub.net wiring, 10 Presence tests + 3 adapter tests).
- Source restored from `community-hub-2.3.0-phase1.zip` after environment filesystem instability during dependency install.

## 2. Registry / dependency status

| Check | Result |
|-------|--------|
| `npm ping` (configured registry) | OK historically |
| `curl https://registry.npmjs.org/libp2p` | HTTP 200, version 3.5.1 available |
| Default npm registry in this sandbox | `http://35.245.43.102/npm/` (mirror) — hangs |
| Forced `--registry https://registry.npmjs.org` | Starts resolving packages but **does not complete** within 120s in this environment (stalls ~60 packages, no lockfile written, main `libp2p` package never lands) |
| Manual tarball download via curl | OK (all 8 primary packages downloaded) |
| `npm install` from local tarballs / full tree | Does not finish (sandbox I/O + npm process instability) |

**Conclusion:** Registry is reachable, but **this environment cannot complete `npm install` / produce a reliable `node_modules` + lockfile**. Per instructions: dependency-requiring runtime verification is **stopped**; no pure-Node DHT/GossipSub substitute was written.

**Declared dependencies** (package.json — versions chosen for Node ≥22.13 / libp2p 3.x):

```
libp2p@3.5.1
@libp2p/websockets@10.1.25
@libp2p/noise@17.0.7
@libp2p/yamux@8.0.7
@libp2p/identify@4.1.18
@libp2p/ping@3.1.17
@libp2p/peer-id@6.0.18
@libp2p/crypto@5.2.0
```

Operator must run `npm install --registry https://registry.npmjs.org` on a normal machine to populate `node_modules` and lockfile.

## 3. What was implemented (code)

### Added
- `src/net/p2p/libp2p-adapter.js` — Libp2pAdapter implementing NetworkAdapter
  - Dynamic `import()` of ESM packages (Hub remains CommonJS)
  - Stable PeerId stored under `keyDir/p2p-peer.pb` (separate from Hub Ed25519 signing key; file mode 0o600)
  - WebSockets transport, Noise, Yamux, identify, ping
  - Connection manager limits (`maxConnections`, `dialTimeoutMs`)
  - Bootstrap dial (best-effort)
  - start / stop lifecycle, listPeers, connect(multiaddr), disconnect
  - status() never exposes private key material
  - Default listen: `/ip4/0.0.0.0/tcp/0/ws` (ephemeral; **no extra fixed TCP port** on Hub HTTP 8080)
- `tests/p2p-connection.test.js` — 7 tests (4 skip when modules absent)

### Updated
- `src/net/adapter/index.js` — selects Libp2pAdapter when `P2P_ENABLED=true`, else HTTPS/Null
- `src/config.js` — `p2p.maxConnections`, `dialTimeoutMs`, `bootstrap`, `listen`
- `package.json` — dependency list + `test:p2p` script
- `tests/reliability.test.js` E30 — allowlist libp2p packages (zero-dep policy intentionally relaxed for Phase 2+)
- `.npmrc` — force official registry

### Unchanged (as required)
- HTTPS federation, Presence, social, ledger, identity Ed25519, port 8080, SoloHost, no Docker socket/privileged, no DB schema change
- P2P **off by default** (`P2P_ENABLED=false`)

## 4. Tests actually run in this environment

| Suite | Result |
|-------|--------|
| net-adapter (3) | 3/3 pass |
| p2p-connection (7) | 3/3 runnable pass; **4 skipped** (libp2p packages not installed) |
| Presence (10) | 10/10 pass |
| Reliability (8) | 8/8 pass (E30 updated) |

**Not verified here:** real two-Hub dial, PeerId persistence across restart with live libp2p, RAM impact, Docker image with deps, multi-machine.

## 5. How to finish dependency install (operator)

```bash
cd community-hub
npm install --registry https://registry.npmjs.org
# then:
P2P_ENABLED=true npm run test:p2p
P2P_ENABLED=true node server.js
```

## 6. Remaining risks / next conditions for Phase 3

- Complete `npm install` + commit lockfile on a machine with working registry access.
- Validate createLibp2p privateKey/PeerId API against the installed 3.5.1 types (adapter uses defensive loading; may need small adjustments after first successful start).
- Phase 3 (Kademlia DHT) must not start until Phase 2 connection tests pass with real modules.

## 7. Files touched (Phase 2)

```
src/net/p2p/libp2p-adapter.js          (new)
src/net/adapter/index.js               (updated)
src/config.js                          (updated)
package.json                           (updated)
.npmrc                                 (new)
tests/p2p-connection.test.js           (new)
tests/reliability.test.js              (E30)
PHASE2_REPORT.md                       (this file)
```
