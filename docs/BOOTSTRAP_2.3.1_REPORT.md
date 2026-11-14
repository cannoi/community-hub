# Community Hub 2.3.1 — Bootstrap Upgrade Report

## Implemented

- Fixed the configured rendezvous URL to `http://14.176.78.46:28090`.
- Added public read-only `GET /p2p/bootstrap`. It returns CANNOI network/protocol, current Peer ID, public WebSocket multiaddr, and a bounded list of registered public peers.
- Added rate-limited `POST /p2p/register`. It validates network, expiry, Peer ID/multiaddr binding, and rejects private/LAN addresses before accepting a discovery hint.
- HTTP(S) fixed-seed providers now resolve the descriptor instead of treating an HTTP URL as a dialable P2P multiaddr.
- Each running node publishes its public peer record to configured HTTP rendezvous seeds. The seed stores records and shares the bounded peer list with new nodes.
- Bootstrap skips the local Peer ID so a node does not dial itself.
- Public multiaddrs are derived from `HUB_PUBLIC_URL` and the existing WebSocket gateway. Loopback ephemeral listener addresses are never advertised.
- Docker Compose enables P2P and the WebSocket gateway by default, using the existing app port; no extra port is published.
- Docker image build now installs the pinned libp2p runtime packages. Previously the image copied source but did not install those packages, leaving P2P unavailable in the container.
- Simplified the Network bootstrap summary by removing provider-count and last-discovery technical details.
- Added data/ and private runtime state to `.dockerignore`; the distributable ZIP excludes database, WAL/SHM, uploads and identity keys. The named Docker volume remains unchanged.

## Verification

- Bootstrap-specific tests: **21/21 passed**.
- Existing P2P regression suite: **87/87 passed**.
- Full suite: **138 passed, 15 failed, 6 skipped**.
- The original uploaded 2.3.0 source was tested separately: **131 passed, the same 15 failed, 6 skipped**. The 15 failures therefore reproduce on the supplied baseline and are outside this bootstrap change. They include existing test-helper/API mismatches, AI provider expectation, and existing presence/content/media assertions.
- JavaScript syntax checks are run for every `.js` file before packaging.

## Not verified / remaining

- The build environment could not reach `registry.npmjs.org` (`EAI_AGAIN`), so libp2p packages could not be installed locally and a Docker image build could not be run here. The Dockerfile now runs `npm install --omit=dev` using the exact direct dependency versions in `package.json`; a network-enabled image build is still required.
- The supplied `/health` result proves HTTP health only. External WebSocket Upgrade support through the SoloHost reverse proxy has not been tested from a second Internet host.
- `GET /p2p/bootstrap` reports `advertised`, not verified-online. After deployment, it must return at least one public multiaddr and a second independent node must successfully dial it before the seed is considered operational.
- Nodes behind restrictive/symmetric NAT may still need a separately configured public Circuit Relay. Automatic relay-server selection/relay fallback across arbitrary NAT topologies is not claimed as complete in this release.
- The source ZIP's original `package-lock.json` was incomplete (root metadata only, no libp2p dependency tree). This environment could not regenerate it due DNS/network failure. The Docker image build uses `npm install` to resolve the exact pinned direct dependencies and refresh the lock inside the image; run `npm install` in a network-enabled development environment to refresh the repository lockfile as well.

## Deployment requirements

1. Deploy the updated image/source with the supplied Compose configuration.
2. Ensure `HUB_PUBLIC_URL=http://14.176.78.46:28090` (or the actual public root URL if it changes).
3. Ensure the reverse proxy forwards WebSocket Upgrade requests on `/` to the app port. Do not expose the ephemeral loopback libp2p listener as a separate port.
4. Check `/health`, then `/p2p/bootstrap`. The latter should show `status: advertised`, a Peer ID and a multiaddr ending in `/p2p/<same Peer ID>`.
5. Start a second Hub on another Internet connection and verify it registers, appears in the seed peer list, and establishes a real P2P connection.

## Scope preservation

No changes were made to the social feed, profiles, groups, messaging UI, AI service behavior, assistant language detection, Presence content policy, ledger, or account model. The only UI change is removal of low-value technical Bootstrap details from the Network summary.
