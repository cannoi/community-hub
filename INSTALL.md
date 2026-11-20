# Installation Guide for Community Hub

Deploy via SoloHost using the provided Docker image, `docker-compose.yml`, and `config_options.yml`.

## Upgrading from 0.1.x
1. Back up first if you can (the old container had **no volume**; its data lives inside the container).
2. If you want to keep old data, copy `/app/data/community.db` (and `/app/uploads/*`) from the old container into the new volume before first start:
   `docker cp OLD:/app/data/community.db ./community.db` → place it at `<volume>/community.db`; old uploads go to `<volume>/uploads/legacy/`.
3. Start 2.0. The database is migrated in place (a safety copy `community.db.pre-upgrade-<time>.bak` is written first). Old users appear as *unclaimed legacy profiles* — nobody receives a key automatically.
4. Open the UI and create the owner account. To keep an old profile (e.g. "Alice") choose it in **“Use an existing profile”**.

## First run
Set `HUB_SETUP_TOKEN` if the Hub is reachable from the Internet; otherwise the first visitor can create the owner account.
## Federation
Set `HUB_PUBLIC_URL=https://your.hub.example` (behind HTTPS reverse proxy/tunnel; `HUB_TRUST_PROXY=true`) so other Hubs can verify and reach you. Add peers in **Network**.
Full variable list: `docs/DEPLOYMENT.md`.

## Automatic CANNOI P2P bootstrap

The supplied Docker image enables P2P, its WebSocket gateway, and the bounded Presence directory by default. Set `P2P_ENABLED=false`, `P2P_WS_GATEWAY=false`, or `PRESENCE_SERVE=false` only if you intentionally want to disable those roles.

`PRESENCE_SEEDS` and `P2P_FIXED_SEEDS` point to the shared rendezvous server (`http://14.176.78.46:28090` by default). `HUB_PUBLIC_URL` / `PUBLIC_URL` must instead be the exact public root URL of THIS Hub. Do not copy the rendezvous server URL into every node: that causes multiple peers to advertise the same WebSocket address. Leave it empty when no public endpoint exists. A public peer address must accept WebSocket Upgrade requests on the existing HTTP port.

The shared rendezvous Hub must expose `GET /presence/v1/info` and `GET /p2p/bootstrap`, and accept `POST /presence/v1/register` and `POST /p2p/register`. `/health` alone does not verify directory or bootstrap readiness. The Dockerfile/Compose defaults enable the directory and P2P registration roles. Each Hub advertises its own Peer ID/address; the shared seed stores only expiring peer descriptors and signed presence records, not posts, media, or feeds. A dedicated seed-only container remains available through `Dockerfile.seed` if you prefer to separate directory service from the social Hub.
