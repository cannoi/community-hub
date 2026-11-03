# Deployment (Docker / Pi SoloHost)

* Internal port **8080**, `GET /health` → `{"status":"ok","timestamp":…}` (503 if the DB is unreachable). Same `docker-compose.yml` conventions as before: `127.0.0.1:18080:8080`, label `pi.ui.primary`.
* State: **one volume `hub-data` → `/app/data`** (`community.db`, `keys/`, `uploads/`, `backups/`). Back it up as a whole.
* Image: `node:22-alpine`, runs as `node` (non-root), no privileged mode, no Docker socket, no extra containers.
* `docker stop` sends SIGTERM → graceful shutdown (stop sync, close SSE, close HTTP, checkpoint + close DB).

## Reachability (important)
`127.0.0.1:18080` is reachable **only from the host**. For other Hubs/people to reach you, expose the container through an HTTPS reverse proxy or tunnel and set `HUB_PUBLIC_URL=https://your.hub.example`. Behind CGNAT/firewalls you can still *pull* from public Hubs; they cannot pull from you until a public endpoint (or a future relay) exists. Behind a proxy also set `HUB_TRUST_PROXY=true` (and `HUB_TRUST_PROXY_HOPS` if more than one proxy).

## Environment variables (all optional)
| Variable | Default | Meaning |
|---|---|---|
| `PORT` / `HOST` | 8080 / 0.0.0.0 | listen address |
| `DATA_DIR` | `./data` | database, keys, uploads |
| `UPLOAD_DIR` | `$DATA_DIR/uploads` | media store (legacy files: `$UPLOAD_DIR/legacy/`) |
| `LOG_LEVEL` | info | silent/error/warn/info/debug |
| `HUB_SETUP_TOKEN` | – | required to create the owner account (recommended when public) |
| `HUB_ALLOW_REGISTRATION` | false | allow extra local accounts (each gets its own key) |
| `HUB_KEY_PASSPHRASE` | – | derive the key-encryption key from a passphrase instead of `keys/master.key` |
| `HUB_SESSION_DAYS` | 14 | session lifetime |
| `HUB_COOKIE_SECURE` | auto | force `Secure` cookie flag |
| `HUB_TRUST_PROXY`, `HUB_TRUST_PROXY_HOPS` | false, 1 | use `X-Forwarded-*` from N proxies |
| `MAX_UPLOAD_MB` / `HUB_USER_QUOTA_MB` / `HUB_REMOTE_CACHE_MB` / `HUB_MAX_RANGE_MB` | 50 / 500 / 500 / 8 | upload cap, per-user storage, remote media cache, max bytes per Range response |
| `HUB_RL_GENERAL/WRITE/LOGIN/UPLOAD/FEDERATION/ASSISTANT` | 600/90/8/20/240/20 | requests per minute per IP |
| `HUB_FEDERATION` | true | master switch |
| `HUB_PUBLIC_URL` | – | public https URL of this Hub (also published as a signed endpoint announcement) |
| `HUB_BOOTSTRAP_PEERS` | – | comma list, several allowed; `hub1_…@https://host` pins identity |
| `HUB_FEDERATION_MODE` | open | `open` or `allowlist` (only known peers) |
| `HUB_ALLOW_PRIVATE_PEERS` | false | allow http/loopback/LAN peers (disables the SSRF guard — LAN/test only) |
| `HUB_SYNC_INTERVAL_MS`, `HUB_SYNC_BATCH`, `HUB_MAX_PEERS` | 30000, 100, 50 | sync cadence and bounds |
| `HUB_BACKOFF_BASE_MS`, `HUB_BACKOFF_MAX_MS`, `HUB_PEER_TIMEOUT_MS` | 5000, 900000, 8000 | retry policy |
| `AI_BASE_URL`, `AI_MODEL`, `AI_API_KEY`, `AI_TIMEOUT_MS` | – | optional OpenAI-compatible model (e.g. `http://ollama:11434/v1`); if unset the offline helper is used and nothing leaves the Hub |

Secrets are read from the environment at runtime; none are baked into the image or printed in logs.

## Upgrade from 0.1.x
See `INSTALL.md`. Summary: copy the old DB into the volume, start 2.0 (auto-migrates after writing a `.pre-upgrade-*.bak`), create the owner account and optionally *claim* one legacy profile. Old uploads: place them in `<volume>/uploads/legacy/` (they stay reachable at the original `/uploads/<name>` URLs, for signed-in users who may see the post). Rollback = restore the `.bak` and run the 0.1.x image (2.0 only adds columns/tables, so the old image should also read the migrated file, but that path was **not tested**).

## Backup / restore
```bash
docker compose exec app node scripts/backup.js /app/data/backups/manual   # consistent snapshot, safe while running
docker compose stop app
docker compose run --rm app node scripts/restore.js /app/data/backups/manual --force
docker compose start app
```
A backup contains the **encrypted** identity key *and* `master.key` (unless you use a passphrase) — treat it as secret. The identity can also be exported/imported through the UI (Settings → Identity). Restoring an identity on a new Hub: import during setup, connect to a peer that holds your history, wait for sync, then post.

## Moving to another endpoint
Change `HUB_PUBLIC_URL` and restart: a new signed `endpoint.announce` is published; peers re-verify and follow. Your account ID is unchanged.
