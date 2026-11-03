# Security notes

## Fixed from the original (see BASELINE_AUDIT.md)
| Finding | Now |
|---|---|
| Client-supplied `user_id` trusted everywhere | identity comes from the session; mismatching `user_id` → 403 `E_USER_MISMATCH` |
| No auth/authz; anyone could join/post as anyone | login + CSRF token + Origin check; group roles; private groups; admin-only endpoints |
| Uploads: client filename on disk, no limits, served inline | content-addressed names, magic-byte allow-list (no HTML/SVG/EXE), 50 MB cap, per-user quota, `nosniff`, `Content-Security-Policy: sandbox`, forced download for non-media, access control per request |
| Stored XSS via `innerHTML` (file_url, avatar) | DOM construction only; CSP `script-src 'self'; style-src 'self'`; no third-party hosts; links limited to http(s) with `rel=noopener nofollow` |
| Third-party CDNs / dicebear avatars (privacy, offline) | removed; local icons and initials avatars |
| Raw `err.message` returned | generic error JSON with stable codes |
| No rate limits / body limits | per-IP limits (general, write, login, upload, federation, assistant), per-username login limit, 256 KiB JSON, streaming multipart caps, bounded batches, bounded SSE connections |
| multer 1.x advisories, native sqlite3 build | no third-party runtime code at all |
| Root container, no volume, no health check | non-root, volume, HEALTHCHECK, graceful shutdown |

## Key handling
* Private keys: Ed25519 PKCS#8, encrypted with AES-256-GCM (AAD = account id), `keys/keystore.json` mode 0600, dir 0700. Key-encryption key = scrypt(`HUB_KEY_PASSPHRASE`) **or**, if unset, a random `keys/master.key` (0600). The master-key mode only protects against leaking `keystore.json` alone (e.g. a stray copy); anyone with the whole volume has the key. Set `HUB_KEY_PASSPHRASE` for stronger protection (cannot be switched afterwards without migrating).
* Keys never appear in API output, logs (secret-looking tokens are redacted) or the DB (tested by scanning).
* Export requires the owner’s password again and an export passphrase (≥ 10 chars) → scrypt + AES-GCM file. Import is only offered during first-time setup; publishing is blocked (`E_HISTORY_NOT_SYNCED`) until the old chain has been synced, so a restored key cannot fork its own history.

## Identity limits — please read
* **A public IP is an endpoint, not an identity.** “One identity per Hub” is enforced by *policy* (registration closed by default), not by IP checks. NAT/CGNAT, shared and dynamic IPs, VPNs and multiple devices make IP-based “one person/one machine” guarantees impossible; none are claimed.
* Anyone can run another Hub and create another identity. Spam control relies on rate limits, block lists, allow-list federation mode and (future) community moderation.
* **Losing the key = losing the identity.** No key recovery exists by design. Back up the encrypted export. There is no key rotation/revocation yet.
* A hub operator (or anyone with the volume + passphrase) can sign as the owner: custody is local.

## Other known limitations
* First-run takeover: until the owner exists the first visitor can create it. Set `HUB_SETUP_TOKEN` on any Internet-reachable Hub.
* Rate limits are in-memory (reset on restart) and keyed by client IP (behind NAT many users share one); set `HUB_TRUST_PROXY` correctly behind a proxy or all clients look like the proxy.
* `open` federation mode lets any valid identity read public events and introduce itself as a candidate peer (bounded by `HUB_MAX_PEERS`, verified by hello). Use `allowlist` for closed communities.
* Remote timestamps are display data only; ordering never trusts them.
* Deletion = signed tombstone; copies already replicated cannot be recalled.
* `node:sqlite` is marked experimental in Node 22; the image pins Node 22.
* No HTTPS termination in the app: use a reverse proxy/tunnel. Cookies get `Secure` automatically when HTTPS is detected (`HUB_COOKIE_SECURE` to force).
* Private messaging intentionally absent (needs reviewed E2EE).
