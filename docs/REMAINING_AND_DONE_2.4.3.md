# 2.4.3 — Remaining items status

## Completed in this pass
- Network UI: directory card (EN/VI) when owner loads `/api/sync/status`
- Mock Worker register E2E (Hub DirectoryClient ↔ local HTTP mock) — PASS
- Cloudflare Worker AI prompt: `docs/PROMPT_CLOUDFLARE_WORKER_BOOTSTRAP.md`
- Tests: 15/15 related suite green (directory, register mock, peer-info, same-host, hardening)

## Still NOT RUN (needs owner environment)
- Live POST register to production Worker (authorization / public probe-back)
- Dual SoloHost 8181↔8182 bidirectional sync capture
- Playwright mobile Explore Network
- Root-cause log analysis of specific 8182 container on owner host

## Intentionally unchanged
- AI assistant, chat language matching, groups, ledger schema, media, auth
