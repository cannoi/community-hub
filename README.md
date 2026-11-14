# Community Hub 2.3.2

Zero-configuration CANNOI bootstrap and Feedback Hub integration, with bilingual AI product knowledge. See `docs/ZERO_CONFIG_AI_KNOWLEDGE_2.3.2.md` for integration details and limitations.

A lightweight, self-hosted **community + federated social network** for Pi SoloHost (Docker). English / Tiếng Việt. Core services use Node 22 built-ins; automatic P2P mode installs the pinned libp2p runtime stack.

Một mạng xã hội cộng đồng tinh gọn, tự lưu trữ, có thể liên kết giữa các Hub. Song ngữ Anh–Việt. Các chức năng lõi dùng Node.js; chế độ P2P tự động sử dụng bộ thư viện libp2p đã ghim phiên bản.

## What you get
- **X-like interface**: Home, Explore, Notifications, Bookmarks, Groups, Network, Assistant, Settings; responsive (bottom nav on phones), light/dark, keyboard accessible, English + Vietnamese.
- **Your identity, not your IP**: an Ed25519 key is created on first start (`hub1_…` account ID). Public posts, replies, reactions, follows, profile changes and edits/deletes are **signed events** in an append-only, hash-chained ledger.
- **Federation + automatic P2P bootstrap**: HTTPS federation plus CANNOI Peer ID discovery through the public rendezvous endpoint, WebSocket gateway on the existing app port, peer self-registration and bounded peer exchange.
- **Groups, comments, reactions, file sharing** from the original app keep working (group content stays on your Hub).
- **Media**: images (lightbox), MP4/WebM video with HTTP range/seek, audio playlists, documents; content-addressed storage, quotas, magic-byte validation.
- **Assistant**: built-in offline helper that answers in the language you write (Vi/En). Optionally connect *any* OpenAI-compatible model (even a local one) for rewriting, translation and free-form answers.
- **Safe by default**: sessions + CSRF, scrypt passwords, strict CSP, rate limits, SSRF-guarded peer traffic, no third-party assets.

## Honest limits (read before relying on it)
Direct messages are **disabled** (no reviewed end-to-end encryption yet). Followers-only posts and groups are **local to your Hub**. Deletion publishes a tombstone but cannot erase copies other Hubs already hold. The ledger is **not** a blockchain/consensus system. See `docs/STATUS.md`.

## Quick start
```bash
docker compose up -d        # data lives in the "hub-data" volume (/app/data)
# open http://127.0.0.1:28090 and create the owner account
```
No Docker: `node --version` ≥ 22.13, run `npm install`, then `npm start` (port 8080, `GET /health`).

More: `INSTALL.md`, `docs/DEPLOYMENT.md`, `docs/ARCHITECTURE.md`, `docs/FEDERATION.md`, `docs/SECURITY.md`, `docs/CHANGES_AND_DEVIATIONS.md`, `docs/STATUS.md`.

## Tests
`npm test` (unit + multi-instance integration, ~1–2 min). Browser test: `NODE_PATH=$(npm root -g) node tests/ui.e2e.js` (needs Playwright). `npm run test:health` probes a running server.
