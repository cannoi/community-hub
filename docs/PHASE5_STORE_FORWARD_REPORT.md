# PHASE 5 — Store-and-Forward and persistent message delivery

**Date:** 2026-11-13  
**Status:** COMPLETE  
**Depends on:** Phase 0–4

---

## 1. What was implemented

### Persistent outbox (`p2p_outbox`)
- Additive migration **id 7** (`p2p-offline-outbox`) — no destructive changes
- States: `queued → sending → delivered | failed`
- Fields: unique `id`, `to_peer`, `from_peer`, `msg_type`, `payload`, `attempts`, `max_attempts`, `next_attempt_at`, `expires_at`, `order_key`, timestamps, `last_error`

### Deduplication
- Outbox: same message id is not inserted twice
- Inbox: `p2p_inbox_seen` table prevents reprocessing received messages

### Retry & expiration
- Exponential backoff (5s base → 15min max) + jitter
- `max_attempts` (default 20) → `failed` (never silent discard)
- TTL (default 7 days) → `failed` with `last_error=expired`
- Cleanup of old delivered / seen records

### Ordering
- Monotonic `order_key` per process; flush processes in order

### Transactional writes
- Uses `db.tx()` for enqueue
- Works with existing SQLite WAL mode

### Integration
- `LocalMessaging` accepts optional `db` from Hub via adapter factory
- In-memory fallback when `db` is null (tests / edge cases)
- Health loop continues to call `flush()` on reconnect
- `status().outbox` exposes `{ queued, sending, delivered, failed }`
- `listPendingMessages()`, `outboxStats()`

---

## 2. Guarantees

| Rule | How |
|------|-----|
| Never silent discard | Failed messages stay with state=`failed` and reason |
| Unique IDs | 16-byte hex `newMsgId()` |
| No infinite retry | `max_attempts` hard stop |
| Ordering | `order_key ASC` on flush |
| Dedup | PK on outbox id + inbox_seen table |
| Non-destructive schema | `CREATE TABLE IF NOT EXISTS` only |

---

## 3. Files changed

| File | Change |
|------|--------|
| `src/db.js` | Migration 7: `p2p_outbox`, `p2p_inbox_seen` |
| `src/net/p2p/local-messaging.js` | Full persistent engine |
| `src/net/p2p/libp2p-adapter.js` | db injection, outbox stats API |
| `src/net/adapter/index.js` | Pass `hub.db` into Libp2pAdapter |
| `tests/p2p-store-forward.test.js` | **New** — 9 tests |

---

## 4. Test results

```
tests/p2p-store-forward.test.js  9/9 pass
```

---

## 5. Ready for Phase 6

**PHASE 6 — GossipSub and distributed synchronization**
