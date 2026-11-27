# Security follow-ups (WP7) — 2.4.0

## Checklist (independent review targets)
| Topic | Status |
|-------|--------|
| Signed-record replay across networks (`network` field) | Documented; verify network id on ingest |
| Election vote replay across shards/epochs | Design note — index coordinator epochs |
| Content-type confusion on `/p2p/register` | Reject non-JSON / oversized bodies (existing maxBytes) |
| Resource limits on `/federation/v1/*` and `/p2p/*` | Rate limits present; keep reviewing |
| Query privacy (search terms visible to peers) | Optional relay-routed search behind flag — **not default** |
| Network-level DDoS | **Honest:** app rate limits do not stop infrastructure DDoS; need relay/edge protection |

## Implemented in this release pass
- Owner-only `/api/admin/metrics`
- Safer peer:discovery normalization (no `getPeerId` crash)
- chain_broken missing-predecessor fill via gap fetch (no delete)
