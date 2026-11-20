# AUTO-BOOTSTRAP Phase 1 — Audit

**Date:** 2026-11-14  
**Baseline:** CANNOI Resilient Network (Phases 0–9)

## Existing components (reuse)

| Component | Location | Role |
|-----------|----------|------|
| Libp2pAdapter | `src/net/p2p/libp2p-adapter.js` | Connection, DHT, relay, mDNS |
| LanRegistry | `src/net/p2p/lan-registry.js` | LAN peer tracking |
| NetworkStateManager | `src/net/p2p/network-state.js` | GLOBAL_ONLINE…OFFLINE |
| LocalMessaging | `src/net/p2p/local-messaging.js` | Offline queue |
| SyncEngine | `src/net/p2p/sync-engine.js` | Event sync |
| GossipFacade | `src/net/p2p/gossip.js` | Pubsub |
| Policy | `src/net/p2p/policy.js` | Multiaddr validation |
| Config | `src/config.js` | `P2P_BOOTSTRAP`, `P2P_RELAY_BOOTSTRAP` |
| DB migrations 7–8 | `src/db.js` | outbox + sync tables |

## Gaps vs mission

1. No multi-source Bootstrap Provider abstraction
2. No persistent previously-known peer database (only in-memory `_knownPeers`)
3. No signed HTTPS seed manifest
4. No DNS seed provider
5. No CANNOI Peer Registration / signed Peer Records
6. No distinction infrastructure-bootstrap vs CANNOI community peers
7. No WAITING_FOR_FIRST_PEER / NETWORK_JOINED onboarding states
8. No peer exchange protocol
9. Bootstrap list is config-only (`P2P_BOOTSTRAP`)

## First-node constraint

Single computer, no existing peers. User public endpoint for seed: `http://14.176.78.46:28090`.

## Plan

Implement phases 2–10 incrementally on top of existing adapter without rewrite.
