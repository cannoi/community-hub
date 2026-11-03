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
