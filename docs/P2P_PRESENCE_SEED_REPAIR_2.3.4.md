# P2P rendezvous and Presence seed repair — 2.3.4

## Root cause

The configured public seed at `http://14.176.78.46:28090` was running the standalone Presence seed role. That role originally exposed `/health` and `/presence/v1/*` only, while Community Hub's P2P client called `/p2p/bootstrap` and `/p2p/register`. The result was `E_NOT_FOUND` (HTTP 404) and no rendezvous peer discovery. Separately, `PRESENCE_SEEDS` defaulted to an empty list, so the Network page could enable registration without any directory to register with.

## What changed

- The standalone seed now exposes `GET /p2p/bootstrap` and `POST /p2p/register`.
- The seed stores only short-lived public peer descriptors in its own SQLite table. It does not become a libp2p peer and does not store posts, media, user accounts, or private keys.
- The descriptor reports `status: "directory"`, `peer_id: null`, and a list of registered peers. The fixed-seed provider now understands this directory-only response and never invents a dialable peer ID for the seed server.
- Peer registrations require public, dialable multiaddresses containing the matching Peer ID, a valid network label, and an expiry no more than seven days ahead. Registration is rate-limited. Actual peer identity is still authenticated by libp2p during the connection handshake.
- The built-in Presence directory defaults to `http://14.176.78.46:28090`. Set `PRESENCE_SEEDS=` explicitly to opt out.
- The registration checkbox now reflects the saved preference while the app is connecting or offline.
- Invite-code copy uses Clipboard API, then `document.execCommand('copy')`, then a manual-copy dialog as a last resort.

## Deploy the standalone seed

The VPS currently serving the Presence seed must run this updated source. Build it with `Dockerfile.seed`, or run the same project with:

```bash
PORT=8080 HOST=0.0.0.0 PRESENCE_DB=/app/data/presence.db npm run seed
```

Persist `/app/data` (or the directory containing `PRESENCE_DB`) so registered peer descriptors survive restarts. Keep the existing public port/reverse-proxy mapping to this process. No new public port is required; the two new routes use the existing HTTP port.

After deployment, verify:

- `GET http://14.176.78.46:28090/health` returns `status: "ok"` and `role: "presence-seed"`.
- `GET http://14.176.78.46:28090/p2p/bootstrap` returns HTTP 200 with `network: "cannoi"`, `status: "directory"`, and `peers` (possibly an empty array until a reachable P2P node registers).

A successful seed response proves the rendezvous API works, not that any peer is currently connected. At least one other reachable Hub must publish a public multiaddress before another Hub can discover and dial it.

## Compatibility and data safety

- Existing Presence routes and stored Presence records are unchanged.
- The seed adds one independent `p2p_peer_registry` table; existing Presence database tables are not altered.
- Peer descriptors expire automatically and are not social content.
- No user identity, posts, media, chat, AI provider configuration, Feedback Hub settings, or existing app UI flows were intentionally changed.
