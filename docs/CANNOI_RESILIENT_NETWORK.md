# CANNOI Resilient Network

**Version:** Community Hub 2.3.0  
**Status:** Phases 0–9 complete (2026-11-13)

Offline-first, decentralized P2P layer for Community Hub. Core Hub (HTTPS federation, social, ledger, presence) remains fully functional when P2P packages are absent.

---

## Design principles

1. **Preserve everything** — no destructive schema changes; HTTPS federation unchanged
2. **Zero mandatory dependency** — libp2p packages are optional; dynamic import + graceful degradation
3. **Offline-first** — local messaging and sync work without Internet
4. **No central relay requirement** — relays are opt-in and independently deployable
5. **Honest limits** — Wi-Fi Direct / Bluetooth are interfaces only until native clients integrate

---

## Architecture (layers)

```
┌─────────────────────────────────────────────┐
│  UI: Network page — compact Link status     │  Phase 8
├─────────────────────────────────────────────┤
│  NetworkStateManager (failover / anti-flap) │  Phase 7
├─────────────────────────────────────────────┤
│  GossipFacade + SyncEngine                  │  Phase 6
│  LocalMessaging (persistent outbox)         │  Phase 5
├─────────────────────────────────────────────┤
│  mDNS / LAN registry / platform transports  │  Phase 4
│  Circuit Relay v2 / DCUtR / AutoNAT         │  Phase 3
│  Kademlia DHT / bootstrap discovery         │  Phase 2
├─────────────────────────────────────────────┤
│  Libp2pAdapter (connection lifecycle)       │  Phase 1
│  NetworkAdapter interface                   │  Phase 0/1
├─────────────────────────────────────────────┤
│  Core Hub: HTTPS federation, ledger, auth   │  unchanged
└─────────────────────────────────────────────┘
```

---

## Network states

| State | Preferred transport |
|-------|---------------------|
| `GLOBAL_ONLINE` | direct |
| `GLOBAL_DEGRADED` | direct_or_relay |
| `LAN_ONLY` | lan |
| `RELAY_ONLY` | relay |
| `RECOVERING` | any |
| `OFFLINE` | store_and_forward |

Downward transitions respect dwell time (default 8s). Leaving `OFFLINE` always passes through `RECOVERING`.

---

## Optional packages

| Group | Packages |
|-------|----------|
| Core | `libp2p`, `@libp2p/websockets`, `@libp2p/noise`, `@libp2p/yamux`, `@libp2p/identify`, `@libp2p/ping`, `@libp2p/peer-id`, `@libp2p/crypto` |
| Discovery | `@libp2p/kad-dht`, `@libp2p/bootstrap` |
| NAT/Relay | `@libp2p/circuit-relay-v2`, `@libp2p/dcutr`, `@libp2p/autonat` |
| LAN | `@libp2p/mdns` |
| Pubsub | `@libp2p/gossipsub` |

Install: `npm install` (all listed in `package.json` dependencies; absent packages simply disable that capability).

---

## Key environment variables

| Variable | Default | Purpose |
|----------|---------|---------|
| `P2P_ENABLED` | false | Master switch |
| `P2P_BOOTSTRAP` | — | Bootstrap multiaddrs |
| `P2P_RELAY` | true | Circuit relay transport |
| `P2P_RELAY_SERVER` | **false** | Act as relay (opt-in) |
| `P2P_MDNS` | true | LAN discovery |
| `P2P_GOSSIPSUB` | true | Topic messaging |
| `P2P_STATE_DWELL_MS` | 8000 | Anti-flap dwell |
| `P2P_STATE_RECOVER_MS` | 5000 | Recovering hold |

See `src/config.js` for the full list.

---

## Schema additions (additive only)

| Migration | Tables |
|-----------|--------|
| 7 | `p2p_outbox`, `p2p_inbox_seen` |
| 8 | `p2p_sync_events`, `p2p_sync_checkpoint` |

---

## Module map

| Path | Role |
|------|------|
| `src/net/adapter/` | NetworkAdapter interface + factory |
| `src/net/p2p/libp2p-adapter.js` | Main P2P adapter |
| `src/net/p2p/availability.js` | Dynamic capability probe |
| `src/net/p2p/policy.js` | Multiaddr validation |
| `src/net/p2p/lan-registry.js` | LAN peer registry |
| `src/net/p2p/local-messaging.js` | Store-and-forward |
| `src/net/p2p/gossip.js` | GossipSub façade |
| `src/net/p2p/sync-engine.js` | Distributed sync |
| `src/net/p2p/network-state.js` | State machine |
| `src/net/p2p/platform-transport.js` | Wi-Fi Direct / BT interface |

---

## Testing

```bash
npm run test:p2p          # all P2P unit/integration tests (no packages required)
npm test                  # full Hub suite
```

Phase reports: `docs/PHASE0_AUDIT_REPORT.md` … `docs/PHASE9_INTEGRATION_REPORT.md`.

---

## Explicit non-goals (this release)

- Claiming direct connectivity for every NAT topology
- Mandatory central relay service
- Native Wi-Fi Direct / Bluetooth on Node.js backend
- Replacing HTTPS federation (both coexist)
