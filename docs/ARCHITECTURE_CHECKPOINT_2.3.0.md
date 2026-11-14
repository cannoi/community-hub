# Architecture Checkpoint — Community Hub 2.3.0 Phase 2 (Baseline)

**Date:** 2026-11-13  
**Source ZIP:** community-hub-2.3.0-phase2-wip.zip  
**Purpose:** Document current architecture *before* any CANNOI RESILIENT NETWORK changes.  
**Rule:** No code modifications until this checkpoint is complete and reviewed.

---

## 1. Project Overview

Community Hub is a lightweight, self-hosted community + federated social network designed for Pi SoloHost (Docker).

- **Core principle:** Zero runtime npm dependencies for the main application (Node ≥ 22.13 built-ins only).
- **Identity:** Ed25519 keys, signed events in an append-only hash-chained ledger.
- **Federation:** HTTPS pull-based sync between Hubs.
- **Presence 2.3.0:** Optional global directory seeds for discoverability without bulk content replication.
- **P2P (Phase 2 WIP):** Optional libp2p connection layer (disabled by default).

**Language / UI:** English + Vietnamese, dark/light, mobile-first.

---

## 2. High-Level Layer Structure

```
┌─────────────────────────────────────────────────────────────┐
│  UI (public/)  — app.js / views.js / ui.js / i18n.js         │
├─────────────────────────────────────────────────────────────┤
│  HTTP Routes (src/routes/)  — core, social, federation,     │
│                               presence, admin, media, AI    │
├─────────────────────────────────────────────────────────────┤
│  Domain Services                                            │
│  ├─ Social / Ledger / Materializer / Media / Auth / Keystore│
│  ├─ Federation (peers, transport, protocol, invite)         │
│  └─ Presence (client, directory, remote, seed-server)       │
├─────────────────────────────────────────────────────────────┤
│  Network Adapter (src/net/adapter/)  ← Phase 1 foundation   │
│  ├─ interface.js                                            │
│  ├─ https-adapter.js   (default)                            │
│  ├─ null-adapter.js                                         │
│  └─ index.js (factory)                                      │
├─────────────────────────────────────────────────────────────┤
│  P2P Layer (src/net/p2p/)  ← Phase 2 (incomplete)           │
│  ├─ libp2p-adapter.js                                       │
│  ├─ policy.js (multiaddr safety)                            │
│  ├─ availability.js                                         │
│  └─ ws-gateway.js (HTTP-port WebSocket tunnel)              │
├─────────────────────────────────────────────────────────────┤
│  Storage: SQLite (node:sqlite) + filesystem (uploads/keys)  │
└─────────────────────────────────────────────────────────────┘
```

---

## 3. Existing P2P / Networking Components

### 3.1 Network Adapter (Phase 1 — complete)

| File | Role |
|------|------|
| `src/net/adapter/interface.js` | Abstract `NetworkAdapter` (start/stop, listPeers, connect, publish, subscribe, syncRange, status) |
| `src/net/adapter/https-adapter.js` | Thin façade over existing `PeerManager` + `HttpTransport` |
| `src/net/adapter/null-adapter.js` | No-op when networking disabled |
| `src/net/adapter/index.js` | Factory: Libp2pAdapter → HttpsAdapter → NullAdapter |

**Selection rules (current):**
- `P2P_ENABLED=true` **and** libp2p adapter loadable → `Libp2pAdapter`
- Both federation + P2P disabled → `NullAdapter`
- Otherwise → `HttpsAdapter` (default, production behaviour)

### 3.2 libp2p Adapter (Phase 2 — partial)

**File:** `src/net/p2p/libp2p-adapter.js` (~248 lines)

**Implemented:**
- Dynamic `import()` of ESM-only libp2p packages
- Stable PeerId stored at `keyDir/p2p-peer.pb` (mode 0600, atomic write, quarantine on corruption)
- Transports: WebSockets
- Security: Noise
- Muxer: Yamux
- Services: identify + ping
- Connection manager limits (`maxConnections`, `dialTimeoutMs`)
- Bootstrap dial (best-effort)
- `start()` / `stop()` lifecycle
- `listPeers()`, `connect(multiaddr)`, `disconnect`
- `status()` never exposes private keys or full listen multiaddrs
- Default listen: loopback ephemeral `/ip4/127.0.0.1/tcp/0/ws` (or controlled by policy)
- Connection gater denies private hosts unless explicitly allowed

**Explicitly NOT implemented (by design of Phase 2):**
- Kademlia DHT
- GossipSub
- AutoNAT / DCUtR / hole punching
- Circuit Relay v2
- mDNS / LAN discovery
- Store-and-forward
- Data replication / sync engine
- Network state manager
- Offline queue

### 3.3 Supporting P2P files

| File | Role |
|------|------|
| `src/net/p2p/policy.js` | Pure multiaddr parser + safety checks (no SSRF, no uncontrolled ports) |
| `src/net/p2p/availability.js` | Probes for required libp2p packages via real `import()` |
| `src/net/p2p/ws-gateway.js` | Optional reverse-proxy of WebSocket upgrades arriving on the **existing HTTP port** to the loopback libp2p listener. Off by default (`P2P_WS_GATEWAY=false`) |

### 3.4 Configuration (`src/config.js`)

```js
p2p: {
  enabled: false,                    // default OFF
  maxConnections: 50,
  dialTimeoutMs: 15000,
  bootstrap: [],                     // multiaddrs
  listen: [],                        // default → one loopback ephemeral /ws
  allowPublicListen: false,
  wsGateway: false,
  maxTunnels: 64,
}
```

Environment variables: `P2P_ENABLED`, `P2P_BOOTSTRAP`, `P2P_LISTEN`, `P2P_WS_GATEWAY`, etc.

---

## 4. Presence Architecture (already production)

- `src/presence/client.js` — registers + heartbeats to seeds
- `src/presence/directory.js` — local + remote directory
- `src/presence/record.js` — signed presence records
- `src/presence/remote.js` — on-demand remote content cache
- `src/presence/seed-server.js` — lightweight seed mode
- `src/presence/routes.js` — HTTP endpoints

Presence is **independent** of the P2P layer. It works over HTTPS today.

---

## 5. Federation (HTTPS)

- `src/federation/peers.js` — peer registry, connect, sync cursors
- `src/federation/transport.js` — signed HTTP requests, SSRF protection, retries
- `src/federation/protocol.js` — event exchange protocol
- `src/federation/invite.js` — invite codes

Still the primary inter-Hub communication path when P2P is disabled.

---

## 6. Missing / Incomplete Pieces in the Provided ZIP

| Item | Status | Impact |
|------|--------|--------|
| `package.json` | **Missing** | Cannot run `npm install` or declare libp2p deps cleanly |
| `server.js` | **Missing** | No entry point (hub.js is the composition root) |
| `tests/helpers.js` | **Missing** | Most tests cannot run (they require `startHub`, `Client`, `tmp`, `waitFor`) |
| `docs/` directory | Empty / missing | No deployment / P2P build docs |
| `node_modules` / full lockfile | Absent (by design of Phase 2 reports) | Real libp2p tests cannot execute in this environment without install |
| Full `package-lock.json` | Stub only | — |

These must be restored or reconstructed before Phase 2 verification can be completed.

---

## 7. Current Test Coverage (from reports)

| Suite | Expected | Notes |
|-------|----------|-------|
| Presence | 10/10 | Pass |
| Network adapter | 3/3 | Pass |
| Reliability | 8/8 | Pass |
| p2p-connection | 3 runnable + 4 skip | Skip when libp2p packages absent |
| p2p-policy | Present | Pure policy tests |
| Social / Identity / Hardening | Present | — |

---

## 8. Non-Negotiable Constraints (from mission)

- Preserve all existing Community Hub functionality, UI, API, database, authentication, identity, federation and existing P2P components.
- Reuse existing libp2p adapter, Peer ID, key management, WebSocket Gateway and Presence architecture.
- No destructive database migration.
- No Docker privileged mode / Docker socket access.
- No mandatory public IP / port forwarding for ordinary peers.
- No single central server dependency for local network operation.
- Maintain SoloHost deployment compatibility and existing container ports.
- All new functionality must have automated tests.
- Backward compatible with existing installations.

---

## 9. Target Architecture (from mission — not yet implemented)

Layered networking with automatic failover:

1. Direct P2P over existing Internet connectivity
2. NAT traversal + hole punching
3. Circuit Relay v2
4. Local LAN discovery (mDNS / UDP) when Internet unavailable
5. Wi-Fi Direct / Bluetooth (platform adapters — design only for now)
6. Store-and-Forward for disconnected peers
7. Automatic synchronization when connectivity returns

Network states to implement later:
`GLOBAL_ONLINE | GLOBAL_DEGRADED | RELAY_CONNECTED | LAN_ONLY | MESH_CONNECTED | OFFLINE_QUEUEING | RECOVERING`

---

## 10. Recommended Next Steps (strict order)

1. **Restore missing baseline files** (`package.json`, `server.js`, `tests/helpers.js`) so the project becomes runnable and testable.
2. **Verify Phase 2 connection tests** with real libp2p packages (or document environment limitations).
3. Only then begin **PHASE 1 of the new plan**: Audit existing P2P architecture and repair incomplete components.
4. Proceed phase-by-phase with tests after each phase.

---

**Checkpoint created.** No source code has been modified yet.
