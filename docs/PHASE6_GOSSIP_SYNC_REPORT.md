# PHASE 6 — GossipSub and distributed synchronization

**Date:** 2026-11-13  
**Status:** COMPLETE  
**Depends on:** Phase 0–5

---

## 1. GossipSub

### Integration
- `@libp2p/gossipsub` as `services.pubsub` when available and `P2P_GOSSIPSUB=true`
- Façade: `src/net/p2p/gossip.js` (`GossipFacade`)

### Features
| Feature | Implementation |
|---------|----------------|
| Topic messaging | `publish(topic, data)` / `subscribe(topic, handler)` |
| Topic policies | `public` / `private` / `local` (local never meshes) |
| Duplicate suppression | in-memory seen-id map (10 min) |
| Rate limiting | per-topic publish/receive (`P2P_GOSSIP_RATE`, default 120/min) |
| Max message size | `P2P_GOSSIP_MAX_MSG` (default 64 KiB) |
| Signed envelope | optional `signature` field in envelope |
| No Internet required | local policy + local handler delivery always works |

Default topics: `cannoi/presence`, `cannoi/events`, `cannoi/sync`.

---

## 2. Distributed sync engine

### Module
`src/net/p2p/sync-engine.js`

### Capabilities
- Event append with per-topic sequential `seq`
- Incremental `listSince(topic, afterSeq)`
- Checkpoints per `(peer_id, topic)` — survive restart
- Conflict resolution: same `(topic, origin, seq)` → **higher `event_id` wins**
- Duplicate protection: PK on `event_id` + UNIQUE `(topic, origin_peer, seq)`
- Policies: `public` | `private` | `local` (local never replicates)
- `buildSyncRequest` / `applySyncBatch` for reconnection catch-up

### Schema (migration 8)
- `p2p_sync_events`
- `p2p_sync_checkpoint`

---

## 3. Adapter API additions

```
publish(topic, data, opts?)
subscribe(topic, handler) → unsubscribe
syncRange(peerId, { topic, after_seq, limit })
appendSyncEvent(topic, body, { policy, signature })
ingestSyncEvent(event)
applySyncBatch(peerId, topic, events)
buildSyncRequest(peerId, topic)
syncStats()
```

`status()` includes `pubsub` and `sync: { events, checkpoints }`.

---

## 4. Config

| Env | Default |
|-----|---------|
| `P2P_GOSSIPSUB` | true |
| `P2P_GOSSIP_MAX_MSG` | 65536 |
| `P2P_GOSSIP_RATE` | 120 |

---

## 5. Files

| File | Role |
|------|------|
| `src/net/p2p/gossip.js` | **New** — GossipSub façade |
| `src/net/p2p/sync-engine.js` | **New** — sync engine |
| `src/net/p2p/libp2p-adapter.js` | Wired pubsub + sync APIs |
| `src/net/p2p/availability.js` | PUBSUB package group |
| `src/db.js` | Migration 8 |
| `src/config.js` | Gossip options |
| `package.json` | `@libp2p/gossipsub` |
| `tests/p2p-gossip-sync.test.js` | **New** — 12 tests |

---

## 6. Test results

```
tests/p2p-gossip-sync.test.js  12/12 pass
```

---

## 7. Ready for Phase 7

**PHASE 7 — Network state manager and automatic transport failover**
