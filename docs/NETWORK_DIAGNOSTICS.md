# Network diagnostics (Developer Diagnostics — hidden from the normal UI)

| Question | Where to look |
|---|---|
| Is this Hub reachable / which address does it advertise? | `GET /p2p/bootstrap` → `peer_id`, `multiaddrs`, `address_verified`, `status` |
| Which peers does it know? | `GET /p2p/bootstrap` (`peers`), owner UI Network page |
| Is federation handshake working? | `GET /federation/v1/hello?nonce=<random>` must return 200 with account/endpoint/signature (no nonce → 400, by design) |
| Is data syncing? | `GET /api/admin/healing` → `state`, `peers` (discovered/authenticated/syncing/synced/degraded/offline), `backlog.gaps` |
| Anything corrupt or diverged? | `findings_recent` and `findings` counts; table `integrity_findings`; quarantined rows in `events_quarantine` |
| Anti-entropy / delta stats | `anti_entropy` and `remote_cache` blocks in the same response |
| Search layer health | libp2p adapter diagnostics: `federated_search` (metrics: requests, failures, throttled, breaker_skips), `index_replication` (roles/epochs/lease) |

States are honest: `Connected` is never reported from a peer list alone; `synced` requires a successful sync; `degraded` appears when a critical finding is unresolved or every healthy path is paused.
Typical probes: `curl -s localhost:8181/p2p/bootstrap | jq`, `curl -s localhost:8181/federation/v1/hello?nonce=abc123`. Never POST to `/p2p/register` of a production registry to "test" it.
