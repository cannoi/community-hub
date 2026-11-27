# PHASE 5 — Distributed Public Index Foundation (2.3.26)

## Status
**FOUNDATION IMPLEMENTED — RELEASE GATE NOT YET PASSED.** This phase adds a bounded local public-content inverted index and deterministic shard/replica coordination primitives. It does not claim automatic multi-Hub replication is operational; a production transport workflow and multi-machine failover test remain required.

## Audit findings carried forward
- Phase 4 directory (`src/net/p2p/bootstrap/directory.js`) is an in-memory peer metadata directory, not a post index.
- Existing `SyncEngine` replicates bounded topic events/checkpoints; it is not a content search index.
- Existing `posts` and ledger tables remain the source of truth. No existing content rows are rewritten or deleted by this phase.
- Existing trust engine is reused for assignment eligibility; only verified `TRUSTED` candidates are eligible for primary/replica planning.

## Delivered
- `src/net/p2p/distributed-index.js`: bounded local inverted index, normalized Vietnamese tokenization, PUBLIC-only admission, content hash checks, deterministic shard IDs, shard digests, rendezvous assignment plans, signed-manifest verifier hook, and bounded shard snapshot export/import.
- `src/db.js`: additive migration 10 creates index documents, term postings, shard metadata and assignment tables. Existing migrations are unchanged.
- `src/net/p2p/libp2p-adapter.js`: exposes index methods and diagnostics on the existing adapter; no second P2P stack.
- `tests/p2p-distributed-index.test.js`: seven unit/integration tests.

## Privacy and integrity
- Private/group/direct-message records are rejected unless explicitly marked `visibility: public`; no DM/group routes are wired to this index.
- Remote documents require a caller-provided verified flag; remote shard manifests/snapshots additionally require a configured verifier callback. The transport must bind that callback to the existing Peer identity/signature verification before enabling remote ingestion.
- Snapshot digest is recomputed before import. Hash mismatch and shard mismatch are rejected.
- Index is metadata/search cache only; the origin remains authoritative for access checks and full content.

## Tests
`node --test tests/p2p-distributed-index.test.js` — **7/7 PASS**.

## Not yet complete / blockers
- No automatic assignment execution or shard transfer protocol is wired to live peer connections.
- No periodic rebalance, shard split/merge scheduler, or replica health/failover loop yet.
- No multi-process or real multi-machine replication test.
- Baseline regression findings: `npm run test:p2p` = 137 PASS / 6 FAIL / 6 SKIP (149 total). The six failures are pre-existing contract mismatches: three tests expect P2P disabled by default although current zero-config config enables it; bootstrap descriptor status string mismatch; bootstrap test registration relies on a probe path that returns unverified; and standalone seed registration test expects acceptance without the live probe succeeding. Full `npm test` also exposed i18n EN/VI key parity and a presence sync error-code mismatch, then exceeded the 240-second execution window. These are release blockers and must be triaged before release. The lockfile is also a pre-existing minimal stub and could not be regenerated in this offline environment; Docker currently resolves dependencies with `npm install`, but a reproducible lockfile is still required.

## Gate decision
**PHASE 5 = IN PROGRESS / BLOCKED.** Local index correctness tests pass, but the required replica recovery and multi-Hub integrity gates are not demonstrated. Proceed to Phase 6 only after the live shard transport, automatic assignment/rebalance, and replica recovery gates are implemented and tested.

## Rollback
- Stop the new version and restore the pre-upgrade data backup if required.
- Migration 10 is additive. It does not alter or delete posts, users, groups, events, or existing P2P tables.
- A code rollback to 2.3.25 leaves only the additional `p2p_index_*` tables, which the older application ignores.
