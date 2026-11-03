# Community Hub 2.2.0 — Status

## IMPLEMENTED + TESTED (67 automated tests)

### Security
- SEC-02: `/api/remote/info` owner-only; no global port poison; no third-party IP by default
- SEC-01: fake public URL / intro passwords removed
- AI-01: chat sanitizes history; ignores client knowledge/system roles
- AI-04: anonymous status minimal; API keys AES-256-GCM at rest
- FB-01..03: feedback requires session; app_id forced; 4s timeout; no token in config

### Federation (WP1 partial)
- Hello Host-derived endpoint without HUB_PUBLIC_URL
- `POST /federation/v1/connect`, `POST /federation/v1/inbox`
- `GET /federation/v1/whoami`, `POST /federation/v1/reach-check`
- hello `capabilities: push, reach-check, range-proxy`
- `resolvePublicUrl` single module; seed-defaults list
- intro_peer validation (NET-04)

### AI (WP2 partial)
- Quota per user/day; offline ≥40 pairs EN/VI
- Assistant 4 tabs in More (no FAB)
- Enter-to-send

### Media
- Chunked upload sessions (5 MiB)
- Unfurl SSRF-safe + YouTube/Vimeo embeds
- Range proxy for remote media

### i18n / cleanup
- EN/VI parity; dead ai-panel.css removed; dead public ai/feedback client modules removed

## PARTIAL / NOT IMPLEMENTED
- Invite codes `chub1.…`, invite-only federation mode
- Full tus uploads 3 GiB default, all MIME, UI progress
- Click-to-load embeds for all providers + CSP frame-src list
- Durable feedback outbox table
- Playwright browser E2E
- Sync policy UI (media budget)
- Dual `/api/assistant` still present as compatibility alias

Zero runtime dependencies. Internal port 8080. Host map 28090.
