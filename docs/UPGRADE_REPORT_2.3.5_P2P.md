# Community Hub 2.3.5 — P2P discovery and seed-role deployment repair

Baseline: `community-hub-2.3.4-p2p-network-fix.zip` (the 2.3.4 source supplied for this repair).

## Findings

1. The source configuration defaulted `P2P_ENABLED=false` and `P2P_WS_GATEWAY=false`. The Compose file enabled both, but a ZIP/Dockerfile deployment did not. This made the two deployment paths behave differently.
2. The Compose file defaulted both `HUB_PUBLIC_URL` and `PUBLIC_URL` to the shared rendezvous server `http://14.176.78.46:28090`. These variables describe the individual Hub's own public endpoint. They must not point every Hub to the same rendezvous address; each peer would advertise the wrong WebSocket destination.
3. The full Community Hub exposes `/p2p/bootstrap` and `/p2p/register`, but `/presence/v1/*` is mounted only when `PRESENCE_SERVE=true`. The Dockerfile/Compose deployment did not consistently enable this role. A successful `/health` response does not establish that the directory APIs are available.
4. The supplied Docker log ending at `#11 exporting to image` contains successful install/module-check steps and no failure message. The log excerpt is incomplete; it does not prove a Docker build failure.

## Changes

- Docker image now defaults to `P2P_ENABLED=true`, `P2P_WS_GATEWAY=true`, and `PRESENCE_SERVE=true`. Each remains explicitly disableable through its environment variable.
- Compose keeps `PRESENCE_SEEDS` and `P2P_FIXED_SEEDS` pointed at the shared rendezvous server, but leaves `HUB_PUBLIC_URL` and `PUBLIC_URL` empty unless the operator supplies the current Hub's own public root URL.
- Compose enables the bounded Presence directory role by default.
- AI product knowledge now explains the distinction between the shared seed URL and each Hub's own advertised URL, and does not treat `/health` as proof of directory/P2P readiness.
- Added a multi-Hub integration test: two Hubs register with a full Community Hub acting as the directory, then one discovers the other's account.
- Added deployment-contract tests for Docker and Compose defaults.

## Preservation

No database migration or schema change. No social/feed/post/media, identity, backup, chat, UI, English/Vietnamese dictionaries, AI provider, or Feedback Hub implementation was changed. Existing volumes and data paths remain the same. Docker remains non-root (`USER node`) and uses the existing HTTP port for the WebSocket gateway.

## Verification

- `npm run test:p2p`: **94 passed, 0 failed**.
- Focused deployment + presence + bootstrap tests: **44 passed, 1 failed**. The only failure is the pre-existing P5 on-demand-content test; the same test fails on the untouched 2.3.4 ZIP. Both new deployment-contract tests and the new full-Hub directory integration test pass.
- `npm test`: **157 passed, 15 failed, 6 skipped** (178 total). Running the untouched 2.3.4 baseline from the original ZIP produced **154 passed, the same 15 failed, 6 skipped** (175 total). The three additional tests in this release pass. The 15 failures are pre-existing baseline test issues, not introduced by this patch.
- JavaScript syntax: **104/104 files passed**. Compose YAML parse: **passed**. Package/lock version consistency: **passed**.
- `npm install` could not be completed in this environment because npm registry DNS resolution returned `EAI_AGAIN`; the supplied 2.3.4 lockfile was not regenerated. The GitHub Actions log supplied by the user already shows the pinned dependencies installing and the GossipSub import check passing.
- Docker is unavailable here, and the live seed endpoint could not be reached from this environment. Therefore a real Docker image build, GitHub Actions run, GHCR push, and public-network peer connection remain unverified.

## Required deployment notes

- Deploy this release on the rendezvous Hub at `14.176.78.46:28090` as well as on client Hubs so the seed has `/presence/v1/*` and P2P registry support enabled.
- Each public client Hub must advertise its own reachable root URL in `HUB_PUBLIC_URL` or `PUBLIC_URL`. Do not reuse the rendezvous URL unless that address really is the same Hub.
- Confirm `GET /presence/v1/info` returns HTTP 200, and `GET /p2p/bootstrap` returns a `network: "cannoi"` descriptor. A Hub that is meant to accept inbound peer connections should advertise its own public multiaddr; reverse proxies must pass WebSocket Upgrade requests.
- P2P discovery is not the same as an established connection. Internet peers behind restrictive NAT/firewalls may still require a reachable public endpoint or relay.
