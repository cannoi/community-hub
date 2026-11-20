# PHASE 7 — Network state manager and automatic transport failover

**Date:** 2026-11-13  
**Status:** COMPLETE  
**Depends on:** Phase 0–6

---

## 1. Formal network states

| State | Meaning |
|-------|---------|
| `GLOBAL_ONLINE` | Public reachability + healthy direct peers |
| `GLOBAL_DEGRADED` | Some Internet path, unstable or mostly relayed |
| `LAN_ONLY` | Local/mDNS peers only; no working Internet path |
| `RELAY_ONLY` | Only relayed connections |
| `OFFLINE` | No peers, no path |
| `RECOVERING` | Transitioning upward after failure |

---

## 2. Transport preference (highest first)

1. **LAN / local direct** (`lan`)
2. **Internet direct** (`direct`)
3. **Relayed** (`relay`)
4. **Store-and-forward** (`store_and_forward`)

`preferredTransport()` returns the recommendation for outbound work.

---

## 3. Anti-flapping

- **Dwell time** (`P2P_STATE_DWELL_MS`, default 8s): downward transitions blocked until elapsed
- **Recover time** (`P2P_STATE_RECOVER_MS`, default 5s): must stay in `RECOVERING` before promotion
- Upward transitions are fast, but always pass through `RECOVERING` when leaving `OFFLINE`
- Signal hysteresis: refuse pure OFFLINE while LAN peers still known

---

## 4. Integration

- Health loop collects signals (peers, direct/relay split, LAN registry, reachability, pending messages)
- `evaluate()` on each health tick and after start/stop
- `onTransition`: when leaving OFFLINE, flush offline message queue
- Reconnect loop respects preferred transport order (LAN/direct first, relay later)

---

## 5. API

```
adapter.networkState()        → full snapshot
adapter.preferredTransport()  → string
status().network_state
status().preferred_transport
```

---

## 6. Config

| Env | Default |
|-----|---------|
| `P2P_STATE_DWELL_MS` | 8000 |
| `P2P_STATE_RECOVER_MS` | 5000 |

---

## 7. Files

| File | Role |
|------|------|
| `src/net/p2p/network-state.js` | **New** — state machine |
| `src/net/p2p/libp2p-adapter.js` | Wired evaluation + failover order |
| `src/config.js` | dwell / recover options |
| `tests/p2p-network-state.test.js` | **New** — 11 tests |

---

## 8. Test results

```
tests/p2p-network-state.test.js  11/11 pass
```

---

## 9. Ready for Phase 8

**PHASE 8 — Compact NETWORK UI section**
