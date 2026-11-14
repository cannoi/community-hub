# Community Hub — Presence 2.3.0 + Phase 1 Network Adapter

**Date:** 2026-11-03  
**Version:** 2.3.0  
**Scope completed:** Global Presence finished to stable 2.3.0 + Phase 1 Network Adapter Foundation.

## Decisions followed

| Item | Choice | Status |
|------|--------|--------|
| Presence | (a) Complete to stable 2.3.0 before P2P | Done |
| libp2p | (B) Phase 1 only; no libp2p install, no pure-Node DHT | Done |
| P2P port | WebSocket on 8080 when Phase 2 arrives (not yet) | Reserved |

## What was completed

### A. Global Presence → 2.3.0 stable

- Backend (already present in WIP): directory seeds, signed register/heartbeat, resolve/search, on-demand remote content, rate limits, opt-out, stand-alone seed process.
- **UI (Network page):** Presence status card with simple labels (Local only / Listed / Directory unreachable) and owner toggles for “List this Hub” and “Appear in name search”. English + Vietnamese.
- **i18n:** `presence.*` keys in EN and VI.
- **Knowledge / AI:** `knowledge/manifest.json` updated to 2.3.0 with Presence topics, notes and scenarios so the offline assistant can explain discovery in plain language.
- **Docs:** CHANGELOG.md and RELEASE_NOTES.md rewritten for 2.3.0.
- **Backup fix retained:** consistent `VACUUM INTO` snapshot (no WAL data loss).
- **Hard-coded seed removed:** `intro_peer: "default"` intentionally rejected; journey test updated.
- **Tests:** 10/10 Presence tests pass. Journey-wp9 fixed and passes. Outdated CSP assertion updated to allow known embed hosts (YouTube/Vimeo/TikTok). Reliability 8/8 pass. Federation tests pass.

### B. Phase 1 — Network Adapter Foundation

New files (independent layer; Social/Ledger do not import libp2p):

- `src/net/adapter/interface.js` — abstract surface: start/stop, connect, publish, subscribe, syncRange, status
- `src/net/adapter/https-adapter.js` — thin façade over existing PeerManager + HttpTransport
- `src/net/adapter/null-adapter.js` — no-op when networking is fully off
- `src/net/adapter/index.js` — factory (`createNetworkAdapter`)
- `tests/net-adapter.test.js` — 3 tests (all pass)

Wiring:

- `cfg.p2p.enabled` (env `P2P_ENABLED`, **default false**)
- `hub.net` created at composition root; started/stopped with the Hub
- `/api/session` exposes `network: { kind, enabled, peers, state }` (no secrets)

**Behaviour with P2P disabled (default):** identical to previous HTTPS federation + Presence. No new dependency, no port change, no SoloHost change.

## Test summary (this environment)

| Suite | Result |
|-------|--------|
| Presence (10) | 10/10 pass |
| Network adapter (3) | 3/3 pass |
| Reliability (8) | 8/8 pass |
| Federation | pass |
| Journey WP9 | pass (updated) |
| Assistant | 1/2 (pre-existing external-AI mock config mismatch; local helper works) |

Full suite command (recommended):

```bash
npm test
# = node --test --test-concurrency=1 --test-force-exit --test-timeout=60000 tests/*.test.js tests/presence/*.test.js tests/regression-2.1.4/*.test.js
```

## Not done (by design / blocked)

- Phase 2–6 (libp2p, DHT, GossipSub, NAT/relay): **blocked** until a working npm registry / pre-installed `node_modules` with compatible libp2p is available. No blind code written.
- Phase 7–10: not started.
- Docker build / SoloHost / real multi-machine / real NAT: not verified in this environment.
- External AI optional-model test still fails with current AI module config shape (pre-existing; not introduced by Presence).

## Files added / changed (high level)

**Added**

- `src/net/adapter/{interface,https-adapter,null-adapter,index}.js`
- `tests/net-adapter.test.js`
- `scripts/presence-seed.js` (from WIP)
- `src/presence/*` (from WIP)
- `tests/presence/*` (from WIP)
- `PHASE1_AND_PRESENCE_REPORT.md` (this file)

**Updated**

- `package.json` → 2.3.0, test scripts
- `src/config.js` → presence + p2p sections
- `src/hub.js` → presence + net adapter
- `src/backup.js` / `src/db.js` → VACUUM INTO snapshot
- `src/routes/core.js`, `presence.js`, federation peers/transport, social, media
- `public/views.js`, `public/i18n.js` — Presence card + strings
- `knowledge/manifest.json`
- `CHANGELOG.md`, `RELEASE_NOTES.md`
- Tests: journey-wp9, reliability CSP

## How to use Presence (operators)

```bash
# Optional directory seeds (comma-separated)
PRESENCE_SEEDS=https://seed.example.com node server.js

# This Hub also serves as a pure directory
PRESENCE_SERVE=true PORT=8090 node scripts/presence-seed.js
```

Owner UI: **Network** page → “Find people” card.

## Next step (when ready)

Phase 2 — libp2p connection, only after:

1. Confirmed ability to `npm install` / supply lockfile + modules for a Node ≥22.13-compatible libp2p stack, **or**
2. Explicit approval of a pure-Node alternative (out of original scope).

Until then the app remains a stable **2.3.0 Global Presence** release with a clean adapter boundary for future P2P.

## Rollback

Restore previous application files + a backup taken before upgrade. Schema is backward-compatible; no forced migration.
