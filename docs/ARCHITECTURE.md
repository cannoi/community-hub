# Community Hub — architecture (2.4.0-rc1)

## Principle
Complexity belongs to the network, simplicity to the user. Peer ID = identity, IP/port = replaceable endpoint. Public discovery never implies private data exposure. Everything below reuses ONE libp2p node and the existing signed ledger; there is no second P2P stack.

## Layers
| Layer | Modules | Contract |
|---|---|---|
| Identity & ledger | `src/ledger.js`, `keystore.js`, `materializer.js` | Ed25519-signed, per-actor sequenced events; `posts`/`users` tables are DERIVED (`ledger.reindex()` rebuilds them) |
| Federation (content) | `src/federation/*`, `routes/federation.js` | `/federation/v1/*`: signed requests (time skew, nonce replay cache, audience binding), cursor delta sync, `fillGap`, `heads` (anti-entropy), `snapshot?after=` |
| P2P bootstrap | `src/net/p2p/bootstrap/*`, `hub.js /p2p/*` | `/p2p/bootstrap`, `/p2p/register` (probe-back verified), signed peer records, seeds + peer exchange |
| Connectivity | `src/net/p2p/libp2p-adapter.js`, `self-heal.js`, `network-state.js`, `trust-engine.js` | Honest states (Discovered/Reachable/Connected/Authenticated/Syncing/Synced/Degraded/Offline), NAT/relay fallback, trust-gated quotas |
| Distributed index (Ph5) | `distributed-index.js`, `index-replication.js`, `index-governor.js`, `index-crypto.js` | `/cannoi/index/1.0.0`: epoch-fenced primary election, signed log replication, tombstones, snapshot merge. OFF by default (`P2P_INDEX_REPLICATION=1`) |
| Federated search (Ph6) | `federated-search.js`, `search-text.js`, `search-ranking.js`, `post-indexer.js` | `/cannoi/search/1.0.0`: Local→Regional→Language→Topic→Global, every remote result re-verified (hash + origin signature) |
| Delta & healing (Ph7) | `presence/remote.js`, `federation/delta.js`, `net/p2p/self-healing.js` | durable tombstones, delta snapshots, anti-entropy, audit→repair supervisor, quarantine of corrupt rows (never delete originals) |
| Release (Ph8) | `scripts/scale-sim.js`, `release-check.js`, `tests/phase8-*` | simulation, load, SoloHost and attack-matrix tests |

## Trust boundaries
1. Transport peer identity (libp2p Noise / signed federation headers) — authenticates WHO is calling.
2. Content signatures (account key for ledger events, Hub key for index documents/votes/tombstones) — authenticate WHAT, independent of who relays it.
3. Origin Hub — the only authority for access control and for releasing full content; replicas serve self-verifying signed events only.
4. Trust Engine states (NEW/PROBATION/TRUSTED/LIMITED/QUARANTINED/BLOCKED) gate quotas and election eligibility, never ranking.

## Data classes
PUBLIC (indexed, replicated, searchable) · PRIVATE/followers/group/DM (never indexed, never replicated, never served to other Hubs). Enforced at write time (`DistributedIndex`), at index time (`PostIndexer`), at serve time (`isStillPublic`, `contentProvider`) and tested in `tests/phase8-security.test.js` D7.

## Storage (additive migrations 10–12)
`p2p_index_documents/terms/shards/assignments` (10) · `origin_sig`, `p2p_index_tombstones`, `p2p_index_shard_state`, `p2p_index_oplog` (11) · `remote_tombstones`, `integrity_findings`, `events_quarantine`, `remote_actors.snap_seq` (12). `p2p_index_meta` is created on demand (tokenizer version).

## Safety invariants (each has tests; see TEST_REPORT.md)
1. Never two writers for one shard: epoch fencing + durable one-vote-per-epoch + joint quorum + lease self-fence + storage-level write guard.
2. A deleted post never reappears: durable tombstones in index, discovery cache and content fetches.
3. Originals are never deleted by self-healing; corrupt rows are replaced only by verified copies and the old row is quarantined.
4. Backpressure is throttling, not failure: a healthy peer saying `busy` never trips a breaker.
5. Every background job is time-boxed, bounded and non-overlapping.

## Known design limits (see RELEASE_SCORECARD.md)
Independent shard plans from partial views disagree; the 24-peer budget covers the index only up to ~1,000 Hubs; no relay-based query anonymity; DDoS resistance is application-level only.
