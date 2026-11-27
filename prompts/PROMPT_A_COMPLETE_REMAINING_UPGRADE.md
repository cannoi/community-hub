# PROMPT A — Complete the remaining upgrade of Community Hub (2.4.0-rc1 → release)

> Hướng dẫn: dán toàn bộ phần trong khung "PROMPT" bên dưới cho AI coder (Claude Code / Codex…), kèm ZIP `community-hub-2_4_0-rc1`. Prompt này được viết sau khi rà soát toàn bộ Phase 0–8; nó chỉ chứa những phần CÒN THIẾU hoặc CHƯA ĐƯỢC CHỨNG MINH.

---------------------------------------------------------------- PROMPT ----------------------------------------------------------------

ROLE: Senior distributed-systems + Node.js engineer. Work directly on the original Community Hub source (Node >= 22.13, zero build step, SQLite via node:sqlite, libp2p 3.x). Read these first: `docs/ARCHITECTURE.md`, `docs/RELEASE_SCORECARD.md`, `docs/TEST_REPORT.md`, `docs/SCALE_SIMULATION_RESULTS.md`, `docs/PHASE5_COMPLETION_REPORT.md`, `docs/PHASE6_FEDERATED_SEARCH_REPORT.md`, `docs/PHASE7_DELTA_SYNC_SELF_HEALING_REPORT.md`, `docs/PHASE8_SCALE_RELEASE_REPORT.md`, `RELEASE_NOTES.md`.

CURRENT STATE (verified by tests): 314 pass / 0 fail / 7 skipped. The 6 P2P skips are the REAL libp2p tests — libp2p was never installed in the build sandbox, so the real libp2p transport/signing path (`src/net/p2p/libp2p-adapter.js`, `index-governor.js: Libp2pIndexTransport`, `index-crypto.js: createLibp2pSigner`) has NEVER been run. Scorecard 57/100; target >= 90. Everything proven so far is single-machine (integration, loopback, 127.0.0.1 multi-process, algorithmic simulation).

NON-NEGOTIABLE RULES: preserve all working features, user data, API and UI; additive migrations only; no second P2P stack; no privileged containers / docker.sock; no secrets in code; never claim real-network success from simulation; never mark PASS because code was written — only because evidence exists (logs, request/response captures, test output). Keep EN+VI i18n in sync (test `tests/hardening.test.js` enforces key parity). Any change to a safety mechanism needs a test that FAILS when the mechanism is removed (mutation-style) — previous phases did this for 53 mutants; keep the practice.

## WORK PACKAGES (do in order; each ends with a report: what was checked, changed, files, tests, PASS/FAIL, risk, rollback)

### WP1 — Make real libp2p testable and prove it (closes scorecard B1-part, +up to 20 points)
1. Install real dependencies with network access (`npm ci` after WP6). Run the full suite: the 6 skipped tests must RUN and pass. Fix every failure in the real adapter.
2. Verify against the real libp2p 3.x API (do not trust the code): `compat.handlerArgs/readStream/writeStream`, `stream.closeWrite()` half-close request/response used by `Libp2pIndexTransport.request`, `dialProtocol` AbortSignal, `createLibp2pSigner` (`@libp2p/peer-id` `peerIdFromString(...).publicKey.verify`) for Ed25519 AND secp256k1, handler `connection.remotePeer`. Add contract tests that run only when libp2p is installed.
3. Fix the confirmed production error `TypeError: addr.getPeerId is not a function` raised from the mDNS discovery path (reported on the 2.3.28 Hub): identify the real address type delivered by `@libp2p/mdns` 11.x events, handle `Multiaddr`, string and `{id, multiaddrs}` shapes safely, never let one bad record break discovery; add regression tests with all shapes.
4. Real multi-process test on one host with real libp2p (3 Hubs, WebSocket transport): dial, protocol `/cannoi/index/1.0.0` and `/cannoi/search/1.0.0` request/response, replication failover with SIGKILL. Label it "multi-process, real libp2p".

### WP2 — Real multi-machine and public-Internet validation (the 20-point gap)
Provide `scripts/field-test/` (bash + node) and a runbook to execute the acceptance tests A (zero-config), B (cross-region: VN Hub finds JP and EU public posts without friending), C (resilience: bootstrap/directory/index node/replica/relay offline, IP change, Internet loss), D (security), E (data integrity), F (resource) on >= 3 REAL hosts in different networks (at least one behind NAT, one with public IP). Capture and commit evidence: commands, timestamps, request/response bodies, logs, `GET /p2p/bootstrap`, `GET /api/admin/healing`. Classify each result with the test classes in `docs/TEST_REPORT.md`. If hosts are unavailable, deliver the runbook + scripts and mark every item NOT RUN — never fabricate.

### WP3 — Design limits found by the scale simulation (docs/SCALE_SIMULATION_RESULTS.md)
a) Plan agreement under partial views collapses (50% view → 4.6% same top-3). Implement distribution of shard assignments via a SIGNED MANIFEST published by anchor/index nodes (`applyIndexShardManifest` exists) and make `adoptIndexAssignments` prefer a verified manifest over local computation; keep local computation only for near-complete views. Test: 60 Hubs with random partial views converge on the manifest's plan.
b) Search coverage: the 24-peer budget covers the whole index only up to ~1,000 Hubs (49 peers needed at 10,000). Choose and implement ONE: a bounded set of Index Nodes hosting many shards (target cover <= 24 peers at 100,000 Hubs), or an adaptive session budget for strong Hubs. Prove with `npm run sim:scale` (extend it) and keep the resource governor limits.
c) Wire peer metadata: registry/peer records do not yet carry region/languages/topics/capacity. Add signed, validated optional fields (backward compatible with old records), feed `adapter.setSearchPeerHints()` from them, and use real capacity for `rebalance` candidates. Never trust unsigned hints for security decisions.
d) Add a healer for Phase 5 replica health (under-replicated / fenced shards) that calls `rebalance` with verified candidates, with the same backoff + retry-budget + derived-only guard as `HealingSupervisor`.

### WP4 — Self-healing gaps (Phase 7)
`chain_broken` caused by a MISSING predecessor is detected but not repaired: implement repair by fetching the missing range from a peer and inserting it through the ledger (verified), never deleting. Make ledger-audit batch adaptive to the time budget so a 1M-event ledger completes a pass in hours, not days. Tune peer-quarantine thresholds using a replay of recorded counters; document defaults. Add Prometheus-style metrics export (`/api/admin/metrics`, owner only) for findings, cycles, breaker states, throttling, replication epochs.

### WP5 — UI and UX honesty (closes B3)
Verify the Explore "Network" tab and the Developer Diagnostics page in real browsers (desktop + a phone), EN and VI, light/dark, 320 px width: no overflow, accessible labels, keyboard use. Add a minimal diagnostics view for `/api/admin/healing` (hidden by default). Map the data-plane lifecycle and the transport states onto the user-facing states: Connecting to Community Network / Discovering Hubs / Connected / Synchronizing / Network Degraded / Reconnecting / Offline — never show IPs, Peer IDs, shards or NAT info in the normal UI. Add Playwright (or equivalent, dev-dependency only) smoke tests.

### WP6 — Supply chain and release hygiene (closes B2)
Generate and commit a real `package-lock.json` (`npm install --package-lock-only`), exact-pin every dependency, run `npm audit` and fix or document each finding, build the Docker image with `--ignore-scripts`, add SBOM generation and a CI workflow running `npm ci`, `npm run release:check -- --full`, `npm run sim:scale -- --quick`. `npm run release:check` must exit 0.

### WP7 — Security follow-ups
Independent review checklist for: signed-record replay across networks (`network` field), election vote replay across shards/epochs, content-type confusion in `/p2p/register`, resource limits on every `/federation/v1/*` and `/p2p/*` route, query-privacy (peers see search terms): design and, if feasible, implement relay-routed or batched queries behind a flag. Document honestly that application-level limits do not stop network-level DDoS (needs Relay/infrastructure protection).

### WP8 — Final gate
Re-run everything, update `docs/RELEASE_SCORECARD.md` with new evidence (do not inflate), regenerate the ZIP + SHA-256, update `RELEASE_NOTES.md`, `docs/MIGRATION_ROLLBACK.md`.

## DELIVERABLES
Source ZIP; list of changed files; root cause and fix per defect; migration details (additive only); test results with pass/fail/skip counts and test classes; field-test evidence or an explicit NOT RUN list; updated scorecard; rollback instructions; remaining risks. Continue until every verifiable requirement passes; clearly list anything that depends on unavailable hardware, credentials or external services.
