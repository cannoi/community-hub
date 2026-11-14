# PHASE 3 — NAT traversal, hole punching and Circuit Relay v2

**Date:** 2026-11-13  
**Status:** COMPLETE (code + tests; live verification needs packages)  
**Depends on:** Phase 0–2

---

## 1. What was implemented

### Circuit Relay v2
- `circuitRelayTransport()` added to transports when packages available and `P2P_RELAY=true` (default)
- Listen on `/p2p-circuit` so the node can receive relayed inbound connections
- **Relay server is opt-in only** (`P2P_RELAY_SERVER=true`) — never mandatory, never a central dependency
- Configurable `P2P_RELAY_MAX_RESERVATIONS` (default 15)

### DCUtR (hole punching)
- `dcutr()` service when `@libp2p/dcutr` is present and `P2P_DCUTR=true` (default)
- After a relayed connection is established, DCUtR attempts to upgrade to a direct path

### AutoNAT
- `autoNAT()` service when `@libp2p/autonat` is present and `P2P_AUTONAT=true` (default)
- `status().reachability`: `unknown | public | private`

### Relay selection & fallback
- `P2P_RELAY_BOOTSTRAP` — explicit list of known relay multiaddrs
- Known relays tracked in `_knownRelays`
- `connectViaRelay(targetPeerId, relayMultiaddr)` helper
- Reconnect loop: direct first → fallback via known relays
- `listPeers()` marks `meta.via_relay`

### Honest limits (documented, not faked)
- Not every NAT topology supports direct connectivity
- Symmetric NAT / double-NAT often remain relay-only
- Relay nodes must be independently deployed by operators
- Ordinary peers never require a specific central relay

---

## 2. Config additions

| Env | Default | Meaning |
|-----|---------|---------|
| `P2P_RELAY` | true | Enable circuit relay transport |
| `P2P_RELAY_SERVER` | **false** | Act as a relay server (opt-in) |
| `P2P_RELAY_MAX_RESERVATIONS` | 15 | Max concurrent reservations (server) |
| `P2P_DCUTR` | true | Enable hole punching |
| `P2P_AUTONAT` | true | Enable AutoNAT |
| `P2P_RELAY_BOOTSTRAP` | (empty) | Known relay multiaddrs |

---

## 3. status() new fields

```
nat_relay, nat_relay_missing, relay_server, relay_connections,
known_relays, reachability
```

---

## 4. Files changed

| File | Change |
|------|--------|
| `src/net/p2p/libp2p-adapter.js` | Relay transport/server, DCUtR, AutoNAT, connectViaRelay, reachability |
| `src/net/p2p/availability.js` | NAT_RELAY package group |
| `src/config.js` | Relay / DCUtR / AutoNAT options |
| `package.json` | `@libp2p/circuit-relay-v2`, `@libp2p/dcutr`, `@libp2p/autonat` |
| `tests/p2p-nat-relay.test.js` | New — 8 tests |

---

## 5. Test results

```
tests/p2p-nat-relay.test.js      8/8 pass
tests/p2p-discovery.test.js      8/8 pass
tests/p2p-phase1-repair.test.js  9/9 pass
Total Phase 1–3 related:        25/25 pass
```

---

## 6. Ready for Phase 4

**PHASE 4 — Independent LAN discovery and offline messaging**
