# Architecture

```
server.js ─ createHub() (src/hub.js)             one process, zero runtime dependencies (Node ≥ 22.13)
 ├─ src/http.js        router, bounded body parsing, streaming multipart, rate limiter, Range file serving, security headers
 ├─ src/auth.js        scrypt passwords, server-side sessions (hash stored), CSRF + Origin checks, cookies
 ├─ src/keystore.js    Ed25519 keys (node:crypto), AES-256-GCM at rest, export/import, account-id derivation
 ├─ src/ledger.js      signed append-only event log: canonical form, verify, sequence/fork/gap handling, checkpoints, reindex
 ├─ src/materializer.js  deterministic views derived from events (posts, reactions, follows, profiles, tags, notifications)
 ├─ src/social.js      visibility rules, serializers, posts/feeds/search/notifications services
 ├─ src/media.js       content-addressed storage, magic-byte sniffing, quotas
 ├─ src/federation/    protocol.js (signed hello/requests) · transport.js (HTTP + SSRF guard) · peers.js (registry, sync, discovery)
 ├─ src/routes/        core · legacy (original API) · social · media · admin · federation · assistant
 ├─ src/assistant.js   offline bilingual helper + optional OpenAI-compatible client
 └─ public/            index.html · app.css · i18n.js · ui.js · app.js · views.js   (no CDN, no inline script/style)
```

## Layers (as requested)
| Layer | Where |
|---|---|
| A Social app & API | `social.js`, `routes/social.js`, `routes/legacy.js`, `public/*` |
| B Identity & authorization | `keystore.js`, `auth.js`, `routes/core.js`, `routes/admin.js` |
| C Signed event ledger | `ledger.js`, `materializer.js`, tables `events`, `actor_state`, `event_conflicts`, `ledger_gaps`, `checkpoints` |
| D Peer discovery & transport | `federation/*`, `routes/federation.js`, table `peers` |
| E Media | `media.js`, `routes/media.js`, tables `media`, `media_owners`, `post_media` |
| F Messaging & notifications | notifications implemented; **private messaging disabled** (see STATUS) |
| G Indexing, caching, recovery | indexes in `db.js`; `Ledger.reindex()`, `checkpoint()`, `verifyAll()`; `backup.js` |

## What is a signed event vs. local data
| Public, signed, federated (ledger) | Local to the Hub (never federated) |
|---|---|
| `profile.update`, `post.create` (post/reply/repost/quote), `post.edit`, `post.delete` (tombstone), `react.add/remove`, `follow.add/remove`, `endpoint.announce` | groups & group posts/files, followers-only posts, legacy comments on non-public posts, bookmarks, mutes, blocks, reports, notifications, sessions, passwords |

Mutable tables (`posts`, `reactions`, `follows`, …) are **views**; deleting them and running `reindex` rebuilds them from `events` (tested).

## Event rules (materializer)
* Only the author of a post may edit/delete it; events by others are stored (chain stays valid) but have no effect.
* `sort_ts = min(claimed created_at, local receive time)`: remote clocks cannot push content to the top of the feed. Cursors are `(sort_ts, id)`.
* Reactions are keyed by target *event id*, so they can arrive before the post.
* Deleted posts keep a tombstone row (content and media cleared); the signed original remains in the immutable ledger.

## Database
`community.db` (same path as 0.1.x). Migrations 1–4 are recorded in `schema_migrations`; migration 1 adopts the original tables unchanged; later ones only **add** columns/tables/indexes. A database from a newer version is refused. First upgrade of a legacy DB writes `community.db.pre-upgrade-<ts>.bak`.
