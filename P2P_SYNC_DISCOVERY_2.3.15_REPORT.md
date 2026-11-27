# Community Hub 2.3.15 — Discovery & Sync Repair Report

## Root causes found

1. `PeerCrawler` excluded peers already connected at libp2p level. That prevented stable, reachable Hubs from being used as bridge nodes to discover further peers.
2. Federation `tick()` did not schedule `discovered` peers, leaving newly found contacts inert until manually added as trusted.
3. `syncPeer()` returned immediately after a handshake-only check when content sync was disabled, without running peer discovery.
4. `/federation/v1/peers` tied peer-list discovery to bulk content-sync permission. That conflated metadata discovery with replication of public content.
5. Public content sync was intentionally opt-in in the backend but the Network UI had no visible global/per-peer controls, so users could not easily enable it.

## Changes

- Connected peers are now eligible and preferred for bounded P2P bootstrap crawling.
- Successful signed handshakes trigger endpoint/peer discovery even when bulk content replication is off.
- `discovered` peers receive scheduled signed handshakes with backoff.
- Authenticated, non-blocked peers can request a limited rendezvous list; the list contains only the local Hub and trusted/bootstrap peers with verified health and public endpoints.
- Added owner controls for global public-content sync and per-peer opt-in. The default remains `off` to preserve privacy.
- Added visible P2P dial-error diagnostics and changed the federation summary wording to “verified” rather than “connected”.

## Privacy and behavior

- Discovery metadata (public endpoint hints) is separate from bulk content replication.
- Public event replication remains opt-in at both global and per-peer levels. Both Hubs must enable it.
- Private messages and private/local events are not shared.
- Discovered contacts remain distinct from trusted peers.
- A verified Federation handshake does not mean a live libp2p socket; the UI now distinguishes those states.

## Validation

- Added a three-Hub integration test: A knows B, B knows C; A discovers C through B with content sync disabled, then handshakes C.
- Added a crawl test confirming connected peers are used as bridge nodes.
- Added UI contract tests for the sync controls and P2P dial error.
- See test results in the accompanying build report.

## Not proven in this build environment

- Real Internet connectivity between separate SoloHost installations and NAT/router behavior.
- Live libp2p WebSocket transport test if libp2p runtime packages are unavailable in the test container.
- Automatic public-content replication before the owner enables the global and per-peer opt-in controls.

## Test run summary

- `npm run test:p2p`: 141 tests; 135 passed, 6 skipped, 0 failed. The 6 skipped tests require libp2p runtime packages, which could not be installed in this isolated build environment.
- `tests/presence/presence.test.js` + `tests/p2p-peer-crawl.test.js`: 19 passed, 0 failed in the focused run.
- `tests/network-ui-fixes.test.js`: 3 passed, 0 failed.
- Full `npm test`: 197 tests; 190 passed, 6 skipped, 1 failed. The single failure is the pre-existing optional external AI-provider test (`tests/assistant.test.js` expects provider `custom` but receives `local`). This is outside P2P and was deliberately not modified.
- `node --check` was run on all changed JavaScript files.
- `npm ci` timed out in this environment, so the actual libp2p two-Hub socket tests could not be executed here. No Docker build or real public-Internet test is claimed.
- After the final endpoint-sharing restriction and retry-timestamp adjustment, the focused discovery/sync/UI suite was rerun: 22 passed, 0 failed. The final full-suite rerun exceeded the execution time limit after test 191; the earlier complete full-suite run produced the totals above.
