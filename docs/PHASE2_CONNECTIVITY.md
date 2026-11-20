# Phase 2 — Automatic P2P Connectivity (2.3.23)

## Delivered
1. **SelfHealEngine** (`src/net/p2p/self-heal.js`)
   - Peer lifecycle: discovered → reachable → connected → authenticated → syncing → synced → degraded/offline
   - Dial fail streak → exponential backoff + jitter
   - After 3 fails → relay escalation (`forcePreferRelay` + reconnect)
   - Public IP change detection → refresh advertised endpoint
2. Wired into **Libp2pAdapter** health/reconnect loops
3. **NetworkStateManager.forcePreferRelay()** soft-degrades path preference
4. Diagnostics via `p2p.self_heal` and `/api/network/diagnostics`
5. Logs to AI network ring (`ip_change`, `heal_relay`, dial results)

## Gate status
| Gate | Result |
|------|--------|
| User no manual config | PASS (zero-config path) |
| Unit: self-heal / IP change / relay escalate | PASS |
| Multi-network / real NAT / real relay Internet | **NOT claimed** — requires dual hosts on public net |
| Peer offline recovery logic | PASS (code path + unit) |

## Rollback
- `P2P_ENABLED=false` disables stack
- Self-heal stops with adapter stop; no schema migration

## Next (Phase 3)
Trust engine, rate limits, quarantine, anti-abuse quotas
