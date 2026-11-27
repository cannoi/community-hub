# Operations guide

## Install (SoloHost / Docker)
`docker compose up -d` — one data volume (`hub-data` → `/app/data`), non-root user, health check, no privileged mode, no `docker.sock`. Nothing is mandatory: the user only creates an account. Open registration is OFF in the shipped compose (`HUB_ALLOW_REGISTRATION=false`) — this controls ACCOUNT sign-up, not `/p2p/register`.

## Environment variables
| Variable | Default | Purpose |
|---|---|---|
| `PORT` / `P2P_PUBLIC_PORT` / `HUB_PUBLIC_URL` | 8080 / — / — | listen port, advertised port, public URL (optional) |
| `P2P_FIXED_SEEDS` | — | comma-separated bootstrap seed URLs (HTTPS directory/seed servers) |
| `PRESENCE_SEEDS` | — | presence/directory seeds (separate responsibility from bootstrap seeds) |
| `P2P_MIN_PEERS` | — | peers wanted before the network is called healthy |
| `P2P_FEDERATED_SEARCH` | on | `0` disables network search / Global Explore |
| `P2P_INDEX_REPLICATION` / `P2P_INDEX_REPLICAS` | off / 3 | live shard replication (enable only for pilots, see ARCHITECTURE limits) |
| `HUB_HEAL_INTERVAL_MS` / `HUB_HEAL_BUDGET_MS` | 60000 / 250 | self-healing cycle period and time budget (`0` interval disables) |
| `HUB_ANTI_ENTROPY_MS` | 600000 | head comparison with sync peers |

## Resource profile
Governor tiers: weak (<1.5 GB RAM or 1 CPU) hosts no shards; medium 8; strong 32. It sheds work above 0.85 load/CPU, RSS ceiling, <512 MB free disk, or index ≥90% full. Measured (single machine, 192 MB heap cap, 3,000 posts): peak RSS ~118 MB, HTTP p95 ~88 ms, healing cycle ~225 ms, event-loop p99 lag ~59 ms (`tests/phase8-load-solohost.test.js`). Raspberry-Pi class hardware was NOT measured.

## Monitoring
`GET /api/admin/healing` (owner): aggregate state (standalone/syncing/synced/degraded/offline), peer lifecycle counts, open findings, metrics. `POST /api/admin/healing/run` runs one bounded cycle. `GET /p2p/bootstrap` shows the descriptor/peers. See NETWORK_DIAGNOSTICS.md.

## Backup / restore
`npm run backup` / `npm run restore` (SQLite + keys). Back up before every upgrade. Never copy one Hub's `data/` over another Hub's: Peer ID and account keys are identity.

## Upgrade
1. backup 2. `docker compose build` (new tag) 3. `docker compose up -d` 4. check `/api/session` and `/api/admin/healing` 5. keep the previous image tag for rollback. Migrations run automatically and are additive.

## Playbooks
- **No peers / Offline:** `GET /p2p/bootstrap` must show a public multiaddr; check `P2P_FIXED_SEEDS`; remember `address_verified=false` does not by itself block publishing. Network search degrades to local results (state `local_only`).
- **Findings open:** `/api/admin/healing` → `findings_recent`. `event_corrupt` repairs from a peer automatically; `abandoned` means no peer had a valid copy — originals are untouched, restore from backup.
- **Peer quarantined:** automatic, time-limited (1 h); content sync pauses even for trusted peers; released automatically.
- **Container unhealthy:** read the logs first; do not delete volumes. (Reported case: repeated `addr.getPeerId is not a function` from mDNS — see prompts/PROMPT_B.)
- **Index looks stale:** wait one healing cycle; or `POST /api/admin/healing/run`.
