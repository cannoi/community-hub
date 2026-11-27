# Test report — 2.4.0-rc1

Totals (automated): **P2P suite 259 tests: 253 pass / 0 fail / 6 skipped. Application suite 62 tests: 61 pass / 0 fail / 1 skipped.** The 6 P2P skips are the REAL libp2p adapter tests: the libp2p packages cannot be installed in the build sandbox, so the real libp2p transport has never been exercised by these runs.

## Test classes (never mix them up)
| Class | What it is | Used for |
|---|---|---|
| Unit | one module, in process | tokenizer, ranking, crypto, backoff |
| Integration | real Hubs (HTTP federation, SQLite, signed ledger) in one process/machine | delta sync, tombstones, healing, API, security matrix |
| Multi-process simulation | separate OS processes over 127.0.0.1 TCP (stand-in transport, signed envelopes) | replication failover (SIGKILL), cross-region search |
| Algorithmic simulation | real algorithms over synthetic populations | scale 100 … 1,000,000 Hubs |
| Multi-machine real test | several physical hosts | **NOT DONE** |
| Public Internet test | real NAT/relay/WAN | **NOT DONE** |
A simulation is never reported as a real-network result.

## Suites added in Phases 5–8
| File | Tests | Class |
|---|---|---|
| `p2p-index-replication.test.js` | 29 | integration + multi-process (elections, fencing, failover, recovery, rebalance) |
| `p2p-federated-search.test.js` | 32 | integration + multi-process (gate: VN finds JP/EU, privacy, resilience, API) |
| `p2p-delta-sync-healing.test.js` | 30 | integration, real Hubs (delta, tombstones, divergence, healing, replica failover) |
| `phase8-security.test.js` | 11 | attack matrix: fake peer, replay, forged events, oversized/parser bombs, SSRF (http+https), directory poisoning, private content, brute force, slowloris, scale guards |
| `phase8-load-solohost.test.js` | 5 | SoloHost compliance, release hygiene, 192 MB-capped process, 150 concurrent federated sessions |
Also repaired in Phase 8: 7 previously failing tests (stale expectations of the pre-zero-config defaults, probe-back, error codes) — now stronger, plus a real product bug they exposed (per-peer "sync off" was ignored for trusted peers).

## Mutation testing (do the tests have teeth?)
Safety mechanisms were deliberately broken and the suites had to fail: Phase 5 10/10, Phase 6 15/15, Phase 7 22/22, Phase 8 security 6/6 killed. Every first-round survivor produced a new targeted test.

## Measured results (single machine; NOT WAN)
SoloHost probe (192 MB heap cap, 3,000 posts, 240 concurrent HTTP): 0 errors, peak RSS ~118 MB, HTTP p95 ~88 ms, healing cycle ~225 ms, event-loop p99 ~59 ms (max stall ~0.9 s), 0 false integrity findings. Search load (5 Hubs x 4,000 docs, 150 concurrent sessions): p95 ~2.0 s, no errors, no breaker tripped by self-load, RSS +62 MB; most sessions are `partial` because responders rate-limit one requester (honest backpressure).
Defects found by Phase 8 load/scale work and fixed: index backfill held the event loop (p99 lag 8.7 s → 59 ms); backpressure counted as failure and tripped breakers; unbounded search planning cost; Directory/plan O(N log N) per call; Node timeout check every 30 s (now 5 s); one-slow-peer labelled `partial`.

## Not tested (explicit)
Real libp2p; multi-machine; public Internet; NAT/relay; DDoS; real Sybil/eclipse; Raspberry-Pi hardware; browser/mobile rendering of the new UI; external penetration test; dependency vulnerability audit (no network).
