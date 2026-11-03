# Baseline audit — community-hub-main (before upgrade)

Checkpoint: git commit `b6a87f0` ("BASELINE") in the working copy; SHA-256 of every original file in `baseline-original-sha256.txt`.
Method: static reading of every file (the original dependencies could not be installed in the audit sandbox — no network — so the
original server was **not executed**; the regression contract below is derived from the source and re-encoded as automated tests).

## Feature inventory (what the original does)
| Area | Behaviour |
|---|---|
| Users | `GET/POST /api/users`; seeded demo users Alice, Bob; UI "User:" dropdown lets anyone act as anyone |
| Groups | `GET/POST /api/groups`, members list, `POST /api/groups/:id/join`; seeded group "Tech Enthusiasts" |
| Posts | per-group posts with optional single file (multer disk storage in `./uploads`) |
| Comments | flat comments per post |
| Reactions | one like per (post,user), toggle |
| Files | `GET /api/groups/:id/files` lists posts that have attachments |
| Health | `GET /health` → `{status:'ok', timestamp}` ; listens on `0.0.0.0:$PORT` (default 8080) |
| Storage | SQLite `./data/community.db`; uploads `./uploads` (both inside the container layer, **no volume declared**) |
| UI | single `public/index.html`, Tailwind + Font Awesome from CDNs, avatars from api.dicebear.com, `paf-made-by` badge |
| Tests | `test.js` = HTTP probe of `/health` against an already-running server |

## Findings
**Security (all confirmed by reading the code)**
1. No authentication or authorization anywhere. Every write endpoint trusts a client-supplied `user_id` (spoofing/IDOR): anyone can post, comment, react, create groups or join as any user.
2. Posting to a group does not require membership; group membership can be forged for any user.
3. Upload: filename = `Date.now()-random-<originalname>` (client-controlled part), no size limit, no type check, files served from the app origin with the sniffed type → stored XSS via uploaded `.html`/`.svg`.
4. `multer@1.x` has published DoS advisories; `sqlite3@5` needs a native build on Alpine.
5. Error responses return raw `err.message` (information leak). No security headers, no rate limiting, no body-size limits beyond Express defaults, no CSRF/cookie model (none needed because there are no sessions).
6. Frontend: `p.file_url` and `p.avatar` are injected into `innerHTML` unescaped (avatar is user-supplied through `POST /api/users`) → stored XSS / tracking pixels. Loads third-party CSS/fonts/avatars at runtime (CDN dependency, privacy leak, breaks offline).
7. Posts/comments have no length limits; `GET` list endpoints are unbounded (no pagination).

**Reliability / deployment**
8. No volume → data and uploads are lost when the container is recreated. Dockerfile runs as root, `node:18-alpine`, `npm install` (not `npm ci`), no HEALTHCHECK, no graceful shutdown (DB never closed).
9. DB has no indexes except PK/UNIQUE, no foreign keys, no migrations table; `initDb` race (`serialize` + async seed).
10. `docker-compose.yml` exposes `127.0.0.1:18080:8080` only (reachable from the host, not from the Internet) — a public endpoint needs a reverse proxy/tunnel.

**Mock/demo-only**: the "login" (user dropdown), seeded demo users and avatars.

## Regression contract (must stay true after the upgrade)
`GET /health` 200 `{status:'ok'}`; routes listed in the inventory keep their paths and JSON shapes; existing rows in `users/groups/group_members/posts/comments/reactions` survive; uploaded files remain downloadable at `/uploads/<name>`; port 8080; `npm start`; `paf-made-by` badge element preserved.
Intentional behaviour changes (security-forced) are listed in `docs/CHANGES_AND_DEVIATIONS.md`.
