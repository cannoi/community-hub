# PHASE 8 — Compact NETWORK UI section

**Date:** 2026-11-13  
**Status:** COMPLETE  
**Depends on:** Phase 0–7

---

## 1. What was added

### API
`GET /api/sync/status` now includes a compact `p2p` object:

```
enabled, state, preferred_transport, peers, lan_peers,
relay_connections, pending_messages, reachability,
mdns, discovery, pubsub, outbox, last_sync_hint
```

Non-owner users still receive the limited federation summary **plus** the same compact `p2p` strip (no peer management secrets).

### UI (Network page)
A small **Link status** card (`net-p2p-card`) under the existing federation status:

| Shown | Source |
|-------|--------|
| Network state badge | `p2p.state` (Online / Nearby only / Via relay / Offline / …) |
| Link count | `p2p.peers` |
| Nearby peers | `p2p.lan_peers` (only if > 0) |
| Relay links | `p2p.relay_connections` (only if > 0) |
| Waiting queue | `p2p.pending_messages` (only if > 0) |
| Path in use | `p2p.preferred_transport` |
| Active since | `p2p.last_sync_hint` |

Principles followed: compact, non-technical labels, consistent card/badge style, does not dominate the Network page.

### i18n
Full EN + VI keys under `net.p2p.*` (states + transports).

---

## 2. Files

| File | Change |
|------|--------|
| `src/routes/admin.js` | Enrich `/api/sync/status` with `p2p` |
| `public/views.js` | Compact Link status card |
| `public/i18n.js` | EN/VI strings |
| `tests/p2p-network-ui.test.js` | **New** — 4 tests |

---

## 3. Test results

```
tests/p2p-network-ui.test.js  4/4 pass
```

---

## 4. Ready for Phase 9

**PHASE 9 — Integration testing, hardening, documentation**
