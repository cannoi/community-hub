# Community Hub 2.3.14 — P2P Bootstrap Repair Report

## Scope and source

- Base: the uploaded `Community Hub 2.3.13` ZIP (`community-hub-2_3_13-restore-zip-explore-fix`).
- Release: `2.3.14`.
- Scope: P2P bootstrap, discovery, peer registration, endpoint advertisement, deployment port mapping, and regression-test reliability.
- No production UI, account, posts, Explore, restore, chat, AI provider, or content-sync feature was intentionally redesigned.

## Root causes confirmed in source

1. **AutoNAT / WebSocket Gateway mismatch.** The libp2p listener is deliberately bound to loopback and exposed through the HTTP/WebSocket gateway. AutoNAT inspects the loopback listener and can therefore report `private`. `BootstrapManager._publishLocalRecord()` previously required `getReachability() === 'public'`, suppressing publication even when the Hub had a valid public gateway multiaddr.
2. **Public URL port was overwritten.** `_advertisedMultiaddrs()` previously replaced an explicit port in `HUB_PUBLIC_URL` with the configured/default `P2P_PUBLIC_PORT`. A Hub displayed as `:8182` could consequently advertise `:8181` for P2P dialing.
3. **Self-peer pollution.** A Hub could store its own descriptor as a remote peer and spend crawl/dial attempts on itself.
4. **Misleading registration timestamp.** `last_registration_at` was updated when the local record was refreshed, not when a remote seed/Hub actually accepted it.
5. **Shutdown lifecycle.** The adapter did not await bootstrap-manager shutdown, allowing an in-flight discovery cycle to outlive the Hub stop operation.

## Changes implemented

### Discovery and registration

- Keep the `peer-crawl.js` module and integrate it with the persistent peer database.
- Derive the HTTP(S) crawl endpoint from a validated public WS multiaddr; HTTP and WS share the same externally published port.
- Query up to `P2P_CRAWL_PER_CYCLE` peers per crawl round (default 4), preferring the least recently queried peer.
- Skip already-connected peers and this Hub's own Peer ID.
- Apply exponential crawl backoff to failed peers; successful crawls clear the peer's crawl backoff.
- Retain smart dialing: four concurrent dials per batch, up to ten candidates while below `P2P_MIN_PEERS` (default 3), with connected/backoff peers excluded.
- Retain adaptive discovery intervals while below the minimum peer target, returning to a 30-second steady interval once the target is reached.
- Publish a local record when it contains at least one validated public gateway multiaddr; do not use loopback AutoNAT reachability as the publication gate.
- Publish to configured rendezvous seeds and up to three additional known public Hubs.
- Update `last_registration_at` only after at least one remote registration request succeeds.
- Do not persist or crawl this Hub as a remote peer.

### Endpoint and address safety

- An explicit port in `HUB_PUBLIC_URL` / `PUBLIC_URL` is authoritative for the advertised P2P multiaddr.
- If the public URL has no explicit port, use `P2P_PUBLIC_PORT`, then `HOST_PORT`, then the 8181 fallback.
- Public peer records continue to fail closed on malformed, LAN, loopback, link-local, or otherwise non-public multiaddrs.
- `acceptExchange()` checks each address and requires the multiaddr Peer ID to match the record Peer ID before storing it.
- `/p2p/bootstrap` continues to expose only public peer addresses.

### Deployment

- Compose now maps `${HOST_PORT:-8181}:8080` so separate Hub instances can use distinct host ports.
- Compose leaves `P2P_PUBLIC_PORT` optional and exposes `P2P_PEER_CRAWL`, `P2P_CRAWL_PER_CYCLE`, and `P2P_MIN_PEERS` with defaults.
- Removed the Dockerfile's hard-coded `P2P_PUBLIC_PORT=8181`, which otherwise overrode per-instance port selection.
- Each Hub instance must have its own persistent data volume and its own public URL/port.
- The generic config fallback for `P2P_ENABLED` remains `false` to preserve the HTTPS-first local/test behavior; the supplied Dockerfile and SoloHost Compose explicitly enable P2P. Set `P2P_ENABLED=true` when deploying outside those profiles.

### Shutdown and test harness

- Bootstrap shutdown now awaits the active discovery cycle; the adapter awaits the bootstrap manager's stop operation.
- Test helper fixes: support buffer/native-FormData multipart uploads, expose Fetch-like header/body helpers, and disable external public-IP probes during isolated tests. These are test harness changes, not changes to the production upload or public-IP detection behavior.
- Stabilized the Presence P6 test against the manager's already-in-flight scheduled handshake.

## Verification

### P2P suite

`npm run test:p2p`

- 140 tests total
- 134 passed
- 0 failed
- 6 skipped
- The six skipped cases require the real libp2p packages to be installed in this local test environment; they cover live transport/dial/lifecycle behavior.

### Full application suite

`npm test`

- 195 tests total
- 188 passed
- 1 failed
- 6 skipped

The one remaining failure is `tests/assistant.test.js` — “optional external model (OpenAI-compatible)”. The supplied ZIP contains `lib/ai-module/ai-service.js` as a deliberate stub (`configured()` always returns false and `saveSettings()` is a no-op). The test expects a functioning custom AI provider. This is a pre-existing non-P2P limitation in the supplied source; the AI module was not rewritten because that would violate the requested P2P-only change boundary. The language-detection/local helper test passes. A later repeat of the aggregate command stalled after the Presence P7 output; the Presence suite was rerun separately and passed 11/11, while the P2P suite passed again.

### Other checks

- Focused bootstrap + crawl + deployment tests: 35/35 passed before the final Dockerfile/config precedence adjustment; the P2P suite was rerun after the adjustment and passed as above.
- Presence suite: 11/11 passed after test-harness fixes.
- Reliability suite: 8/8 passed after test-harness fixes.
- Social suite: 6/6 passed after test-harness fixes.
- Identity suite: 5/5 passed after response-header test-helper compatibility was restored.
- Six libp2p-dependent live tests remain skipped locally; no live Internet multi-Hub or NAT-hairpin test was possible in this environment.

## Two-Hub same-public-IP test setup

For two Hub instances sharing one public IP:

- Hub A: host port `8182`, `HUB_PUBLIC_URL=http://14.176.78.46:8182`, `HOST_PORT=8182`.
- Hub B: host port `8181`, `HUB_PUBLIC_URL=http://14.176.78.46:8181`, `HOST_PORT=8181`.
- Both can use `P2P_FIXED_SEEDS=http://14.176.78.46:8181` for this test arrangement; Hub B is the rendezvous endpoint and Hub A registers there.
- Use separate Compose project names and separate data volumes. Never mount the same `/app/data` volume into both Hubs.
- Forward TCP 8181 and TCP 8182 from the router to the same host, mapping each to its corresponding Hub container's port 8080.
- The router must support NAT loopback/hairpin for both local containers to dial the same public IP. If it does not, validate the P2P dial from a third device on another Internet connection.

A shared IP with two ports is two endpoints, not two independent failure domains. If both Hub instances and the router are on one physical machine/network, they can still fail together. For seed-outage resilience at network scale, configure multiple seeds on independent public hosts.

## Not verified / remaining

- Real libp2p transport connectivity between two public SoloHost installations, WebSocket gateway traversal, NAT hairpin, and seed-outage recovery have not been demonstrated live from this environment.
- The six libp2p-dependent tests were skipped because the required libp2p modules are not installed in this test runtime. The production Docker build installs the pinned modules, but a Docker image build was not executed here.
- The supplied AI service remains a stub; custom provider settings and external AI execution are not functional in this source ZIP.
- The built-in default rendezvous list still has one seed. Multiple seeds are configurable through `P2P_FIXED_SEEDS`; true seed redundancy requires independent hosts.
