# Changes to existing behaviour, and why

You asked that everything else stay unchanged and that unavoidable changes be explained. These are *all* of them.

| # | Change | Why it was unavoidable |
|---|---|---|
| 1 | **Runtime stack**: `express`, `sqlite3`, `multer` replaced by Node built-ins (`node:http`, `node:sqlite`, `node:crypto`). Database file and tables are the same (`data/community.db`, migrated in place). | The build/test sandbox has no network, so the original dependencies could not even be installed — nothing built on them could have been run or tested. It also removes `multer@1.x` (published DoS advisories) and the native `sqlite3` build on Alpine, and gives Ed25519 + scrypt without extra packages. *Trade-off:* the HTTP layer is hand-written (≈400 lines, covered by tests) and `node:sqlite` is flagged experimental in Node 22. If you prefer Express, the route handlers port 1:1. |
| 2 | Dockerfile base `node:18-alpine` → `node:22-alpine`; non-root; `HEALTHCHECK`; `VOLUME /app/data`; `CMD ["node","server.js"]` (`npm start` still works). | `node:sqlite` needs Node ≥ 22.13. Original had no volume (data lost when the container is recreated). |
| 3 | `docker-compose.yml` (+ `solohost/`): added `hub-data` volume and optional env vars with empty defaults. Port mapping, image, labels, `PORT=8080` unchanged. | Persistence + configuration. |
| 4 | **Authentication required.** Every write needs a session; `user_id` in bodies is optional and must equal the session user (else 403). `GET /api/users`, `/api/groups*`, `/uploads/*` now need login. | Original trusted client-supplied IDs (spoofing/IDOR). |
| 5 | `POST /api/users` now needs a password and `HUB_ALLOW_REGISTRATION=true` (default off). Fresh installs are **not** seeded with demo users Alice/Bob (existing databases keep theirs as unclaimed “legacy” profiles). | “One identity per Hub” default; demo accounts without credentials would be backdoors. |
| 6 | Legacy users/groups/posts/comments/reactions are kept; legacy users get **no key** until the owner explicitly claims one at setup. | Prevents silently binding old users to a key. |
| 7 | Uploads: new files stored content-addressed (`/media/<sha256>`), 50 MB cap, type allow-list (HTML/SVG/EXE refused, previously accepted), downloads forced for non-media types. Old `/uploads/<name>` links still work (looked up via the posts table). | Stored XSS / path traversal / disk exhaustion. |
| 8 | List endpoints are bounded: group posts default 100 per request (`X-Next-Cursor` header for the next page); users list 100. Timestamps in JSON are ISO-8601 (`…Z`) instead of SQLite’s `YYYY-MM-DD HH:MM:SS`. | Unbounded responses; ambiguous time zone. |
| 9 | Error bodies are generic with a stable `code`; raw exception text no longer returned. | Information leak. |
| 10 | **UI replaced** by an X-style interface. Removed: Tailwind/Font Awesome CDNs, dicebear avatar images, “User:” dropdown (replaced by login). The old screens’ functions live on: groups list/create/join, group discussion with file attachment, Files tab, comments, likes. A duplicate footer `div.paf-made-by` (text) was dropped; the required `<img class="paf-made-by">` badge and its CSS rule are byte-identical. | CSP/security, offline/privacy (no third-party requests), and the requested new UX. |
| 11 | `package.json`: version 2.0.0, `engines.node >= 22.13`, **no dependencies**; `npm test` now runs the automated suite; the old health probe is `npm run test:health` (`test.js` unchanged). | New test suite. |
| 12 | CI workflow: runs `npm test` before building the image; image tag `0.1.0` → `2.0.0`. | Evidence before publish. |

Not changed: `/health` path and `status`/`timestamp` fields, port 8080, `made-by.png`, `config_options.yml` (kept empty — every variable in compose has an inline default), `solohost/LOGO_PROMPT.txt`. SHA-256 of every original file: `baseline-original-sha256.txt`.


## 2.2.0 (partial) — security P0 batch

### IMPLEMENTED + TESTED
- SEC-02: `/api/remote/info` requires owner; no global port from headers; no third-party IP lookup by default.
- AI-04: anonymous `/api/ai/status` returns only `{configured}`; settings/baseUrl owner-only.
- AI-01: chat sanitizes history (user/assistant only); ignores client `knowledge` / system roles / confirmedActions.
- FB-01: feedback sync/post/read require session; config does not return token/hubId secrets; app_id/version forced server-side.
- FB-02: `fb.sync` receives string anonymousId.
- FB-03: 4s timeout → 502 E_FEEDBACK_UNAVAILABLE (no 12s hang as hard failure without code).
- NET-04: intro_peer validated via validateEndpoint; bad URLs → 400, not stored.
- SEC-01: fake public_url_password / intro_hub_password no longer enforced as security theatre (API ignores; UI cleaned).
- NET-02 partial: public_url_override applied to `cfg.publicUrl` and `peers.self()` endpoint.
- UI-01: Enter sends chat message (Shift+Enter newline).

### NOT YET (remaining 2.2.0 WPs)
- Full bidirectional push federation (connect/inbox), invite codes, reach-check without third parties.
- Chunked uploads, embeds, media range proxy, knowledge manifest, full offline helper expansion.


### 2.2.0 WP1 batch (IMPLEMENTED + TESTED)
- Hello without required HUB_PUBLIC_URL (Host-derived endpoint).
- /federation/v1/connect + /federation/v1/inbox.
- announceConnect after sync; pushInbox helper.
- Tests: tests/regression-2.1.4/federation-wp1.test.js (2 pass).
Still NOT: invite codes chub1, full multi-hop NAT E2E proof, reach-check probes.


### 2.2.0 WP2 batch (IMPLEMENTED + TESTED)
- Offline helper expanded; AI daily quota; knowledge/manifest.json.
- Still PARTIAL vs full WP2: no AES key encryption at rest, no full merge deleting /api/assistant.


### 2.2.0 WP5 batch (IMPLEMENTED + TESTED)
- SSRF-safe unfurl + provider embeds in feed.
- NOT: arbitrary oEmbed hosts, TikTok iframe (link card only).


### 2.2.0 WP4 batch (IMPLEMENTED + TESTED)
- Chunked upload sessions; max still governed by MAX_UPLOAD_MB (default 50, up to 2048 in config).
- NOT: full 3 GiB default, tus protocol compatibility, client composer auto-chunk UI.


### 2.2.0 WP6 batch (IMPLEMENTED + TESTED)
- On-demand Range proxy for remote public media; local Range still via serveFile.
- NOT: multi-peer parallel range fan-out, integrity hash of partial ranges before stream.


### 2.2.0 WP7 batch (IMPLEMENTED + TESTED)
- i18n parity test; dead ai-panel.css removed.
- NOT: full CSP style audit, exhaustive dead-code removal of dual /api/assistant path.


### 2.2.0 WP8 + WP9-lite (IMPLEMENTED + TESTED)
- Knowledge/offline coverage + API journey.
- NOT: full Playwright browser E2E, multi-Hub NAT browser proof.
