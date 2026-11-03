# Community Hub 2.0

A lightweight, self-hosted **community + federated social network** for Pi SoloHost (Docker). English / Tiếng Việt, no external services required, **zero runtime dependencies** (Node 22 built-ins only).

Một mạng xã hội cộng đồng tinh gọn, tự lưu trữ, có thể liên kết giữa các Hub. Song ngữ Anh–Việt, không bắt buộc dịch vụ bên ngoài, **không phụ thuộc thư viện ngoài**.

## What you get
- **X-like interface**: Home, Explore, Notifications, Bookmarks, Groups, Network, Assistant, Settings; responsive (bottom nav on phones), light/dark, keyboard accessible, English + Vietnamese.
- **Your identity, not your IP**: an Ed25519 key is created on first start (`hub1_…` account ID). Public posts, replies, reactions, follows, profile changes and edits/deletes are **signed events** in an append-only, hash-chained ledger.
- **Federation**: connect to other Hubs (HTTPS), pull-based sync with cursors, signed requests, endpoint verification, bounded retries with backoff, discovery from trusted peers, hash-verified media retrieval.
- **Groups, comments, reactions, file sharing** from the original app keep working (group content stays on your Hub).
- **Media**: images (lightbox), MP4/WebM video with HTTP range/seek, audio playlists, documents; content-addressed storage, quotas, magic-byte validation.
- **Assistant**: built-in offline helper that answers in the language you write (Vi/En). Optionally connect *any* OpenAI-compatible model (even a local one) for rewriting, translation and free-form answers.
- **Safe by default**: sessions + CSRF, scrypt passwords, strict CSP, rate limits, SSRF-guarded peer traffic, no third-party assets.

## Honest limits (read before relying on it)
Direct messages are **disabled** (no reviewed end-to-end encryption yet). Followers-only posts and groups are **local to your Hub**. Deletion publishes a tombstone but cannot erase copies other Hubs already hold. The ledger is **not** a blockchain/consensus system. See `docs/STATUS.md`.

## Quick start
```bash
docker compose up -d        # data lives in the "hub-data" volume (/app/data)
# open http://127.0.0.1:18080 and create the owner account
```
No Docker: `node --version` ≥ 22.13, then `npm start` (port 8080, `GET /health`).

More: `INSTALL.md`, `docs/DEPLOYMENT.md`, `docs/ARCHITECTURE.md`, `docs/FEDERATION.md`, `docs/SECURITY.md`, `docs/CHANGES_AND_DEVIATIONS.md`, `docs/STATUS.md`.

## Tests
`npm test` (unit + multi-instance integration, ~1–2 min). Browser test: `NODE_PATH=$(npm root -g) node tests/ui.e2e.js` (needs Playwright). `npm run test:health` probes a running server.
