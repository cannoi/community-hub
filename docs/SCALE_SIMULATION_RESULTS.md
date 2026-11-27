# Scale simulation (acceptance G) — results

**TEST CLASS: algorithmic simulation on one machine.** The REAL rendezvous / RegionalDirectory code runs over synthetic populations (100 … 1,000,000 Hubs); search latency is a Monte-Carlo model. It is **not** a network test: no sockets, NAT, real latency or adversary. 1,000,000 Hubs is partly EXTRAPOLATED (8 of 64 shards computed exactly, time x8). Re-run: `npm run sim:scale` (raw data: `docs/SCALE_SIMULATION_RESULTS.json`).
Population: 60% weak (host nothing) / 30% medium (8 shards) / 10% strong (32 shards); 70% TRUSTED; 64 shards; replication 3.

## A. Shard assignment (global plan over all eligible hosts)
| Hubs | Eligible hosts | Plan time | Shards under-replicated (with caps) | Max shards on one host | Slots moved when 5% of hosts leave |
|---|---|---|---|---|---|
| 100 | 28 | 11 ms | 0 | 32 | 2.6% (ideal 5%) |
| 1,000 | 283 | 20 ms | 0 | 6 | 10.9% (ideal 5%) |
| 10,000 | 2,805 | 231 ms | 0 | 4 | 1.6% (ideal 5%) |
| 100,000 | 27,880 | 2,126 ms | 0 | 2 | 6.3% (ideal 5%) |
| 1,000,000 | 279,751 | 25,794 ms (extrapolated) | — | — | — |

Reading: rendezvous placement moves roughly the churned share, balances well, and is never under-replicated in this model. A Hub never computes the global plan; it only scores the (bounded) candidates it knows.

## A2. FINDING — plan agreement collapses when Hubs see only part of the network
| Candidate view per Hub | Two Hubs agree on primary | Agree on full top-3 |
|---|---|---|
| 100% view | 100% | 100% |
| 50% view | 33.7% | 4.6% |
| 10% view | 6.9% | 0.1% |
| 1% view | 0.6% | 0% |

Consequence: shard plans must NOT be computed independently from partial views. Phase 5 elections tolerate this (voters without a plan accept a trusted, member-listed candidate; voters with a plan require the candidate to be in it), but replication should be enabled only where plans are distributed identically (signed manifest from index/anchor nodes) or views are near-complete. Replication stays OFF by default.

## B. Search reach
| Hubs | Reach with no replicas (24 peers + local) | Peers needed to contact every shard |
|---|---|---|
| 100 | 25% | 5 |
| 1,000 | 2.5% | 23 |
| 10,000 | 0.25% | 49 |
| 100,000 | 0.03% | 61 |
| 1,000,000 | 0% | not computed (>100k); bounded by 64 shards x R=3 hosts |

FINDING: the 24-peer session budget covers the whole index only up to ~1,000 Hubs; at 10,000 Hubs 49 peers are needed. Independent per-shard placement spreads shards thinly; `capacityPower` (3 or 6) was measured and does NOT reduce the cover size. Real fixes are design changes (bounded set of Index Nodes hosting many shards, or a larger budget for strong Hubs) — see the prompt in `prompts/`.
Latency model (stage fan-out 6, 2.5 s timeout for a failed peer): first remote result p50 ~30 ms / p95 ~58 ms at any size; local results are immediate; time-to-complete p50 ~3.1 s / p95 ~7.6 s when 5% of peers fail (each failed peer costs a full timeout), ~10 s when 30% fail. One slow peer among many is now reported as `complete`, not `partial` (>=25% lost is `partial`).

## C. Directory (real `RegionalDirectory`)
| Entries | Insert rate | Query p50 / p95 | Heap |
|---|---|---|---|
| 5,000 | 70,225/s | 1.1 / 32.4 ms | -14 MB |
| 50,000 | 100,806/s | 9.5 / 18.6 ms | 36.2 MB |
| 100,000 | 112,778/s | 25 / 45.4 ms | 106.5 MB |

Pages are capped at 20 entries; the Hub-side peer cache is bounded. Queries filter by cursor first and select only the page (was: sort the whole directory per query).

## What this does NOT prove
Real latency, packet loss, NAT/relay behaviour, gossip/DHT convergence, eclipse/Sybil resistance at scale, or any behaviour of 1,000,000 real Hubs.
